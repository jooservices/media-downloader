// End to end: the real `serve`, the real loopback API, a real Chromium that the queue starts itself, the real
// extension, and a fake X profile served over HTTPS. Checks the whole path a user relies on:
// request -> browser opens -> photos found -> files saved -> files moved -> a second run saves nothing twice ->
// a new post is the only new download.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  apiClient,
  chromiumPath,
  createSandbox,
  destroySandbox,
  freePort,
  makePng,
  startFakeSites,
  startServe,
  waitFor
} from "./harness.mjs";

const executable = await chromiumPath();
const ACCOUNT = "e2euser";
const PROFILE_URL = `https://x.com/${ACCOUNT}/`;
const FINISHED = new Set(["complete", "incomplete", "error", "paused"]);

const post = number => ({ id: `19000000000000000${number}`, media: `photo${number}` });

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true }).catch(() => []);
  return entries
    .filter(entry => entry.isFile())
    .map(entry => path.join(entry.parentPath ?? entry.path, entry.name))
    .sort();
}

test(
  "download, move, skip duplicates and pick up only new posts",
  { skip: !executable && "no Chromium found", timeout: 420_000 },
  async t => {
    const site = { account: ACCOUNT, posts: [post(1), post(2), post(3)], requests: [] };
    const sites = await startFakeSites(site);
    const [bridgePort, apiPort] = [await freePort(), await freePort()];
    const sandbox = await createSandbox({ bridgePort, apiPort, sitesPort: sites.port, executable });
    const serve = startServe(sandbox);
    t.after(async () => {
      await destroySandbox(sandbox, serve);
      await sites.close();
    });
    const diagnostics = () => `serve output:\n${serve.output.join("")}\nsite requests:\n${site.requests.join("\n")}`;

    const token = await waitFor(
      async () => {
        const text = await readFile(path.join(sandbox.appDir, "api-token"), "utf8").catch(() => "");
        return text.trim();
      },
      { what: "the API token", timeoutMs: 30_000 }
    );
    const api = apiClient(apiPort, token);
    await waitFor(() => api.health().catch(() => null), { what: "the API", timeoutMs: 30_000 });

    await t.test("the API is closed to callers without the token and to non-JSON bodies", async () => {
      assert.equal((await api.raw("/v1/jobs")).status, 401);
      const wrongType = await api.raw("/v1/jobs", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
        body: JSON.stringify({ url: PROFILE_URL })
      });
      assert.equal(wrongType.status, 415);
      assert.equal((await api.queue("http://x.com/not-https")).status, 422);
    });

    const runJob = async (again, what) => {
      const queued = await api.queue(PROFILE_URL, again);
      assert.equal(queued.status, 201, JSON.stringify(queued.body));
      const jobId = queued.body.items[0].id;
      try {
        return await waitFor(
          async () => {
            const job = (await api.jobs()).items.find(item => item.id === jobId);
            return job && FINISHED.has(job.status) ? job : null;
          },
          { what: `${what} to finish`, timeoutMs: 240_000, everyMs: 1000 }
        );
      } catch (error) {
        throw new Error(`${error.message}\n${diagnostics()}`, { cause: error });
      }
    };

    const saved = () => listFiles(path.join(sandbox.media, "Twitter", ACCOUNT));

    await t.test("a request opens the browser, saves every photo and moves it to the download folder", async () => {
      const job = await runJob(false, "the first download");
      assert.equal(job.status, "complete", `${job.message}\n${diagnostics()}`);
      assert.equal(job.counts.started, 3);
      const files = await saved();
      assert.equal(files.length, 3, `${files.join("\n")}\n${diagnostics()}`);
      for (const number of [1, 2, 3]) {
        const match = files.find(file => file.includes(post(number).id));
        assert.ok(match, `a file for post ${number}`);
        const bytes = await readFile(match);
        assert.deepEqual(bytes, makePng(640, 480, post(number).media));
        assert.match(path.basename(match), /_640x480\.png$/, "the name ends in the real pixel size");
      }
      assert.deepEqual(await listFiles(sandbox.downloads), [], "nothing is left in the browser's own folder");
      assert.ok(
        site.requests.some(line => line.startsWith("pbs.twimg.com/media/photo1")),
        "the largest rendition was fetched"
      );
    });

    await t.test("scanning the same account again saves nothing twice", async () => {
      const before = await saved();
      const job = await runJob(true, "the second run");
      assert.equal(job.status, "complete", `${job.message}\n${diagnostics()}`);
      assert.equal(job.counts.started, 0);
      assert.ok(job.counts.skipped >= 3, `three photos are recognised as already saved (got ${job.counts.skipped})`);
      assert.deepEqual(await saved(), before);
    });

    await t.test("a new post on the account is the only new download", async () => {
      site.posts.push(post(4));
      const job = await runJob(true, "the run after a new post");
      assert.equal(job.status, "complete", `${job.message}\n${diagnostics()}`);
      assert.equal(job.counts.started, 1);
      const files = await saved();
      assert.equal(files.length, 4);
      assert.ok(files.some(file => file.includes(post(4).id)));
    });
  }
);
