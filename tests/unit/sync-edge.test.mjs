import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cliBundle, nextEdgeVersion } from "../../tools/sync-edge.mjs";

test("the Edge copy includes lib files that only the CLI loads", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  assert.ok(cliBundle(root).includes("lib/watch.js"));
});

test("each sync bumps only the patch of the copy Edge has loaded", () => {
  assert.equal(nextEdgeVersion("0.5.3"), "0.5.4");
  assert.equal(nextEdgeVersion("0.5.9"), "0.5.10");
  assert.equal(nextEdgeVersion("not-a-version"), "0.5.1");
});
