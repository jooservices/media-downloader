// The queue's jobs, in one SQLite file (queue.db) instead of one JSON file per job. Listing, filtering and
// "newest job of each link" are indexed queries, so a queue that has run for months stays as fast as a new one.
// Each job keeps its full JSON in `data`; the columns beside it exist only to be searched and sorted.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 1000;
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
  CREATE INDEX IF NOT EXISTS jobs_updated ON jobs (updated_at);
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

const BUSY_CODES = new Set(["SQLITE_BUSY", "SQLITE_LOCKED", "ERR_SQLITE_BUSY", "ERR_SQLITE_LOCKED"]);
const RETRY_DELAYS_MS = [20, 50, 100, 200];
const JOB_PAGE_SIZE = 500;

export function sqliteCall(operation) {
  for (let attempt = 0; ; attempt++) {
    try {
      return operation();
    } catch (error) {
      const busy =
        BUSY_CODES.has(error?.code) ||
        error?.errcode === 5 ||
        error?.errcode === 6 ||
        /database is (?:busy|locked)/i.test(error?.message || "");
      if (!busy || attempt >= RETRY_DELAYS_MS.length) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_DELAYS_MS[attempt]);
    }
  }
}

function backupCorruptDatabase(file, db, cause) {
  const backup = `${file}.corrupt-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.bak`;
  try {
    db?.close();
  } catch {
    // SQLite may not have finished opening the damaged file.
  }
  if (existsSync(file) && statSync(file).size > 0) {
    copyFileSync(file, backup);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${file}${suffix}`)) {
        copyFileSync(`${file}${suffix}`, `${backup}${suffix}`);
      }
    }
  }
  const backupDetail = existsSync(backup) ? `; backup saved to ${backup}` : "";
  const error = new Error(`SQLite queue database is corrupt${backupDetail}.`);
  error.cause = cause;
  throw error;
}

function database(file) {
  let db = open.get(file);
  if (!db) {
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      db = new DatabaseSync(file);
      sqliteCall(() => db.exec("PRAGMA busy_timeout = 1000;"));
      const integrity = sqliteCall(() => db.prepare("PRAGMA integrity_check").all());
      if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
        backupCorruptDatabase(file, db, new Error(integrity.map(row => row.integrity_check).join("; ")));
      }
      sqliteCall(() => db.exec(SCHEMA));
    } catch (error) {
      if (error.message.startsWith("SQLite queue database is corrupt")) {
        throw error;
      }
      if (existsSync(file) && statSync(file).size > 0 && /malformed|not a database|disk image/i.test(error.message)) {
        backupCorruptDatabase(file, db, error);
      }
      throw error;
    }
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
  sqliteCall(() => db.exec("BEGIN"));
  try {
    for (const name of readdirSync(legacyDir)) {
      const id = name.replace(/\.json$/, "");
      if (!name.endsWith(".json") || !JOB_ID.test(id)) {
        continue;
      }
      try {
        const job = JSON.parse(readFileSync(path.join(legacyDir, name), "utf8"));
        if (job?.jobId === id) {
          sqliteCall(() => save(db, job));
          imported++;
        }
      } catch {
        /* an unreadable job file is skipped, as it always was */
      }
    }
    sqliteCall(() =>
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('legacy-imported', ?)").run(new Date().toISOString())
    );
    sqliteCall(() => db.exec("COMMIT"));
  } catch (error) {
    sqliteCall(() => db.exec("ROLLBACK"));
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
      const row = sqliteCall(() => rowsOf(db, "SELECT data FROM jobs WHERE id = ?", String(jobId).toLowerCase())[0]);
      return row ? parse(row) : null;
    },
    hasUrl(url) {
      return Boolean(
        sqliteCall(() => rowsOf(db, "SELECT 1 FROM jobs WHERE url = ? COLLATE NOCASE LIMIT 1", String(url))[0])
      );
    },
    write(job) {
      sqliteCall(() => save(db, job));
      return job;
    },
    remove(jobId) {
      return sqliteCall(() => db.prepare("DELETE FROM jobs WHERE id = ?").run(String(jobId).toLowerCase()).changes > 0);
    },
    // Newest first.
    list({ status = null, limit = null, offset = 0, after = null } = {}) {
      const clauses = [];
      const params = [];
      if (status) {
        clauses.push("status = ?");
        params.push(status);
      }
      if (after) {
        clauses.push("(created_at < ? OR (created_at = ? AND id > ?))");
        params.push(after.createdAt, after.createdAt, after.jobId);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const ordering = "created_at DESC, id";
      let paging = "";
      if (limit) {
        paging = after ? "LIMIT ?" : "LIMIT ? OFFSET ?";
        params.push(limit);
        if (!after) {
          params.push(offset);
        }
      }
      return sqliteCall(() =>
        rowsOf(db, `SELECT data FROM jobs ${where} ORDER BY ${ordering} ${paging}`, ...params)
      ).map(parse);
    },
    workWindow(now = new Date().toISOString()) {
      const running = sqliteCall(() =>
        rowsOf(db, "SELECT data FROM jobs WHERE status = 'running' ORDER BY updated_at LIMIT ?", JOB_PAGE_SIZE)
      );
      const queued = sqliteCall(() =>
        rowsOf(
          db,
          `SELECT data FROM (
            SELECT data, ROW_NUMBER() OVER (PARTITION BY platform ORDER BY created_at, id) AS rank
            FROM jobs WHERE status = 'queued'
              AND (json_extract(data, '$.notBefore') IS NULL OR json_extract(data, '$.notBefore') <= ?)
              AND json_extract(data, '$.openedAt') IS NULL
          ) WHERE rank <= ?`,
          now,
          JOB_PAGE_SIZE
        )
      );
      const opened = sqliteCall(() =>
        rowsOf(
          db,
          `SELECT data FROM (
            SELECT data, ROW_NUMBER() OVER (PARTITION BY platform ORDER BY created_at, id) AS rank
            FROM jobs WHERE status = 'queued' AND json_extract(data, '$.openedAt') IS NOT NULL
          ) WHERE rank <= ?`,
          JOB_PAGE_SIZE
        )
      );
      const byId = new Map([...running, ...opened, ...queued].map(row => [JSON.parse(row.data).jobId, row]));
      return [...byId.values()].map(parse);
    },
    prune(cutoff, terminalStates) {
      const terminal = [...terminalStates];
      const placeholders = terminal.map(() => "?").join(", ");
      return sqliteCall(
        () =>
          db
            .prepare(
              `DELETE FROM jobs WHERE id IN (
              SELECT id FROM (
                SELECT id, status, updated_at,
                  ROW_NUMBER() OVER (PARTITION BY url ORDER BY created_at DESC, id ASC) AS rank
                FROM jobs
              ) WHERE rank > 1 AND status IN (${placeholders})
                AND julianday(COALESCE(NULLIF(updated_at, ''), created_at)) < julianday(?)
            )`
            )
            .run(...terminal, cutoff).changes
      );
    },
    pendingNotifications(limit = 100) {
      return sqliteCall(() =>
        rowsOf(
          db,
          `SELECT data FROM jobs WHERE status IN ('complete', 'incomplete', 'error')
            AND json_extract(data, '$.notifiedAt') IS NULL
          ORDER BY updated_at, id LIMIT ?`,
          limit
        )
      ).map(parse);
    },
    matchingJobs(platform, account, pageUrl, limit = JOB_PAGE_SIZE) {
      return sqliteCall(() =>
        rowsOf(
          db,
          `SELECT data FROM jobs WHERE status IN ('queued', 'running') AND platform = ?
            AND ((? IS NOT NULL AND url = ? COLLATE NOCASE)
              OR (? IS NULL AND json_extract(data, '$.account') = ? COLLATE NOCASE))
          ORDER BY created_at, id LIMIT ?`,
          platform,
          pageUrl ?? null,
          pageUrl,
          pageUrl ?? null,
          account,
          limit
        )
      ).map(parse);
    },
    watchHistory(urls, perUrl = 4) {
      const history = [];
      for (const url of urls) {
        const active = sqliteCall(() =>
          rowsOf(
            db,
            "SELECT data FROM jobs WHERE url = ? COLLATE NOCASE AND status IN ('queued', 'running') LIMIT 1",
            url
          )
        );
        const recentlyUpdated = sqliteCall(() =>
          rowsOf(
            db,
            "SELECT data FROM jobs WHERE url = ? COLLATE NOCASE ORDER BY updated_at DESC, id DESC LIMIT 1",
            url
          )
        );
        const recent = sqliteCall(() =>
          rowsOf(
            db,
            "SELECT data FROM jobs WHERE url = ? COLLATE NOCASE ORDER BY created_at DESC, id DESC LIMIT ?",
            url,
            perUrl
          )
        );
        const byId = new Map([...active, ...recentlyUpdated, ...recent].map(row => [JSON.parse(row.data).jobId, row]));
        history.push(...[...byId.values()].map(parse));
      }
      return history;
    },
    runningJobs(limit = JOB_PAGE_SIZE) {
      return sqliteCall(() =>
        rowsOf(db, "SELECT data FROM jobs WHERE status = 'running' ORDER BY updated_at, id LIMIT ?", limit)
      ).map(parse);
    },
    // How many jobs are in each state, for status and metrics.
    counts() {
      const result = {};
      for (const row of sqliteCall(() => rowsOf(db, "SELECT status, COUNT(*) AS n FROM jobs GROUP BY status"))) {
        result[row.status || "unknown"] = row.n;
      }
      return result;
    },
    count({ status = null } = {}) {
      const where = status ? "WHERE status = ?" : "";
      return sqliteCall(() => rowsOf(db, `SELECT COUNT(*) AS n FROM jobs ${where}`, ...(status ? [status] : [])))[0].n;
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
        sqliteCall(() => save(db, next));
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
    integrityCheck() {
      return sqliteCall(() => db.prepare("PRAGMA integrity_check").all()).map(row => row.integrity_check);
    },
    close() {
      db.close();
      open.delete(file);
    }
  };
}
