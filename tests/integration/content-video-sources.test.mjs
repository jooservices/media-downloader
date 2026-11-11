import assert from "node:assert/strict";
import test from "node:test";
import { loadPage, node, plain, settled } from "../helpers/fake-page.mjs";

const BUTTONS = 'button[aria-label], [role="button"][aria-label], button[data-testid="caret"]';

// A page with a menu that opens when a post's button is clicked and closes on Escape.
function menuPage({ url = "https://x.com/NASA/", onSend = settled(), entries = [] } = {}) {
  const page = loadPage({ url, onSend });
  const menu = { open: false, entries, role: "menu" };
  const holder = node({ querySelectorAll: () => (menu.open ? menu.entries : []) });
  page.document.querySelectorAll = selector => {
    if (selector === '[role="menuitem"]' && menu.role === "menuitem" && menu.open) {
      return menu.entries;
    }
    if (selector === `[role="${menu.role}"]` && menu.open) {
      return [holder];
    }
    return [];
  };
  page.document.dispatchEvent = event => {
    page.document.dispatched.push(event);
    if (event.key === "Escape") {
      menu.open = false;
    }
    return true;
  };
  page.menu = menu;
  return page;
}

const downloadEntry = (label = "Download video", extra = {}) =>
  node({
    innerText: label,
    getAttribute: name => (name === "aria-disabled" && extra.disabled ? "true" : null),
    ...extra
  });

function postButton(page, label = "More", attributes = {}) {
  return node({
    getAttribute: name => (name === "aria-label" ? label : (attributes[name] ?? null)),
    click() {
      this.clicked = (this.clicked || 0) + 1;
      page.menu.open = true;
    }
  });
}

function videoPost({ buttons = [], links = [], status = "/NASA/status/777" } = {}) {
  const link = status ? { href: `https://x.com${status}` } : null;
  return node({
    querySelector: selector => (selector.includes("/status/") ? link : null),
    querySelectorAll: selector => {
      if (selector === "a[href]") {
        return links.length ? links : [link].filter(Boolean);
      }
      return selector === BUTTONS ? buttons : [];
    }
  });
}

function showPosts(page, posts) {
  page.context.PageMediaDetection = {
    collectVideoContainers: () => posts.map(({ container, video }) => ({ container, video })),
    hasVisibleVideoPost: () => posts.length > 0,
    isVideoPost: () => false
  };
}

const targetMessages = page => page.sent.filter(message => message.type === "SET_NATIVE_VIDEO_TARGET");

test("a video's own menu entry is clicked after the background is told where to save it", async () => {
  const page = menuPage();
  const entry = downloadEntry();
  page.menu.entries.push(downloadEntry("Copy link"), entry);
  const button = postButton(page);
  showPosts(page, [{ container: videoPost({ buttons: [button] }), video: { videoWidth: 720, videoHeight: 1280 } }]);
  const result = await page.ns.videoSources.collectNativeVideoDownloads("Twitter", "NASA");
  assert.deepEqual(plain(result), { videoArticlesSeen: 1, videoDownloadsClicked: 1, videoDownloadsSkipped: 0 });
  assert.equal(entry.clicked, 1);
  const [target] = targetMessages(page);
  assert.deepEqual(plain(target.target), {
    platform: "Twitter",
    account: "NASA",
    key: "Twitter|video|777|1",
    filename: "video_777.mp4",
    width: 720,
    height: 1280,
    sourceUrl: "https://x.com/NASA/"
  });
});

test("a post the background already has, or refuses, is skipped and its menu closed", async () => {
  for (const answer of [{ ok: true, skip: true }, { ok: false }, undefined]) {
    const page = menuPage({ onSend: message => (message.type === "SET_NATIVE_VIDEO_TARGET" ? answer : { ok: true }) });
    const entry = downloadEntry();
    page.menu.entries.push(entry);
    showPosts(page, [{ container: videoPost({ buttons: [postButton(page)] }), video: null }]);
    const result = await page.ns.videoSources.collectNativeVideoDownloads("Twitter", "NASA");
    assert.equal(result.videoDownloadsSkipped, 1);
    assert.equal(result.videoDownloadsClicked, 0);
    assert.equal(entry.clicked, undefined);
    assert.equal(page.menu.open, false, "the menu is closed again");
    assert.deepEqual(plain(targetMessages(page)[0].target.width), 0, "a post without a loaded player has no size");
  }
});

test("a post with no menu button, or no download entry in its first two menus, is skipped", async () => {
  const page = menuPage();
  page.menu.entries.push(downloadEntry("Report"), downloadEntry("Mute", { disabled: true }));
  const first = postButton(page, "More");
  const second = postButton(page, "Actions");
  const third = postButton(page, "Options");
  showPosts(page, [
    { container: videoPost({ buttons: [] }), video: null },
    { container: videoPost({ buttons: [first, second, third], status: "/NASA/status/778" }), video: null }
  ]);
  const result = await page.ns.videoSources.collectNativeVideoDownloads("Twitter", "NASA");
  assert.deepEqual(plain(result), { videoArticlesSeen: 2, videoDownloadsClicked: 0, videoDownloadsSkipped: 2 });
  assert.equal(first.clicked, 1);
  assert.equal(second.clicked, 1);
  assert.equal(third.clicked, undefined, "only two buttons are tried per post");
  assert.equal(targetMessages(page).length, 0);
});

test("a disabled download entry is not clicked", async () => {
  const page = menuPage();
  const entry = downloadEntry("Download video", { disabled: true });
  page.menu.entries.push(entry);
  showPosts(page, [{ container: videoPost({ buttons: [postButton(page)] }), video: null }]);
  const result = await page.ns.videoSources.collectNativeVideoDownloads("Twitter", "NASA");
  assert.equal(result.videoDownloadsSkipped, 1);
  assert.equal(entry.clicked, undefined);
});

test("menus are also found as dialogs and as bare menu items, and labels come from aria-label", async () => {
  for (const role of ["dialog", "menuitem"]) {
    const page = menuPage();
    page.menu.role = role;
    const entry = node({
      innerText: "",
      textContent: "",
      getAttribute: name => (name === "aria-label" ? "  Download   Video " : null)
    });
    page.menu.entries.push(entry);
    const holder = node({ querySelectorAll: () => page.menu.entries });
    if (role === "dialog") {
      page.document.querySelectorAll = selector => (selector === '[role="dialog"]' && page.menu.open ? [holder] : []);
    }
    showPosts(page, [{ container: videoPost({ buttons: [postButton(page)] }), video: null }]);
    const result = await page.ns.videoSources.collectNativeVideoDownloads("Twitter", "NASA");
    assert.equal(result.videoDownloadsClicked, 1, role);
    assert.equal(entry.clicked, 1);
  }
});

test("only a menu that is shown counts", async () => {
  const page = menuPage();
  const hidden = node({ getClientRects: () => [], querySelectorAll: () => [downloadEntry()] });
  page.document.querySelectorAll = selector => (selector === '[role="menu"]' ? [hidden] : []);
  showPosts(page, [{ container: videoPost({ buttons: [postButton(page)] }), video: null }]);
  const result = await page.ns.videoSources.collectNativeVideoDownloads("Twitter", "NASA");
  assert.equal(result.videoDownloadsSkipped, 1);
});

test("the budget caps how many videos are clicked in one pass", async () => {
  const page = menuPage();
  page.menu.entries.push(downloadEntry());
  const posts = [1, 2, 3].map(n => ({
    container: videoPost({ buttons: [postButton(page)], status: `/NASA/status/${n}00` }),
    video: null
  }));
  showPosts(page, posts);
  const capped = await page.ns.videoSources.collectNativeVideoDownloads("Twitter", "NASA", 2);
  assert.equal(capped.videoDownloadsClicked, 2);
  assert.equal(capped.videoArticlesSeen, 3);
  const none = await page.ns.videoSources.collectNativeVideoDownloads("Twitter", "NASA", 0);
  assert.equal(none.videoDownloadsClicked, 0);
});

test("a promoted or reposted X post on a profile is skipped, a single post names its own account", async () => {
  const page = menuPage({ url: "https://x.com/home" });
  page.menu.entries.push(downloadEntry());
  const other = videoPost({ buttons: [postButton(page)], status: "/someone_else/status/5" });
  showPosts(page, [{ container: other, video: null }]);
  const result = await page.ns.videoSources.collectNativeVideoDownloads("Twitter", "NASA");
  assert.equal(result.videoDownloadsSkipped, 1);
  assert.equal(targetMessages(page).length, 0);

  page.ns.scan.state.singlePage = true;
  const single = await page.ns.videoSources.collectNativeVideoDownloads("Twitter", "NASA");
  assert.equal(single.videoDownloadsClicked, 1);
  assert.equal(page.ns.scan.state.account, "someone_else");
  assert.equal(targetMessages(page)[0].target.account, "someone_else");
});

test("a video with no post link is named after its own address, however odd", async () => {
  const names = [];
  for (const video of [
    { poster: "https://x.com/media/a.jpg?token=secret" },
    { currentSrc: "https://video.twimg.com/a.mp4" },
    { src: "http://[broken" },
    null
  ]) {
    const page = menuPage();
    page.menu.entries.push(downloadEntry());
    const container = videoPost({
      buttons: [postButton(page)],
      status: null,
      links: [{ href: "http://[bad" }, { href: "/about" }]
    });
    showPosts(page, [{ container, video }]);
    await page.ns.videoSources.collectNativeVideoDownloads("Twitter", "NASA");
    names.push(targetMessages(page)[0].target.filename);
  }
  assert.ok(
    names.every(name => /^video_media-[0-9a-z]+\.mp4$/.test(name)),
    names.join()
  );
  assert.equal(new Set(names).size, 4);
  assert.ok(!names.some(name => name.includes("secret")), "a token in an address never reaches a file name");
});

test("Instagram: a share button or a localized options button opens the menu, other buttons do not", async () => {
  const page = menuPage({ url: "https://www.instagram.com/jasondchen/" });
  page.menu.entries.push(downloadEntry("Tải xuống"));
  const container = node({
    querySelectorAll: selector => {
      if (selector === "a[href]") {
        return [{ href: "https://www.instagram.com/reel/DezPoWNzXMt/" }];
      }
      return selector === BUTTONS ? [postButton(page, "Like"), postButton(page, "Share reel")] : [];
    }
  });
  showPosts(page, [{ container, video: null }]);
  const result = await page.ns.videoSources.collectNativeVideoDownloads("Instagram", "jasondchen");
  assert.equal(result.videoDownloadsClicked, 1);
  assert.equal(targetMessages(page)[0].target.filename, "video_DezPoWNzXMt.mp4");

  const facebook = menuPage({ url: "https://www.facebook.com/someone/" });
  facebook.menu.entries.push(downloadEntry());
  showPosts(facebook, [
    {
      container: node({
        querySelectorAll: selector => (selector === BUTTONS ? [postButton(facebook, "Share reel")] : [])
      }),
      video: null
    }
  ]);
  const skipped = await facebook.ns.videoSources.collectNativeVideoDownloads("Facebook", "someone");
  assert.equal(skipped.videoDownloadsSkipped, 1, "Facebook has no share menu to try");
});

// ---- page ids ----------------------------------------------------------------------------

test("ids: a profile uses every linked post, a post page only its own id, X and TikTok match by account", () => {
  const profile = loadPage({ url: "https://www.facebook.com/lamoon.ladyofmoon/photos" });
  const links = [
    { href: "http://[broken" },
    { href: "https://www.facebook.com/photo/?fbid=11" },
    { href: "https://www.facebook.com/reel/22" },
    { href: "https://www.facebook.com/lamoon.ladyofmoon/" }
  ];
  profile.document.querySelectorAll = selector => (selector === "a[href]" ? links : []);
  assert.deepEqual(plain(profile.ns.videoSources.pageVideoIds("Facebook").sort()), ["11", "22"]);

  const many = Array.from({ length: 1100 }, (_, i) => ({ href: `https://www.facebook.com/photo/?fbid=${i + 1000}` }));
  profile.document.querySelectorAll = selector => (selector === "a[href]" ? many : []);
  assert.equal(profile.ns.videoSources.domVideoIds("Facebook").length, 1000, "the list is capped");

  const post = loadPage({ url: "https://www.instagram.com/reel/DezPoWNzXMt/" });
  post.ns.scan.state.singlePage = true;
  post.document.querySelectorAll = () => [{ href: "https://www.instagram.com/reel/Dother0001/" }];
  assert.deepEqual(plain(post.ns.videoSources.pageVideoIds("Instagram")), ["DezPoWNzXMt"]);

  const tray = loadPage({ url: "https://www.instagram.com/stories/disleft/" });
  tray.ns.scan.state.singlePage = true;
  assert.equal(tray.ns.videoSources.pageVideoIds("Instagram"), undefined, "a story tray has no single frame id");
  const frame = loadPage({ url: "https://www.instagram.com/stories/disleft/3012345678901/" });
  frame.ns.scan.state.singlePage = true;
  assert.deepEqual(plain(frame.ns.videoSources.pageVideoIds("Instagram")), ["3012345678901"]);

  assert.equal(loadPage({ url: "https://x.com/NASA/" }).ns.videoSources.pageVideoIds("Twitter"), undefined);
  assert.equal(loadPage({ url: "https://www.tiktok.com/@someone" }).ns.videoSources.pageVideoIds("TikTok"), undefined);
});

// ---- cached media ------------------------------------------------------------------------

test("the page's cached media is requested with the scan's remaining limit", async () => {
  const page = menuPage({
    url: "https://www.tiktok.com/@someone",
    onSend: settled({ DOWNLOAD_CACHED_MEDIA: () => ({ ok: true, started: 2, cached: 2 }) })
  });
  const unlimited = await page.ns.videoSources.collectPageMedia("TikTok", "someone");
  assert.equal(unlimited.videoDownloadsClicked, 2);
  const request = page.sent.find(message => message.type === "DOWNLOAD_CACHED_MEDIA");
  assert.deepEqual(plain({ ...request }), {
    type: "DOWNLOAD_CACHED_MEDIA",
    platform: "TikTok",
    account: "someone",
    limit: null
  });

  page.ns.scan.state.limit = 5;
  page.ns.scan.state.started = 1;
  await page.ns.videoSources.collectPageMedia("TikTok", "someone");
  assert.equal(page.sent.filter(message => message.type === "DOWNLOAD_CACHED_MEDIA").at(-1).limit, 4);
});

test("nothing is asked for once the limit is used up, or when a post page names no id", async () => {
  const page = menuPage({ onSend: settled({ DOWNLOAD_CACHED_MEDIA: () => ({ ok: true, started: 9, cached: 9 }) }) });
  page.ns.scan.state.limit = 1;
  page.ns.scan.state.started = 1;
  const spent = await page.ns.videoSources.collectPageMedia("Twitter", "NASA");
  assert.equal(spent.videoDownloadsClicked, 0);

  const home = menuPage({ url: "https://x.com/home" });
  home.ns.scan.state.singlePage = true;
  await home.ns.videoSources.collectPageMedia("Twitter", "NASA");
  assert.equal(
    home.sent.some(message => message.type === "DOWNLOAD_CACHED_MEDIA"),
    false
  );
  assert.equal(
    page.sent.some(message => message.type === "DOWNLOAD_CACHED_MEDIA"),
    false
  );
});

test("a background that does not answer leaves the cache request empty-handed", async () => {
  const page = menuPage({ onSend: () => Promise.reject(new Error("asleep")) });
  const result = await page.ns.videoSources.collectPageMedia("Twitter", "NASA");
  assert.deepEqual(plain(result), { videoArticlesSeen: 0, videoDownloadsClicked: 0, videoDownloadsSkipped: 0 });
});

// ---- opening grid posts ------------------------------------------------------------------

const GRID = 'a[href*="/reel/"], a[href*="/p/"]';

function gridLink(page, path, extra = {}) {
  return node({
    href: `https://www.instagram.com${path}`,
    getAttribute: name => (name === "href" ? path : null),
    click() {
      this.clicked = (this.clicked || 0) + 1;
      extra.onClick?.();
    },
    ...extra
  });
}

function gridPage({ onSend } = {}) {
  const page = loadPage({
    url: "https://www.instagram.com/jasondchen/",
    onSend: onSend || settled({ DOWNLOAD_CACHED_MEDIA: () => ({ ok: true, started: 1, cached: 1 }) })
  });
  page.links = [];
  page.document.querySelectorAll = selector => (selector === GRID ? page.links : []);
  return page;
}

test("a profile grid opens three unseen posts per pass and saves each one's cached files", async () => {
  const page = gridPage();
  page.links = ["/p/Daaa00001/", "/reel/Dbbb00002/", "/p/Dccc00003/", "/p/Dddd00004/"].map(path =>
    gridLink(page, path)
  );
  const started = await page.ns.videoSources.openGridPosts("jasondchen", 10);
  assert.deepEqual(plain(started), { started: 3, opened: 3 });
  assert.deepEqual(plain(page.links.map(link => link.clicked ?? 0)), [1, 1, 1, 0]);
  const requests = page.sent.filter(message => message.type === "DOWNLOAD_CACHED_MEDIA");
  assert.deepEqual(plain(requests.map(request => request.ids)), [["Daaa00001"], ["Dbbb00002"], ["Dccc00003"]]);
  assert.equal(requests[0].limit, 10);
  assert.ok(
    page.document.dispatched.some(event => event.key === "Escape"),
    "each post is closed again"
  );

  const next = await page.ns.videoSources.openGridPosts("jasondchen", 10);
  assert.deepEqual(plain(next), { started: 1, opened: 1 }, "only the post that was never opened is left");
  assert.deepEqual(plain(await page.ns.videoSources.openGridPosts("jasondchen", 10)), { started: 0, opened: 0 });
});

test("posts the cache already answered for, a spent budget, and a single post page open nothing", async () => {
  const page = gridPage();
  page.links = [gridLink(page, "/p/Dseen00001/")];
  assert.deepEqual(plain(await page.ns.videoSources.openGridPosts("jasondchen", 5, ["Dseen00001"])), {
    started: 0,
    opened: 0
  });
  assert.equal(page.links[0].clicked, undefined);
  assert.deepEqual(plain(await page.ns.videoSources.openGridPosts("jasondchen", 0)), { started: 0, opened: 0 });
  page.ns.scan.state.singlePage = true;
  page.links = [gridLink(page, "/p/Dnew000001/")];
  assert.deepEqual(plain(await page.ns.videoSources.openGridPosts("jasondchen", 5)), { started: 0, opened: 0 });
  assert.equal(page.links[0].clicked, undefined);
});

test("malformed cache coverage metadata does not stop the grid fallback", async () => {
  const page = gridPage();
  page.links = [gridLink(page, "/p/Dmalformed1/")];
  assert.deepEqual(plain(await page.ns.videoSources.openGridPosts("jasondchen", 3, 42)), { started: 1, opened: 1 });
  assert.equal(page.links[0].clicked, 1);
});

function cachedGridPage({ coveredIds, started = 0, skipped = 0, openedStarted = 1 } = {}) {
  let gridRequest = true;
  const page = loadPage({
    url: "https://www.instagram.com/jasondchen/",
    onSend: message => {
      if (message.type !== "DOWNLOAD_CACHED_MEDIA") {
        return { ok: true };
      }
      if (gridRequest) {
        gridRequest = false;
        return { ok: true, started, skipped, cached: started + skipped, coveredIds };
      }
      return { ok: true, started: openedStarted, cached: openedStarted ? 1 : 0 };
    }
  });
  const links = ["/p/Dgrid000001/", "/reel/Dgrid000002/"].map(path => gridLink(page, path));
  page.document.querySelectorAll = selector => (selector === GRID || selector === "a[href]" ? links : []);
  return { ...page, links };
}

test("a grid whose page data has every full-size file saves from data without opening posts", async () => {
  const page = cachedGridPage({ coveredIds: ["Dgrid000001", "Dgrid000002"], started: 2 });
  const result = await page.context.PageMediaSaver.videoSources.collectPageMedia("Instagram", "jasondchen");
  assert.deepEqual(plain(page.links.map(link => link.clicked ?? 0)), [0, 0]);
  assert.equal(result.gridSaved, 2);
  assert.equal(result.postOpened || 0, 0);
});

test("page-data downloads on a single post are not counted as grid files", async () => {
  const page = menuPage({
    url: "https://x.com/NASA/status/12345",
    onSend: settled({ DOWNLOAD_CACHED_MEDIA: () => ({ ok: true, started: 1, cached: 1 }) })
  });
  page.ns.scan.state.singlePage = true;
  const result = await page.ns.videoSources.collectPageMedia("Twitter", "NASA");
  assert.equal(result.videoDownloadsClicked, 1);
  assert.equal(result.gridSaved, undefined);
  assert.equal(result.postOpened, undefined);
});

test("Facebook photo-tab files already in page data save without opening a photo", async () => {
  const page = loadPage({
    url: "https://www.facebook.com/example/photos/",
    onSend: settled({
      DOWNLOAD_CACHED_MEDIA: () => ({ ok: true, started: 1, cached: 1, coveredIds: ["1086989087485347"] })
    })
  });
  const photoLink = {
    href: "https://www.facebook.com/photo/?fbid=1086989087485347",
    isConnected: true,
    getAttribute: () => "/photo/?fbid=1086989087485347",
    getClientRects: () => [{}],
    closest: () => null,
    click() {
      this.clicked = true;
    }
  };
  page.document.querySelectorAll = selector =>
    selector === "a[href]" || selector.includes("/photo/") ? [photoLink] : [];
  const result = await page.ns.videoSources.collectPageMedia("Facebook", "example");
  assert.equal(result.gridSaved, 1);
  assert.equal(result.videoDownloadsClicked, 1);
  assert.deepEqual(plain(page.sent.find(message => message.type === "DOWNLOAD_CACHED_MEDIA").ids), [
    "1086989087485347"
  ]);
  assert.equal(photoLink.clicked, undefined);
});

test("Facebook mixed tab data saves full-size media and opens only uncovered preview posts", async () => {
  const destinations = [
    ["1086989087485347", "/photo/?fbid=1086989087485347"],
    ["1086989087485348", "/photo/?fbid=1086989087485348"],
    ["2000000000000000001", "/reel/2000000000000000001/"]
  ];
  const ids = destinations.map(([id]) => id);
  const links = destinations.map(([, href]) => {
    return {
      href: `https://www.facebook.com${href}`,
      isConnected: true,
      getAttribute: () => href,
      getClientRects: () => [{}],
      closest: () => null,
      click() {
        this.clicked = (this.clicked || 0) + 1;
      }
    };
  });
  let first = true;
  const page = loadPage({
    url: "https://www.facebook.com/example/photos/",
    onSend: message => {
      if (message.type !== "DOWNLOAD_CACHED_MEDIA") {
        return { ok: true };
      }
      if (first) {
        first = false;
        return { ok: true, started: 1, cached: 1, coveredIds: [ids[0]] };
      }
      if (message.ids?.[0] === ids[1]) {
        return { ok: true, started: 2, cached: 2 };
      }
      return { ok: true, started: 0, cached: 0 };
    }
  });
  page.document.querySelectorAll = selector =>
    selector === "a[href]" || selector.includes("/photo/") || selector.includes("/reel/") ? links : [];

  const result = await page.ns.videoSources.collectPageMedia("Facebook", "example");
  assert.deepEqual(plain(links.map(link => link.clicked || 0)), [0, 1, 1]);
  assert.equal(result.videoDownloadsClicked, 3, "one grid file and two files from the opened carousel");
  assert.equal(result.gridSaved, 1);
  assert.equal(result.postOpened, 2, "the opened post with no cached file still counts");
});

test("Facebook video tabs open uncovered watch links", async () => {
  const link = {
    href: "https://www.facebook.com/watch/?v=2000000000000000002",
    isConnected: true,
    getAttribute: () => "/watch/?v=2000000000000000002",
    getClientRects: () => [{}],
    closest: () => null,
    click() {
      this.clicked = (this.clicked || 0) + 1;
    }
  };
  let first = true;
  const page = loadPage({
    url: "https://www.facebook.com/example/videos/",
    onSend: message => {
      if (message.type !== "DOWNLOAD_CACHED_MEDIA") {
        return { ok: true };
      }
      if (first) {
        first = false;
        return { ok: true, started: 0, cached: 0, coveredIds: [] };
      }
      return { ok: true, started: 1, cached: 1 };
    }
  });
  page.document.querySelectorAll = selector => (selector === "a[href]" || selector.includes("/watch/") ? [link] : []);

  const result = await page.ns.videoSources.collectPageMedia("Facebook", "example");
  assert.equal(link.clicked, 1);
  assert.equal(result.videoDownloadsClicked, 1);
  assert.equal(result.postOpened, 1);
});

test("a grid with thumbnail-only items opens posts and keeps the existing per-pass cap", async () => {
  const page = cachedGridPage({ coveredIds: [], openedStarted: 1 });
  const result = await page.context.PageMediaSaver.videoSources.collectPageMedia("Instagram", "jasondchen");
  assert.deepEqual(plain(page.links.map(link => link.clicked ?? 0)), [1, 1]);
  assert.equal(result.gridSaved || 0, 0);
  assert.equal(result.postOpened, 2);
});

test("a mixed grid opens only posts without full-size files already in page data", async () => {
  const page = cachedGridPage({ coveredIds: ["Dgrid000001"], started: 1, openedStarted: 1 });
  const result = await page.context.PageMediaSaver.videoSources.collectPageMedia("Instagram", "jasondchen");
  assert.deepEqual(plain(page.links.map(link => link.clicked ?? 0)), [0, 1]);
  assert.equal(result.gridSaved, 1);
  assert.equal(result.postOpened, 1);
});

test("an item already saved in the ledger is covered by page data and its post stays closed", async () => {
  const page = cachedGridPage({ coveredIds: ["Dgrid000001"], started: 0, skipped: 1 });
  const result = await page.context.PageMediaSaver.videoSources.collectPageMedia("Instagram", "jasondchen");
  assert.equal(page.links[0].clicked, undefined);
  assert.equal(result.gridSaved || 0, 0, "only newly started files count as saved from the grid");
  assert.equal(result.videoDownloadsSkipped, 1);
});

test("grid links that are hidden, inside a dialog, detached, id-less or past the stop are left alone", async () => {
  const page = gridPage({ onSend: settled({ DOWNLOAD_CACHED_MEDIA: () => ({ ok: true, started: 1, cached: 1 }) }) });
  page.links = [
    gridLink(page, "/p/Dhidden0001/", { getClientRects: () => [] }),
    gridLink(page, "/p/Ddialog0001/", { closest: () => ({}) }),
    gridLink(page, "/explore/tags/", {}),
    gridLink(page, "/p/Dgood000001/"),
    gridLink(page, "/p/Ddetached01/", { isConnected: false }),
    gridLink(page, "/p/Dafter00001/")
  ];
  assert.deepEqual(plain(await page.ns.videoSources.openGridPosts("jasondchen", 10)), { started: 1, opened: 1 });
  assert.deepEqual(plain(page.links.map(link => link.clicked ?? 0)), [0, 0, 0, 1, 0, 0]);

  const stopped = gridPage();
  stopped.links = [gridLink(stopped, "/p/Dstopped001/")];
  stopped.ns.scan.requestStop();
  assert.deepEqual(plain(await stopped.ns.videoSources.openGridPosts("jasondchen", 10)), { started: 0, opened: 0 });
  assert.equal(stopped.links[0].clicked, undefined);
});

test("opening a post waits for its data a few times, then gives up on it", async () => {
  let asked = 0;
  const page = gridPage({
    onSend: settled({
      DOWNLOAD_CACHED_MEDIA: () => {
        asked++;
        return asked < 3 ? { ok: true, started: 0, cached: 0 } : { ok: true, started: 2, cached: 1 };
      }
    })
  });
  page.links = [gridLink(page, "/p/Dslow000001/")];
  assert.deepEqual(plain(await page.ns.videoSources.openGridPosts("jasondchen", Infinity)), { started: 2, opened: 1 });
  assert.equal(asked, 3);
  assert.equal(page.sent.find(message => message.type === "DOWNLOAD_CACHED_MEDIA").limit, null);

  const never = gridPage({ onSend: () => Promise.reject(new Error("asleep")) });
  never.links = [gridLink(never, "/p/Dnever00001/")];
  assert.deepEqual(plain(await never.ns.videoSources.openGridPosts("jasondchen", 3)), { started: 0, opened: 1 });
  assert.equal(never.sent.filter(message => message.type === "DOWNLOAD_CACHED_MEDIA").length, 5, "five attempts");

  const empty = gridPage({ onSend: settled({ DOWNLOAD_CACHED_MEDIA: () => ({ ok: true, cached: 1 }) }) });
  empty.links = [gridLink(empty, "/p/Dnostart001/")];
  assert.deepEqual(
    plain(await empty.ns.videoSources.openGridPosts("jasondchen", 3)),
    { started: 0, opened: 1 },
    "cached files that all started earlier still count as opened"
  );
});

test("a post that changed the address is left with the overlay's close button, then history", async () => {
  const page = gridPage();
  const link = gridLink(page, "/p/Dnav0000001/", {
    onClick: () => {
      page.context.location = new URL("https://www.instagram.com/p/Dnav0000001/");
    }
  });
  page.links = [link];
  const closeButton = node();
  page.document.querySelector = selector =>
    selector === '[role="dialog"] svg[aria-label="Close"]' ? { closest: () => closeButton } : null;
  await page.ns.videoSources.openGridPosts("jasondchen", 3);
  assert.equal(closeButton.clicked, 1);
  assert.equal(page.history.backed, 1);
  assert.equal(page.document.dispatched.length, 0, "no Escape was needed");
});

// ---- stories -----------------------------------------------------------------------------

// Opening a tray makes one new file available: the first look afterwards saves it, later looks find nothing new.
let trayJustOpened = false;
function storyPage({ onSend } = {}) {
  const page = loadPage({
    url: "https://www.instagram.com/disleft/",
    onSend:
      onSend ||
      settled({
        DOWNLOAD_CACHED_MEDIA: () => {
          const started = trayJustOpened ? 1 : 0;
          trayJustOpened = false;
          return { ok: true, started, cached: 1 };
        }
      })
  });
  page.stories = [];
  page.highlights = [];
  page.document.querySelectorAll = selector => {
    if (selector === 'a[href*="/stories/"]') {
      return page.stories;
    }
    return selector === 'a[href*="/stories/highlights/"]' ? page.highlights : [];
  };
  return page;
}

const storyLink = (href, extra = {}) => ({
  href,
  getClientRects: () => [{}],
  click() {
    this.clicked = (this.clicked || 0) + 1;
    trayJustOpened = true;
    extra.onClick?.();
  }
});

test("stories: the account's own tray and each highlight are opened, saved and left again", async () => {
  const page = storyPage();
  page.stories = [
    storyLink("http://[broken"),
    storyLink("https://www.instagram.com/stories/someone_else/"),
    storyLink("https://www.instagram.com/stories/DISLEFT/")
  ];
  page.highlights = [
    storyLink("https://www.instagram.com/stories/highlights/1/"),
    storyLink("https://www.instagram.com/stories/highlights/2/"),
    { ...storyLink("https://www.instagram.com/stories/highlights/3/"), getClientRects: () => [] }
  ];
  assert.equal(await page.ns.videoSources.saveAccountStories("disleft"), 3);
  assert.equal(page.stories[2].clicked, 1);
  assert.equal(page.stories[1].clicked, undefined);
  assert.deepEqual(plain(page.highlights.map(link => link.clicked ?? 0)), [1, 1, 0]);
  assert.equal(await page.ns.videoSources.saveAccountStories("disleft"), 1, "only the tray is opened again");
  assert.deepEqual(plain(page.highlights.map(link => link.clicked ?? 0)), [1, 1, 0], "highlights are opened once");
});

test("stories: leaving a tray goes back in history, and a tray with nothing new is looked at twice", async () => {
  let asked = 0;
  const page = storyPage({
    onSend: settled({
      DOWNLOAD_CACHED_MEDIA: () => {
        asked++;
        return { ok: true, started: 0, cached: 0 };
      }
    })
  });
  page.stories = [
    storyLink("https://www.instagram.com/stories/disleft/", {
      onClick: () => {
        page.context.location = new URL("https://www.instagram.com/stories/disleft/3012345678901/");
      }
    })
  ];
  assert.equal(await page.ns.videoSources.saveAccountStories("disleft"), 0);
  assert.equal(asked, 2, "two looks in a row that find nothing new end it");
  assert.equal(page.history.backed, 1);
  assert.equal(page.sent.find(message => message.type === "DOWNLOAD_CACHED_MEDIA").limit, null);
});

test("stories: a spent limit, a stop request and a missing account open nothing", async () => {
  const spent = storyPage();
  spent.ns.scan.state.limit = 1;
  spent.ns.scan.state.started = 1;
  spent.stories = [storyLink("https://www.instagram.com/stories/disleft/")];
  assert.equal(await spent.ns.videoSources.saveAccountStories("disleft"), 0);
  assert.equal(spent.stories[0].clicked, undefined);

  const stopped = storyPage();
  stopped.highlights = [storyLink("https://www.instagram.com/stories/highlights/9/")];
  stopped.ns.scan.requestStop();
  assert.equal(await stopped.ns.videoSources.saveAccountStories("disleft"), 0);
  assert.equal(stopped.highlights[0].clicked, undefined);
});

test("stories: at most 40 highlights are opened, and a finite limit is passed along", async () => {
  const page = storyPage();
  page.highlights = Array.from({ length: 45 }, (_, i) =>
    storyLink(`https://www.instagram.com/stories/highlights/${i}/`)
  );
  page.ns.scan.state.limit = 100;
  await page.ns.videoSources.saveAccountStories("disleft");
  assert.equal(page.highlights.filter(link => link.clicked).length, 40);
  assert.equal(page.sent.find(message => message.type === "DOWNLOAD_CACHED_MEDIA").limit, 100);
});

test("stories: a tray keeps being looked at while new files keep turning up, up to six looks", async () => {
  let asked = 0;
  const page = storyPage({
    onSend: settled({
      DOWNLOAD_CACHED_MEDIA: () => {
        asked++;
        return { ok: true, started: 1, cached: 1 };
      }
    })
  });
  page.stories = [storyLink("https://www.instagram.com/stories/disleft/")];
  assert.equal(await page.ns.videoSources.saveAccountStories("disleft"), 6);
  assert.equal(asked, 6);
});

test("stories: files that arrive after the first look are still saved", async () => {
  const answers = [0, 2, 0, 0];
  const page = storyPage({
    onSend: settled({ DOWNLOAD_CACHED_MEDIA: () => ({ ok: true, started: answers.shift() ?? 0, cached: 1 }) })
  });
  page.stories = [storyLink("https://www.instagram.com/stories/disleft/")];
  assert.equal(await page.ns.videoSources.saveAccountStories("disleft"), 2);
});

test("cached files that were saved earlier are counted as seen (skipped), not as nothing", async () => {
  const page = loadPage({
    url: "https://x.com/disleft/",
    onSend: settled({ DOWNLOAD_CACHED_MEDIA: () => ({ ok: true, started: 0, skipped: 5, cached: 5, coveredIds: [] }) })
  });
  page.document.querySelectorAll = () => [];
  const result = await page.ns.videoSources.collectPageMedia("Twitter", "disleft");
  assert.equal(result.videoDownloadsSkipped, 5);
  assert.equal(result.videoDownloadsClicked, 0);
});
