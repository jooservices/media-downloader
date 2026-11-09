import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyAccount, verifyCommand } from "../../cli/verify.mjs";

const job = {
  jobId: "59b4b3da-b8a2-4edc-9f53-1a4de72f34da",
  platform: "Instagram",
  account: "alice",
  url: "https://www.instagram.com/alice/",
  status: "complete",
  started: 2,
  videoStarted: 1,
  attempts: 1
};
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]);

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pms-verify-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("verify reports missing, zero-byte corrupt and partial files without modifying the job store", async () => {
  await withTempDirectory(async root => {
    const directory = path.join(root, "Instagram", "alice");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "saved.jpg"), jpeg);
    await writeFile(path.join(directory, "empty.mp4"), "");
    await writeFile(path.join(directory, "wrong-header.jpg"), "not a jpeg");
    await writeFile(path.join(directory, "interrupted.jpg.crdownload"), "part");
    const result = await verifyAccount(job.url, { config: { downloadDir: root }, jobs: [job] });
    assert.deepEqual(
      [result.expected, result.files.length, result.corrupt.length, result.partial.length, result.missing],
      [3, 1, 2, 1, 2]
    );
    assert.equal(result.requeued, 0);
  });
});

test("verify repair requeues completed account jobs after finding absent output", async () => {
  await withTempDirectory(async root => {
    const writes = [];
    const result = await verifyAccount(job.url, {
      repair: true,
      config: { downloadDir: root },
      jobs: [job],
      write: async next => writes.push(next)
    });
    assert.equal(result.missing, 3);
    assert.equal(result.requeued, 1);
    assert.equal(writes[0].status, "queued");
    assert.equal(writes[0].attempts, 0);
    assert.equal(writes[0].forceRedownload, true);
    assert.match(writes[0].message, /verify --repair/);
  });
});

test("verify accepts an account page URL and finds no missing files when no completed job exists", async () => {
  await withTempDirectory(async root => {
    const directory = path.join(root, "Instagram", "alice");
    await mkdir(directory, { recursive: true });
    const result = await verifyAccount(job.url, { config: { downloadDir: root }, jobs: [] });
    assert.equal(result.expected, 0);
    assert.equal(result.missing, 0);
  });
});

test("verify walks nested account folders and checks media signatures", async () => {
  await withTempDirectory(async root => {
    const directory = path.join(root, "Instagram", "alice");
    await mkdir(path.join(directory, "archive", "2025"), { recursive: true });
    await writeFile(path.join(directory, "archive", "2025", "photo.jpg"), jpeg);
    await writeFile(path.join(directory, "archive", "2025", "bad.mp4"), "not a video");
    const result = await verifyAccount(job.url, {
      config: { downloadDir: root },
      jobs: [{ ...job, started: 1, videoStarted: 0 }]
    });
    assert.equal(result.files.length, 1);
    assert.equal(result.corrupt.length, 1);
    assert.equal(result.missing, 0);
  });
});

test("verify matches named outputs instead of unrelated files and rejects truncation after a JPEG signature", async () => {
  await withTempDirectory(async root => {
    const directory = path.join(root, "Instagram", "alice");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "unrelated.jpg"), jpeg);
    await writeFile(path.join(directory, "expected_640x480.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    await writeFile(path.join(directory, "expected-size.jpg"), jpeg);
    const outputJob = {
      ...job,
      started: 3,
      videoStarted: 0,
      outputFiles: [
        { filename: "expected_640x480.jpg", size: 6 },
        { filename: "expected-size.jpg", size: 99 },
        { filename: "missing.jpg", size: 4 }
      ]
    };
    const result = await verifyAccount(job.url, { config: { downloadDir: root }, jobs: [outputJob] });
    assert.deepEqual([result.files.length, result.missing, result.corrupt.length], [1, 1, 2]);
    assert.deepEqual(result.missingNames, ["missing.jpg"]);
  });
});

test("verify rejects malformed command arguments", async () => {
  await assert.rejects(() => verifyCommand([]), /Use: verify/);
  await assert.rejects(() => verifyCommand([job.url, "unexpected"]), /Use: verify/);
  await assert.rejects(() => verifyCommand([job.url, "--repair", "--repair"]), /Use: verify/);
});
