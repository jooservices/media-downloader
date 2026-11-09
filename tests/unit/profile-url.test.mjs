import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const manifest = JSON.parse(fs.readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"));
const context = vm.createContext({ URL });
for (const name of ["sites", "platforms", "urls"]) {
  const file = new URL(`../../lib/${name}.js`, import.meta.url);
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
  assert.equal(urls.comparableUrl("https://www.instagram.com/reels/DezPoWNzXMt/"), urls.comparableUrl(cli.url));
  assert.throws(() => urls.normalizeProfileUrl("https://www.instagram.com/reels/"), /profile URL|direct/);
});

test("accepts Facebook reels and videos profile tabs as account grids", () => {
  const reels = urls.normalizeProfileUrl("https://www.facebook.com/yunie.nguyen.1911/reels/?ref=x");
  assert.equal(reels.platform, "Facebook");
  assert.equal(reels.account, "yunie.nguyen.1911");
  assert.equal(reels.mediaPage, false);
  assert.equal(reels.url, "https://www.facebook.com/yunie.nguyen.1911/reels/");
  assert.equal(
    urls.normalizeProfileUrl("https://www.facebook.com/sample/videos").url,
    "https://www.facebook.com/sample/videos/"
  );
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

test("accepts an Instagram stories tray and one story frame", () => {
  const tray = urls.normalizeProfileUrl("https://www.instagram.com/stories/tieu_hy26/?hl=en");
  assert.equal(tray.platform, "Instagram");
  assert.equal(tray.account, "tieu_hy26");
  assert.equal(tray.mediaPage, true);
  assert.equal(tray.url, "https://www.instagram.com/stories/tieu_hy26/");
  const frame = urls.normalizeProfileUrl("https://www.instagram.com/stories/tucuynlin.031810/3345678901234567890/");
  assert.equal(frame.account, "tucuynlin.031810");
  assert.equal(frame.url, "https://www.instagram.com/stories/tucuynlin.031810/3345678901234567890/");
  assert.equal(urls.comparableUrl(frame.url), urls.comparableUrl(`${frame.url}?igsh=1`));
  assert.throws(() => urls.normalizeProfileUrl("https://www.instagram.com/stories/"), /profile URL|direct/);
});

test("a TikTok profile link is the account, and a video link is one post", () => {
  const profile = urls.normalizeProfileUrl("https://www.tiktok.com/@unnie.93newg?lang=en");
  assert.equal(profile.platform, "TikTok");
  assert.equal(profile.account, "unnie.93newg");
  assert.equal(profile.url, "https://www.tiktok.com/@unnie.93newg/");
  assert.equal(profile.mediaPage, false);
  const video = urls.normalizeProfileUrl("https://www.tiktok.com/@unnie.93newg/video/7123456789012345678/");
  assert.equal(video.mediaPage, true);
  assert.equal(video.account, "unnie.93newg");
  assert.deepEqual(JSON.parse(JSON.stringify(urls.accountPages(profile.url))), [profile.url]);
});

test("a Facebook profile link also covers its photos, reels and videos tabs", () => {
  const pages = value => JSON.parse(JSON.stringify(urls.accountPages(value)));
  assert.deepEqual(pages("https://www.facebook.com/TieuHyOfficial/?utm_source=ig"), [
    "https://www.facebook.com/TieuHyOfficial/",
    "https://www.facebook.com/TieuHyOfficial/photos/",
    "https://www.facebook.com/TieuHyOfficial/reels/",
    "https://www.facebook.com/TieuHyOfficial/videos/"
  ]);
  assert.deepEqual(pages("https://www.instagram.com/disleft/"), ["https://www.instagram.com/disleft/"]);
  assert.deepEqual(pages("https://www.facebook.com/TieuHyOfficial/photos"), [
    "https://www.facebook.com/TieuHyOfficial/photos/"
  ]);
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

test("a Facebook profile without a vanity name keeps its number, so two of them are two accounts", async () => {
  const { normalizeProfileUrl, accountPages, samePage } = (await import("node:module")).createRequire(import.meta.url)(
    "../../lib/urls.js"
  );
  const first = normalizeProfileUrl("https://www.facebook.com/profile.php?id=100012345&sk=photos&ref=x");
  assert.equal(first.url, "https://www.facebook.com/profile.php?id=100012345");
  assert.equal(first.account, "100012345");
  assert.equal(first.platform, "Facebook");
  assert.deepEqual(accountPages("https://facebook.com/profile.php?id=5"), ["https://facebook.com/profile.php?id=5"]);
  assert.equal(
    samePage("https://www.facebook.com/profile.php?id=5", "https://www.facebook.com/profile.php?id=5&sk=x"),
    true
  );
  assert.equal(
    samePage("https://www.facebook.com/profile.php?id=5", "https://www.facebook.com/profile.php?id=6"),
    false
  );
  assert.throws(() => normalizeProfileUrl("https://www.facebook.com/profile.php"), /Use an Instagram/);
  assert.throws(() => normalizeProfileUrl("https://www.facebook.com/profile.php?id=abc"), /Use an Instagram/);
});
