import assert from "node:assert/strict";
import test from "node:test";
import { image, loadPage, MEDIA, plain, settled, showArticles, SyncImage, xArticle } from "../helpers/fake-page.mjs";

const JOB = { jobId: "scan-1", url: "https://x.com/NASA/" };

function photos(count) {
  return Array.from({ length: count }, (_, i) =>
    xArticle({ status: `/NASA/status/${100 + i}`, images: [image({ src: `${MEDIA}p${i}.jpg` })] })
  );
}

// A background that accepts a photo batch once and then reports nothing new.
function onceStarted(overrides = {}) {
  let first = true;
  return settled({
    DOWNLOAD_ITEMS: message => {
      const started = first ? message.items.length : 0;
      first = false;
      return { ok: true, started, skipped: 0, failed: 0, pending: 0 };
    },
    ...overrides
  });
}

function scanPage({ url = "https://x.com/NASA/", articles = [], onSend = onceStarted(), tweak } = {}) {
  const page = loadPage({
    url,
    onSend,
    tweak: sandbox => {
      sandbox.Image = SyncImage;
      tweak?.(sandbox);
    }
  });
  showArticles(page, articles);
  return page;
}

async function start(page, job = {}, limit = null, turns = 2000) {
  const reply = await page.request({ type: "AUTO_START_CLI", job: { ...JOB, limit, ...job } });
  assert.equal(reply.ok, true, reply.error);
  return page.finish(turns);
}

test("an empty grid ends after four end checks, with nothing pending", async () => {
  const page = scanPage();
  const state = await start(page);
  assert.equal(state.running, false);
  assert.equal(state.status, "incomplete", "a page with nothing on it is not a success");
  assert.match(state.message, /No photos or videos were found on this page/);
  assert.ok(state.rounds >= 4);
  assert.equal(page.storage.autoDownloadStatus.status, "incomplete", "the final state is saved for the popup");
  assert.ok(page.sent.some(message => message.type === "AUTO_DONE"));
});

test("photos are sized, sent to the background once each pass, and counted", async () => {
  const page = scanPage({ articles: photos(2) });
  const state = await start(page);
  const download = page.sent.find(message => message.type === "DOWNLOAD_ITEMS");
  assert.deepEqual(
    plain(download.items.map(item => [item.width, item.height])),
    [
      [640, 480],
      [640, 480]
    ],
    "the real size is measured before saving"
  );
  assert.equal(state.started, 2);
  assert.equal(state.status, "complete");
  assert.match(state.message, /2 photo request\(s\)/);
});

test("the limit stops the scan as soon as it is reached and only asks for what fits", async () => {
  const page = scanPage({ articles: photos(3) });
  const state = await start(page, { jobId: "limit-1" }, 2);
  const download = page.sent.find(message => message.type === "DOWNLOAD_ITEMS");
  assert.equal(download.items.length, 2);
  assert.equal(state.status, "complete");
  assert.match(state.message, /Limit of 2 file\(s\) reached: 2 photo request\(s\)/);
});

test("a limit reached with failures left over is reported as incomplete", async () => {
  const page = scanPage({ articles: photos(1), onSend: onceStarted({ DOWNLOAD_STATUS: { pending: 0, failed: 2 } }) });
  const state = await start(page, { jobId: "limit-2" }, 1);
  assert.equal(state.status, "incomplete");
  assert.match(state.message, /2 failed/);
});

test("videos the page data started use up the limit before any photo is taken", async () => {
  const page = scanPage({
    articles: photos(2),
    onSend: settled({ DOWNLOAD_CACHED_MEDIA: () => ({ ok: true, started: 1, cached: 1 }) })
  });
  const state = await start(page, { jobId: "limit-3" }, 1);
  assert.equal(
    page.sent.some(message => message.type === "DOWNLOAD_ITEMS"),
    false
  );
  assert.equal(state.videoStarted, 1);
  assert.equal(state.status, "complete");
});

test("downloads still pending are drained, failed ones retried at most twice, then reported", async () => {
  const drains = [
    { pending: 2, failed: 0, retryable: 0 },
    { pending: 0, failed: 1, retryable: 1 }
  ];
  let retries = 0;
  const base = onceStarted();
  const page = scanPage({
    onSend: message => {
      if (message.type === "DRAIN_DOWNLOADS") {
        return drains.shift() || { pending: 0, failed: 1, retryable: 1 };
      }
      if (message.type === "RETRY_FAILED_DOWNLOADS") {
        retries++;
        return { ok: true, started: 1 };
      }
      return message.type === "DOWNLOAD_STATUS" ? { pending: 0, failed: 1, unavailable: 1 } : base(message);
    }
  });
  const state = await start(page);
  assert.equal(retries, 2, "failed downloads are retried twice and no more");
  assert.equal(state.status, "incomplete");
  assert.match(state.message, /1 failed after retries/);
});

test("a retry that fails, or starts nothing, ends the draining", async () => {
  for (const retry of [() => ({ ok: false }), () => undefined, () => ({ ok: true, started: 0 })]) {
    let calls = 0;
    const base = onceStarted();
    const page = scanPage({
      onSend: message => {
        if (message.type === "RETRY_FAILED_DOWNLOADS") {
          calls++;
          return retry();
        }
        if (message.type === "DRAIN_DOWNLOADS") {
          return { pending: 0, failed: 0, retryable: 1 };
        }
        return message.type === "DOWNLOAD_STATUS" ? undefined : base(message);
      }
    });
    const state = await start(page);
    assert.equal(calls, 1);
    assert.equal(state.status, "incomplete", "a missing final status falls back to the last known counts");
  }
});

test("files the site no longer serves are mentioned, not counted as failures", async () => {
  const page = scanPage({ onSend: settled({ DOWNLOAD_STATUS: { unavailable: 3 } }) });
  const state = await start(page);
  assert.equal(state.status, "complete");
  assert.match(state.message, /3 of them the site no longer serves/);
  assert.equal(state.unavailable, 3);
});

test("a download request the background refuses pauses the scan with its reason", async () => {
  const refused = scanPage({
    articles: photos(1),
    onSend: settled({ DOWNLOAD_ITEMS: () => ({ ok: false, error: "disk is full" }) })
  });
  const state = await start(refused);
  assert.equal(state.status, "paused");
  assert.match(state.message, /disk is full/);

  const silent = scanPage({ articles: photos(1), onSend: settled({ DOWNLOAD_ITEMS: () => ({}) }) });
  assert.match((await start(silent)).message, /The download request failed\./);
});

test("a page that stops scrolling pauses the scan instead of looping forever", async () => {
  const page = scanPage();
  page.dom.scrollHeight = 5000;
  const state = await start(page);
  assert.equal(state.status, "paused");
  assert.match(state.message, /stopped scrolling or loading photos/);
  assert.equal(state.rounds, 8);
});

test("scrolling down a long page reaches the bottom and then finishes", async () => {
  const page = scanPage();
  page.dom.scrollHeight = 3000;
  page.dom.onScroll = top => {
    page.dom.scrollTop += top;
  };
  const state = await start(page);
  assert.equal(state.status, "incomplete");
  assert.ok(state.rounds > 4, "it passed through the middle of the page first");
  assert.ok(page.dom.scrollTop > 2000);
});

test("a page that keeps growing at the bottom is scanned until it stops", async () => {
  const page = scanPage();
  let grows = 3;
  page.dom.scrollHeight = 800;
  page.dom.onScroll = top => {
    page.dom.scrollTop = Math.min(page.dom.scrollTop + top, page.dom.scrollHeight - 800);
    if (grows-- > 0) {
      page.dom.scrollHeight += 400;
    }
  };
  const state = await start(page);
  assert.equal(state.status, "incomplete");
  assert.ok(page.dom.scrollHeight >= 2000);
});

test("a stop request pauses the scan after the current pass", async () => {
  const page = scanPage({
    onSend: settled({
      DOWNLOAD_CACHED_MEDIA: () => {
        page.ns.scan.requestStop();
        return { ok: true, started: 0, cached: 0 };
      }
    })
  });
  const state = await start(page);
  assert.equal(state.status, "paused");
  assert.match(state.message, /Automatic download paused: 0 photo request\(s\)/);
  assert.equal(page.ns.scan.stopRequested, false, "the next scan starts fresh");
});

test("a scan that never ends stops at its safety limit of 10,000 passes", async () => {
  const page = scanPage();
  page.dom.scrollHeight = 1e9;
  page.dom.onScroll = top => {
    page.dom.scrollTop += top;
  };
  const state = await start(page, {}, null, 200000);
  assert.equal(state.status, "paused");
  assert.match(state.message, /safety limit of 10,000 scroll passes/);
  assert.equal(state.rounds, 10000);
});

test("losing the page mid-scan pauses it with the reason", async () => {
  const page = scanPage({
    onSend: settled({
      DOWNLOAD_CACHED_MEDIA: () => {
        page.context.location = new URL("https://example.com/");
        return { ok: true, started: 0, cached: 0 };
      }
    })
  });
  page.dom.scrollHeight = 5000;
  const state = await start(page);
  assert.equal(state.status, "paused");
  assert.match(state.message, /Open an Instagram, Facebook, X, or TikTok page first/);
});

test("repair mode downloads only the listed originals, once each, over the old copies", async () => {
  const articles = [
    xArticle({
      status: "/NASA/status/1",
      images: [
        image({ src: `${MEDIA}Abc.jpg` }),
        image({ src: `${MEDIA}other.jpg` }),
        image({ src: `${MEDIA}%E0%A4%A.jpg` })
      ]
    })
  ];
  const page = scanPage({ articles });
  const state = await start(page, { jobId: "fix-1", repairTargets: ["abc.jpg", "never-seen.jpg"] });
  const download = page.sent.find(message => message.type === "DOWNLOAD_ITEMS");
  assert.equal(download.items.length, 1);
  assert.equal(download.items[0].key, "repair:fix-1:abc.jpg");
  assert.equal(download.items[0].overwrite, true);
  assert.equal(download.items[0].repairBasename, "Abc.jpg");
  assert.equal(download.items[0].width, undefined, "repair keeps the original file untouched, no size is measured");
  assert.deepEqual(plain(state.repairFound), ["Abc.jpg"]);
  assert.equal(state.repairFiles[0].basename, "Abc.jpg");
  assert.equal(state.status, "incomplete");
  assert.match(state.message, /Repair incomplete: matched 1 of 2 source images/);
  assert.equal(
    page.sent.filter(message => message.type === "DOWNLOAD_ITEMS").length,
    1,
    "a source that was already repaired is not downloaded again"
  );
});

test("repair mode finishes normally once every listed original was matched", async () => {
  const base = onceStarted();
  const progress = [];
  const page = scanPage({
    articles: [xArticle({ images: [image({ src: `${MEDIA}Abc.jpg` })] })],
    onSend: message => {
      if (message.type === "AUTO_PROGRESS") {
        progress.push(message.state.message);
      }
      return base(message);
    }
  });
  const state = await start(page, { jobId: "fix-2", repairTargets: ["ABC.jpg"] });
  assert.equal(state.status, "complete");
  assert.equal(state.repairMode, true);
  assert.equal(state.repairFound.length, 1);
  assert.match(progress.at(-1), /Repair download running · 1\/1 source images matched/);
});

test("a single post is read once its player shows, then finishes", async () => {
  const page = scanPage({
    url: "https://x.com/NASA/status/2115779022722630042",
    articles: [xArticle({ status: "/NASA/status/2115779022722630042", images: [image({ src: `${MEDIA}one.jpg` })] })]
  });
  page.context.PageMediaDetection = {
    hasVisibleVideoPost: () => true,
    collectVideoContainers: () => [],
    isVideoPost: () => false
  };
  const state = await start(page, { url: "https://x.com/NASA/status/2115779022722630042", jobId: "post-9" });
  assert.equal(state.singlePage, true);
  assert.equal(state.status, "complete");
  assert.match(state.message, /Post scan complete: 1 photo request\(s\)/);
});

test("a single post waits at most 12 seconds for a player that never appears", async () => {
  const url = "https://x.com/NASA/status/2115779022722630042";
  const page = scanPage({ url, onSend: onceStarted({ DOWNLOAD_STATUS: { pending: 0, failed: 1 } }) });
  let checks = 0;
  page.context.PageMediaDetection = {
    hasVisibleVideoPost: () => {
      checks++;
      return false;
    },
    collectVideoContainers: () => [],
    isVideoPost: () => false
  };
  const started = page.clock.now;
  const state = await start(page, { url, jobId: "post-10" });
  assert.ok(checks > 20 && checks < 40, `polled ${checks} times`);
  assert.ok(page.clock.now - started >= 12000);
  assert.equal(state.status, "incomplete");
  assert.match(state.message, /Post scan ended with 0 pending and 1 failed/);
});

// ---- starting ----------------------------------------------------------------------------

test("a scan only starts on a supported profile or post", async () => {
  const other = scanPage({ url: "https://example.com/" });
  const refused = await other.request({ type: "AUTO_START" });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /supports Instagram, Facebook, X, and TikTok/);

  const home = scanPage({ url: "https://x.com/home" });
  const notProfile = await home.request({ type: "AUTO_START" });
  assert.equal(notProfile.ok, false);
  assert.match(notProfile.error, /Open a supported Instagram, Facebook, X, or TikTok profile/);
});

test("starting twice answers with the running scan, and refuses a different job", async () => {
  const page = scanPage();
  page.dom.scrollHeight = 5000;
  const first = await page.request({ type: "AUTO_START_CLI", job: { ...JOB, limit: null } });
  assert.equal(first.ok, true);
  const again = await page.request({ type: "AUTO_START_CLI", job: { ...JOB, limit: null } });
  assert.equal(again.ok, true);
  assert.equal(again.state.jobId, "scan-1");
  const popup = await page.request({ type: "AUTO_START" });
  assert.equal(popup.ok, true, "a start without a job id joins the running scan");
  const other = await page.request({ type: "AUTO_START_CLI", job: { ...JOB, jobId: "scan-2", limit: null } });
  assert.equal(other.ok, false);
  assert.match(other.error, /Another automatic download is already running/);
  await page.finish();
});

test("the limit is a positive whole number, otherwise there is none", async () => {
  for (const [limit, expected] of [
    [5, 5],
    [0, null],
    [-3, null],
    [2.5, null],
    ["7", null],
    [undefined, null]
  ]) {
    const page = scanPage();
    page.dom.scrollHeight = 5000;
    const reply = await page.request({ type: "AUTO_START_CLI", job: { ...JOB, limit } });
    assert.equal(reply.state.limit, expected, String(limit));
    await page.finish();
  }
  assert.equal(scanPage().ns.scan.limitRemaining(), Infinity);
});

test("a scan of an Instagram profile also saves the account's stories first", async () => {
  const page = scanPage({
    url: "https://www.instagram.com/disleft/",
    onSend: settled({ DOWNLOAD_CACHED_MEDIA: () => ({ ok: true, started: 0, cached: 0 }) })
  });
  const opened = [];
  const tray = { href: "https://www.instagram.com/stories/disleft/", click: () => opened.push("tray") };
  page.document.querySelectorAll = selector => (selector === 'a[href*="/stories/"]' ? [tray] : []);
  const state = await start(page, { url: "https://www.instagram.com/disleft/" });
  assert.deepEqual(opened, ["tray"]);
  assert.equal(state.status, "incomplete");
});

test("repairing never opens stories", async () => {
  const page = scanPage({ url: "https://www.instagram.com/disleft/" });
  const tray = {
    href: "https://www.instagram.com/stories/disleft/",
    click: () => assert.fail("a repair must not open stories")
  };
  page.document.querySelectorAll = selector => (selector === 'a[href*="/stories/"]' ? [tray] : []);
  await start(page, { url: "https://www.instagram.com/disleft/", repairTargets: ["x.jpg"] });
});

test("a grid whose photos were all saved before is a success", async () => {
  const page = scanPage({
    articles: photos(2),
    onSend: settled({ DOWNLOAD_ITEMS: () => ({ ok: true, started: 0, skipped: 2, failed: 0, pending: 0 }) })
  });
  const state = await start(page);
  assert.equal(state.status, "complete");
  assert.match(state.message, /Four end checks found no older rows/);
});
