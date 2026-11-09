import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = name => fs.readFileSync(path.join(root, name), "utf8");
const sites = require("../../lib/sites.js");

test("a site is one record: hosts, tabs and sign-in all come from that record", () => {
  const instagram = sites.get("Instagram");
  const facebook = sites.get("Facebook");
  assert.deepEqual(sites.names(), ["Instagram", "Facebook", "Twitter", "TikTok"]);
  assert.equal(sites.forHost("www.instagram.com"), instagram);
  assert.equal(instagram.classify(["reels", "AbC"], new URL("https://www.instagram.com/reels/AbC/")).kind, "post");
  assert.deepEqual(facebook.wholeAccountTabs, ["photos", "reels", "videos"]);
  assert.equal(sites.aliases().get("x"), "Twitter");
  assert.equal(sites.aliasHint(), "x, instagram, facebook or tiktok");
  assert.equal(sites.forHost("www.tiktok.com")?.name, "TikTok");
  assert.equal(
    sites.get("TikTok").classify(["@unnie.93newg"], new URL("https://www.tiktok.com/@unnie.93newg?lang=en")).account,
    "unnie.93newg"
  );
});

test("the scanners no longer grow a branch for each site", () => {
  const files = [
    "src/content/page-info.js",
    "src/content/video-sources.js",
    "src/content/collectors.js",
    "src/content/scan-runner.js",
    "lib/urls.js",
    "lib/platforms.js"
  ];
  for (const file of files) {
    assert.doesNotMatch(read(file), /platform === "(?:Instagram|Facebook|Twitter)"/, file);
  }
});
