import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The CLI keeps its files under %LOCALAPPDATA%\PageMediaSaver; point it at a temp folder.
const home = await mkdtemp(path.join(os.tmpdir(), "pms-test-"));
process.env.LOCALAPPDATA = home;
const store = await import("../../cli/store.mjs");
const { handleBridgeMessage } = await import("../../cli/bridge-server.mjs");
const { JOBS_DIR, APP_DIR } = store;

test("a job id is a UUID and nothing else", () => {
  assert.equal(store.isJobId(randomUUID()), true);
  assert.equal(store.isJobId(randomUUID().toUpperCase()), true);
  for (const bad of [
    "",
    "../../evil",
    "..\\evil",
    "a/b",
    "abc",
    null,
    undefined,
    42,
    {},
    [],
    `${randomUUID()}/..`,
    `${randomUUID()}.json`,
    `../../${randomUUID()}`,
    "x".repeat(36),
    `${randomUUID().slice(0, 35)}g`
  ]) {
    assert.equal(store.isJobId(bad), false, String(bad));
  }
});

test("a job id that is not a UUID never reaches the database", async () => {
  const id = randomUUID();
  assert.equal(await store.readJob(id), null);
  for (const bad of ["../../evil", "..%5Cevil", `${id}/../../x`, "", undefined]) {
    assert.equal(await store.readJob(bad), null, String(bad));
    assert.equal(await store.deleteJob(bad), false, String(bad));
    await assert.rejects(store.writeJob({ jobId: bad }), /Invalid job id/, String(bad));
    assert.throws(() => store.updateJob(bad, job => job), /Invalid job id/, String(bad));
  }
});

test("a bridge message cannot read or write a file outside the jobs folder", async () => {
  await mkdir(JOBS_DIR, { recursive: true });
  const outside = path.join(APP_DIR, "evil.json");
  const sentinel = JSON.stringify({ untouched: true });
  await writeFile(outside, sentinel);

  for (const jobId of ["../../evil", "..\\evil", "../../../evil", `${randomUUID()}/../../evil`]) {
    for (const type of ["JOB_PROGRESS", "JOB_DONE", "JOB_ERROR"]) {
      const result = await handleBridgeMessage(
        { type, jobId, state: { started: 99, status: "complete" }, error: "x" },
        new Set()
      );
      assert.equal(result.ok, false, `${type} ${jobId}`);
    }
  }
  assert.equal(await readFile(outside, "utf8"), sentinel, "the file outside the jobs folder is unchanged");
});

test("a real job still receives progress from the bridge", async () => {
  const jobId = randomUUID();
  await store.writeJob({ jobId, status: "running", started: 0, platform: "Twitter", account: "a" });
  const result = await handleBridgeMessage(
    { type: "JOB_PROGRESS", jobId, state: { started: 3, videoStarted: 2, message: "ok" } },
    new Set()
  );
  assert.deepEqual({ ok: result.ok, type: result.type }, { ok: true, type: "ACK" });
  const saved = await store.readJob(jobId);
  assert.equal(saved.started, 3);
  assert.equal(saved.videoStarted, 2);
});

test("the queued job file named by active-job.json must also be a UUID", async () => {
  await writeFile(store.QUEUE_FILE, JSON.stringify({ jobId: "../../evil" }));
  await assert.rejects(() => store.getActiveJob(), /Invalid job id/);
});
