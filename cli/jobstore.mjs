// The queue's jobs, in one SQLite file (queue.db) instead of one JSON file per job. Listing, filtering and
// "newest job of each link" are indexed queries, so a queue that has run for months stays as fast as a new one.
// Each job keeps its full JSON in `data`; the columns beside it exist only to be searched and sorted.
import { mkdirSync, existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL DEFAULT '',
    platform TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status);
  CREATE INDEX IF NOT EXISTS jobs_url ON jobs (url COLLATE NOCASE, created_at);
  CREATE INDEX IF NOT EXISTS jobs_created ON jobs (created_at DESC);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// node:sqlite still prints an "experimental" warning on some Node versions; that line is noise for a CLI.
async function loadSqlite() {
  const original = process.emitWarning;
  process.emitWarning = function emitWarning(warning, ...rest) {
    const text = typeof warning === "string" ? warning : warning?.message;
    if (/sqlite/i.test(String(text))) {
      return;
    }
    return original.call(this, warning, ...rest);
  };
  try {
    return await import("node:sqlite");
  } finally {
    process.emitWarning = original;
  }
}

const { DatabaseSync } = await loadSqlite();

const open = new Map();

function database(file) {
  let db = open.get(file);
  if (!db) {
    mkdirSync(path.dirname(file), { recursive: true });
    db = new DatabaseSync(file);
    db.exec(SCHEMA);
    open.set(file, db);
  }
  return db;
}

function rowsOf(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

const parse = row => JSON.parse(row.data);

function save(db, job) {
  db.prepare(
    `INSERT INTO jobs (id, url, platform, status, created_at, updated_at, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET url = excluded.url, platform = excluded.platform, status = excluded.status,
       created_at = excluded.created_at, updated_at = excluded.updated_at, data = excluded.data`
  ).run(
    job.jobId,
    String(job.url ?? ""),
    String(job.platform ?? ""),
    String(job.status ?? ""),
    String(job.createdAt ?? ""),
    String(job.updatedAt ?? ""),
    JSON.stringify(job)
  );
}

// Jobs from the old one-file-per-job layout are imported once; the old folder is kept, renamed, as a backup.
function importLegacy(db, legacyDir) {
  const done = rowsOf(db, "SELECT value FROM meta WHERE key = 'legacy-imported'")[0];
  if (done || !existsSync(legacyDir)) {
    return 0;
  }
  let imported = 0;
  db.exec("BEGIN");
  try {
    for (const name of readdirSync(legacyDir)) {
      const id = name.replace(/\.json$/, "");
      if (!name.endsWith(".json") || !JOB_ID.test(id)) {
        continue;
      }
      try {
        const job = JSON.parse(readFileSync(path.join(legacyDir, name), "utf8"));
        if (job?.jobId === id) {
          save(db, job);
          imported++;
        }
      } catch {
        /* an unreadable job file is skipped, as it always was */
      }
    }
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('legacy-imported', ?)").run(new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  try {
    renameSync(legacyDir, `${legacyDir}.imported`);
  } catch {
    /* the folder stays where it is; nothing is read from it again */
  }
  return imported;
}

// Changes to one job are applied one at a time, so two writers (the bridge answering the extension and the
// supervisor timing a job out) can never overwrite each other's update.
const locks = new Map();

export function createJobStore({ file, legacyDir = null }) {
  const db = database(file);
  if (legacyDir) {
    importLegacy(db, legacyDir);
  }
  return {
    file,
    read(jobId) {
      const row = rowsOf(db, "SELECT data FROM jobs WHERE id = ?", String(jobId).toLowerCase())[0];
      return row ? parse(row) : null;
    },
    write(job) {
      save(db, job);
      return job;
    },
    remove(jobId) {
      return db.prepare("DELETE FROM jobs WHERE id = ?").run(String(jobId).toLowerCase()).changes > 0;
    },
    // Newest first.
    list({ status = null, limit = null, offset = 0 } = {}) {
      const where = status ? "WHERE status = ?" : "";
      const paging = limit ? "LIMIT ? OFFSET ?" : "";
      const params = [...(status ? [status] : []), ...(limit ? [limit, offset] : [])];
      return rowsOf(db, `SELECT data FROM jobs ${where} ORDER BY created_at DESC, id ${paging}`, ...params).map(parse);
    },
    // How many jobs are in each state, for status and metrics.
    counts() {
      const result = {};
      for (const row of rowsOf(db, "SELECT status, COUNT(*) AS n FROM jobs GROUP BY status")) {
        result[row.status || "unknown"] = row.n;
      }
      return result;
    },
    count({ status = null } = {}) {
      const where = status ? "WHERE status = ?" : "";
      return rowsOf(db, `SELECT COUNT(*) AS n FROM jobs ${where}`, ...(status ? [status] : []))[0].n;
    },
    update(jobId, mutate) {
      const key = `${file}|${jobId}`;
      const previous = locks.get(key) || Promise.resolve();
      const run = previous.then(async () => {
        const job = this.read(jobId);
        if (!job) {
          return null;
        }
        const next = (await mutate(job)) || job;
        next.updatedAt = new Date().toISOString();
        save(db, next);
        return next;
      });
      const settled = run.then(
        () => undefined,
        () => undefined
      );
      locks.set(key, settled);
      settled.then(() => {
        if (locks.get(key) === settled) {
          locks.delete(key);
        }
      });
      return run;
    },
    close() {
      db.close();
      open.delete(file);
    }
  };
}
