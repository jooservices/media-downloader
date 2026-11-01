import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import test from "node:test";
import { brokenLinks } from "../../tools/check-doc-links.mjs";
import { createZip, extensionFiles } from "../../tools/build.mjs";
import { manifestFiles, validateManifest } from "../../tools/validate.mjs";

const manifest = {
  manifest_version: 3,
  name: "Demo",
  description: "Demo extension",
  version: "1.0.0",
  host_permissions: ["https://*.example.com/*"],
  background: { service_worker: "src/background/index.js" },
  action: { default_popup: "src/popup/popup.html" },
  content_scripts: [{ js: ["lib/a.js", "src/content/b.js"] }]
};

test("manifestFiles lists the worker, popup and content scripts once each", () => {
  assert.deepEqual(manifestFiles(manifest).sort(), [
    "lib/a.js",
    "src/background/index.js",
    "src/content/b.js",
    "src/popup/popup.html"
  ]);
});

test("validateManifest accepts a consistent manifest", () => {
  assert.deepEqual(
    validateManifest(manifest, { version: "1.0.0" }, () => true),
    []
  );
});

test("validateManifest reports version drift, missing files, wrong version and broad hosts", () => {
  const problems = validateManifest(
    { ...manifest, manifest_version: 2, host_permissions: ["<all_urls>"], description: "" },
    { version: "2.0.0" },
    file => file !== "lib/a.js"
  );
  assert.equal(problems.length, 5);
  assert.match(problems.join("\n"), /manifest_version must be 3/);
  assert.match(problems.join("\n"), /differs from package.json/);
  assert.match(problems.join("\n"), /missing "description"/);
  assert.match(problems.join("\n"), /missing file: lib\/a.js/);
  assert.match(problems.join("\n"), /too broad/);
});

test("brokenLinks ignores external links and anchors and reports missing files", () => {
  const text = "[a](https://x.dev) [b](#top) [c](mailto:a@b.dev) [d](docs/ok.md#part) [e](docs/gone.md)";
  const exists = file => file.endsWith("ok.md");
  assert.deepEqual(brokenLinks(text, "/repo/README.md", exists), ["docs/gone.md"]);
});

test("extensionFiles adds what the worker imports, relative to the worker", () => {
  const files = extensionFiles(manifest, () => 'importScripts("../../lib/c.js", "core.js");');
  assert.deepEqual(files, [
    "lib/a.js",
    "lib/c.js",
    "manifest.json",
    "src/background/core.js",
    "src/background/index.js",
    "src/content/b.js",
    "src/popup/popup.html"
  ]);
});

test("createZip writes a readable archive", () => {
  const content = Buffer.from("hello hello hello hello");
  const zip = createZip([
    { name: "a.txt", data: content },
    { name: "dir/b.txt", data: Buffer.from("b") }
  ]);
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  assert.equal(zip.readUInt16LE(end + 10), 2);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const compressedSize = zip.readUInt32LE(18);
  const nameLength = zip.readUInt16LE(26);
  assert.equal(zip.toString("utf8", 30, 30 + nameLength), "a.txt");
  const body = zip.subarray(30 + nameLength, 30 + nameLength + compressedSize);
  assert.equal(inflateRawSync(body).toString(), content.toString());
});
