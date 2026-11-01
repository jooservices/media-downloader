import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const context = vm.createContext({ URL });
for (const name of ["platforms", "urls"]) {
  const file = new URL(`../lib/${name}.js`, import.meta.url);
  new vm.Script(fs.readFileSync(file, "utf8"), { filename: file.pathname }).runInContext(context);
}
const urls = context.PageMediaLib.urls;

test("normalizes X profile URLs for automatic timeline scanning", () => {
  const result = urls.normalizeProfileUrl("https://x.com/asagi2211?ref=profile");
  assert.equal(result.platform, "Twitter");
  assert.equal(result.account, "asagi2211");
  assert.equal(result.url, "https://x.com/asagi2211/");
  assert.equal(result.mediaPage, false);
});

test("normalizes X media tabs as the account timeline", () => {
  const result = urls.normalizeProfileUrl("https://x.com/Fxtyos/media?ref=profile");
  assert.equal(result.platform, "Twitter");
  assert.equal(result.account, "Fxtyos");
  assert.equal(result.mediaPage, false);
  assert.equal(result.url, "https://x.com/Fxtyos/media/");
});

test("keeps Instagram and Facebook profile parsing intact", () => {
  const instagram = urls.normalizeProfileUrl("https://www.instagram.com/naiverosie/");
  const facebook = urls.normalizeProfileUrl("https://www.facebook.com/sample/photos");
  assert.equal(instagram.platform, "Instagram");
  assert.equal(instagram.account, "naiverosie");
  assert.equal(facebook.platform, "Facebook");
  assert.equal(facebook.account, "sample");
  assert.equal(facebook.url, "https://www.facebook.com/sample/photos/");
});

test("treats Instagram's /reels/<code> redirect as the same reel in the CLI and the extension", () => {
  const cli = urls.normalizeProfileUrl("https://www.instagram.com/reels/DezPoWNzXMt/");
  assert.equal(cli.mediaPage, true);
  assert.equal(cli.url, "https://www.instagram.com/reel/DezPoWNzXMt/");
  assert.equal(
    urls.comparableUrl("https://www.instagram.com/reels/DezPoWNzXMt/"),
    urls.comparableUrl(cli.url)
  );
  assert.throws(() => urls.normalizeProfileUrl("https://www.instagram.com/reels/"), /profile URL|direct/);
});

test("accepts Facebook reels and videos profile tabs as account grids", () => {
  const reels = urls.normalizeProfileUrl("https://www.facebook.com/yunie.nguyen.1911/reels/?ref=x");
  assert.equal(reels.platform, "Facebook");
  assert.equal(reels.account, "yunie.nguyen.1911");
  assert.equal(reels.mediaPage, false);
  assert.equal(reels.url, "https://www.facebook.com/yunie.nguyen.1911/reels/");
  assert.equal(urls.normalizeProfileUrl("https://www.facebook.com/sample/videos").url, "https://www.facebook.com/sample/videos/");
  assert.throws(() => urls.normalizeProfileUrl("https://www.facebook.com/watch/videos"), /profile URL|direct/);
});

test("normalizes direct Instagram, Facebook, and X post URLs for one-page scans", () => {
  const instagram = urls.normalizeProfileUrl("https://www.instagram.com/reel/AbC123/");
  const facebook = urls.normalizeProfileUrl("https://www.facebook.com/sample/videos/456");
  const facebookWatch = urls.normalizeProfileUrl("https://www.facebook.com/watch/?v=987654");
  const twitter = urls.normalizeProfileUrl("https://x.com/asagi2211/status/789");
  assert.equal(instagram.platform, "Instagram");
  assert.equal(instagram.account, "instagram-post");
  assert.equal(instagram.mediaPage, true);
  assert.equal(instagram.url, "https://www.instagram.com/reel/AbC123/");
  assert.equal(facebook.platform, "Facebook");
  assert.equal(facebook.account, "sample");
  assert.equal(facebook.mediaPage, true);
  assert.equal(facebook.url, "https://www.facebook.com/sample/videos/456/");
  assert.equal(facebookWatch.platform, "Facebook");
  assert.equal(facebookWatch.mediaPage, true);
  assert.equal(facebookWatch.url, "https://www.facebook.com/watch/?v=987654");
  assert.equal(twitter.platform, "Twitter");
  assert.equal(twitter.account, "asagi2211");
  assert.equal(twitter.mediaPage, true);
  assert.equal(twitter.url, "https://x.com/asagi2211/status/789/");
});

test("rejects X home and other non-profile or non-post routes", () => {
  assert.throws(() => urls.normalizeProfileUrl("https://x.com/home"), /profile URL/);
  assert.throws(() => urls.normalizeProfileUrl("https://x.com/explore"), /profile URL/);
});

test("keeps Facebook watch video IDs when the CLI and extension compare URLs", () => {
  const cliUrl = urls.normalizeProfileUrl("https://www.facebook.com/watch/?v=987654&ref=share").url;
  const bridgeUrl = urls.comparableUrl("https://www.facebook.com/watch/?v=987654&ref=share");
  assert.equal(cliUrl, "https://www.facebook.com/watch/?v=987654");
  assert.equal(bridgeUrl, "https://www.facebook.com/watch?v=987654");
});

test("declares X host access for CLI timeline scanning", () => {
  assert.ok(manifest.host_permissions.includes("https://*.x.com/*"));
  assert.ok(manifest.host_permissions.includes("https://*.twitter.com/*"));
  const scripts = manifest.content_scripts.flatMap(entry => entry.matches);
  assert.ok(scripts.includes("https://*.x.com/*"));
  assert.ok(scripts.includes("https://*.twitter.com/*"));
});
