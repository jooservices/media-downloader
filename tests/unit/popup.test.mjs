import assert from "node:assert/strict";
import test from "node:test";
import { loadPage, settle } from "../helpers/fake-dom.mjs";

const IDS = [
  "save",
  "auto-start",
  "auto-stop",
  "status",
  "bridge-status",
  "limit-count",
  "limit-unlimited",
  "open-dashboard",
  "queue-summary"
];
const SCRIPTS = [
  "lib/sites.js",
  "lib/platforms.js",
  "lib/settings.js",
  "src/options/options-strings.js",
  "src/options/options-model.js",
  "src/popup/popup.js"
];
const MANIFEST = { content_scripts: [{ js: ["lib/a.js", "src/content/index.js"] }, { js: ["other.js"] }] };
const X_TAB = { id: 5, url: "https://x.com/alice/" };

// Opens the popup against a scripted browser. `tabReplies` answers messages to the tab by type and
// `worker` answers messages to the extension by type; an Error value makes that call reject.
async function openPopup({ tab = X_TAB, storage = {}, tabReplies = {}, worker = {}, language = "en" } = {}) {
  const log = { tabMessages: [], workerMessages: [], injected: [], optionsOpened: 0 };
  const listeners = { message: [], changed: [] };
  const answer = (table, type, message) => {
    const reply = table[type];
    if (reply instanceof Error) {
      throw reply;
    }
    return typeof reply === "function" ? reply(message) : reply;
  };
  const chrome = {
    i18n: { getUILanguage: () => language },
    runtime: {
      getManifest: () => MANIFEST,
      openOptionsPage: () => {
        log.optionsOpened++;
      },
      sendMessage: async message => {
        log.workerMessages.push(message);
        return answer(worker, message.type, message);
      },
      onMessage: { addListener: listener => listeners.message.push(listener) }
    },
    storage: {
      local: {
        get: async defaults => ({ ...defaults, ...structuredClone(storage) }),
        set: async values => {
          Object.assign(storage, structuredClone(values));
        }
      },
      onChanged: { addListener: listener => listeners.changed.push(listener) }
    },
    tabs: {
      query: async () => (tab ? [tab] : []),
      sendMessage: async (id, message) => {
        log.tabMessages.push({ id, message });
        return answer(tabReplies, message.type, message);
      }
    },
    scripting: {
      executeScript: async options => {
        log.injected.push(options);
      }
    }
  };
  const page = loadPage({ ids: IDS, scripts: SCRIPTS, chrome });
  page.run();
  await settle();
  const text = id => page.elements[id].textContent;
  return { ...page, log, listeners, storage, text };
}

test("the dashboard button is labelled in the browser language and opens the dashboard, closing the popup", async () => {
  const english = await openPopup();
  assert.equal(english.text("open-dashboard"), "Open the dashboard");
  await english.elements["open-dashboard"].click();
  assert.equal(english.log.optionsOpened, 1);
  assert.equal(english.closed.count, 1);

  const vietnamese = await openPopup({ language: "vi-VN" });
  assert.equal(vietnamese.text("open-dashboard"), "Mở bảng điều khiển");
});

test("with no UI language API the page language is used", async () => {
  const page = loadPage({
    ids: IDS,
    scripts: SCRIPTS,
    navigatorLanguage: "vi",
    chrome: {
      runtime: { sendMessage: async () => null, onMessage: { addListener() {} } },
      storage: { local: { get: async defaults => defaults }, onChanged: { addListener() {} } },
      tabs: { query: async () => [], sendMessage: async () => null }
    }
  });
  page.run();
  await settle();
  assert.equal(page.elements["open-dashboard"].textContent, "Mở bảng điều khiển");
});

test("the queue summary asks to sign in first, otherwise counts the jobs, otherwise stays empty", async () => {
  const login = {
    Twitter: { label: "X", signedIn: false, signInUrl: "https://x.com/i/flow/login" },
    Instagram: { label: "Instagram", signedIn: true }
  };
  const signedOut = await openPopup({
    worker: { QUEUE_STATE: { ok: true, login, jobs: [{ platform: "Twitter", status: "queued" }] } }
  });
  assert.match(signedOut.text("queue-summary"), /Sign in to X/);

  const counted = await openPopup({
    worker: {
      QUEUE_STATE: {
        ok: true,
        login,
        jobs: [
          { platform: "Instagram", status: "running", started: 2 },
          { platform: "Instagram", status: "complete", started: 1, videoStarted: 1 }
        ]
      }
    }
  });
  assert.match(counted.text("queue-summary"), /1 running · 0 waiting · 1 done · 0 need attention · 4 files saved/);

  const empty = await openPopup({ worker: { QUEUE_STATE: { ok: true, login, jobs: [] } } });
  assert.equal(empty.text("queue-summary"), "");

  const refused = await openPopup({ worker: { QUEUE_STATE: { ok: false } } });
  assert.equal(refused.text("queue-summary"), "");

  const unreachable = await openPopup({ worker: { QUEUE_STATE: new Error("no worker") } });
  assert.equal(unreachable.text("queue-summary"), "");
});

test("the CLI bridge line shows the stored state, a default when none, and follows later changes", async () => {
  const idle = await openPopup();
  assert.equal(idle.text("bridge-status"), "CLI bridge: Waiting for an Edge profile page.");

  const known = await openPopup({ storage: { nativeBridgeState: { message: "Connected to the local CLI bridge." } } });
  assert.equal(known.text("bridge-status"), "CLI bridge: Connected to the local CLI bridge.");

  known.storage.nativeBridgeState = { message: "CLI bridge is offline." };
  known.listeners.changed[0]({ nativeBridgeState: {} }, "local");
  await settle();
  assert.equal(known.text("bridge-status"), "CLI bridge: CLI bridge is offline.");

  known.storage.nativeBridgeState = { message: "ignored" };
  known.listeners.changed[0]({ nativeBridgeState: {} }, "sync");
  known.listeners.changed[0]({ somethingElse: {} }, "local");
  await settle();
  assert.equal(known.text("bridge-status"), "CLI bridge: CLI bridge is offline.");
});

test("the scan limit loads from storage and is saved normalized when edited", async () => {
  const popup = await openPopup({ storage: { scanLimit: { limit: 25, unlimited: false } } });
  assert.equal(popup.elements["limit-count"].value, "25");
  assert.equal(popup.elements["limit-count"].disabled, false);

  popup.elements["limit-count"].value = "abc";
  await popup.elements["limit-count"].dispatch("change");
  assert.equal(popup.elements["limit-count"].value, "10", "a bad number falls back to the default");
  assert.deepEqual({ ...popup.storage.scanLimit }, { limit: 10, unlimited: false });

  popup.elements["limit-unlimited"].checked = true;
  await popup.elements["limit-unlimited"].dispatch("change");
  assert.equal(popup.elements["limit-count"].disabled, true);
  assert.deepEqual(popup.storage.scanLimit, { limit: 10, unlimited: true });

  const stored = await openPopup({ storage: { scanLimit: { limit: 3, unlimited: true } } });
  assert.equal(stored.elements["limit-unlimited"].checked, true);
  assert.equal(stored.elements["limit-count"].disabled, true);
});

test("a failing limit save is swallowed, not shown as an unhandled error", async () => {
  const popup = await openPopup();
  popup.sandbox.chrome.storage.local.set = async () => {
    throw new Error("quota");
  };
  popup.elements["limit-count"].value = "7";
  await popup.elements["limit-count"].dispatch("change");
  await popup.elements["limit-unlimited"].dispatch("change");
  assert.equal(popup.storage.scanLimit, undefined, "nothing was stored");
});

test("downloading what is loaded injects the content script, collects, and reports the batch", async () => {
  const items = [{ key: "a" }, { key: "b" }];
  const popup = await openPopup({
    tabReplies: { COLLECT_VISIBLE_MEDIA: { ok: true, items, videoDownloadsClicked: 2 } },
    worker: { DOWNLOAD_ITEMS: { ok: true, started: 1, pending: 2, failed: 3, skipped: 4 } }
  });
  await popup.elements.save.click();
  assert.deepEqual(JSON.parse(JSON.stringify(popup.log.injected)), [
    { target: { tabId: 5 }, files: ["lib/a.js", "src/content/index.js"] }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(popup.log.workerMessages.at(-1))), { type: "DOWNLOAD_ITEMS", items });
  const status = popup.text("status");
  assert.match(status, /Started 1 request\(s\); 2 pending; 3 failed; skipped 4 saved or unavailable items\./);
  assert.match(status, /Started 2 file download\(s\)/);
  assert.equal(popup.elements.save.disabled, false, "the button is usable again afterwards");
});

test("pending and failed counts default to zero in the download summary", async () => {
  const popup = await openPopup({
    tabReplies: { COLLECT_VISIBLE_MEDIA: { ok: true, items: [{}] } },
    worker: { DOWNLOAD_ITEMS: { ok: true, started: 1, skipped: 0 } }
  });
  await popup.elements.save.click();
  assert.match(popup.text("status"), /0 pending; 0 failed/);
  assert.match(popup.text("status"), /No video player is currently loaded/);
});

test("with no new photos the popup says so and mentions the video players it saw", async () => {
  const seen = await openPopup({
    tabReplies: { COLLECT_VISIBLE_MEDIA: { ok: true, items: [], videoArticlesSeen: 3 } }
  });
  await seen.elements.save.click();
  assert.match(seen.text("status"), /No new photos found\./);
  assert.match(seen.text("status"), /Checked 3 visible video player\(s\)/);
  assert.equal(
    seen.log.workerMessages.some(message => message.type === "DOWNLOAD_ITEMS"),
    false
  );
});

test("downloading shows why it could not: no page, wrong site, page error, worker error", async () => {
  const none = await openPopup({ tab: null });
  await none.elements.save.click();
  assert.equal(none.text("status"), "No active browser page was found.");

  const noUrl = await openPopup({ tab: { id: 1 } });
  await noUrl.elements.save.click();
  assert.equal(noUrl.text("status"), "No active browser page was found.");

  const other = await openPopup({ tab: { id: 1, url: "https://example.com/" } });
  await other.elements.save.click();
  assert.equal(other.text("status"), "Open an Instagram, Facebook, X, or TikTok page first.");

  const pageError = await openPopup({ tabReplies: { COLLECT_VISIBLE_MEDIA: { ok: false, error: "boom" } } });
  await pageError.elements.save.click();
  assert.equal(pageError.text("status"), "boom");

  const pageSilent = await openPopup({ tabReplies: { COLLECT_VISIBLE_MEDIA: undefined } });
  await pageSilent.elements.save.click();
  assert.equal(pageSilent.text("status"), "Could not read media from this page.");

  const workerError = await openPopup({
    tabReplies: { COLLECT_VISIBLE_MEDIA: { ok: true, items: [{}] } },
    worker: { DOWNLOAD_ITEMS: { ok: false, error: "disk full" } }
  });
  await workerError.elements.save.click();
  assert.equal(workerError.text("status"), "disk full");

  const workerSilent = await openPopup({
    tabReplies: { COLLECT_VISIBLE_MEDIA: { ok: true, items: [{}] } },
    worker: { DOWNLOAD_ITEMS: undefined }
  });
  await workerSilent.elements.save.click();
  assert.equal(workerSilent.text("status"), "The download request failed.");

  const thrown = await openPopup({ tabReplies: { COLLECT_VISIBLE_MEDIA: new Error("tab gone") } });
  await thrown.elements.save.click();
  assert.equal(thrown.text("status"), "tab gone");
  assert.equal(thrown.elements.save.disabled, false);

  const thrownString = await openPopup({ tabReplies: { COLLECT_VISIBLE_MEDIA: () => Promise.reject("plain") } });
  await thrownString.elements.save.click();
  assert.equal(thrownString.text("status"), "plain");
});

test("starting the automatic scan saves the limit, injects, and shows the running state", async () => {
  const popup = await openPopup({
    tabReplies: { AUTO_START: { ok: true, state: { running: true, message: "Scanning" } } }
  });
  popup.elements["limit-count"].value = "4";
  await popup.elements["auto-start"].click();
  assert.deepEqual(popup.storage.scanLimit, { limit: 4, unlimited: false });
  assert.equal(popup.log.injected.length, 1);
  assert.equal(popup.elements["auto-start"].disabled, true);
  assert.equal(popup.elements["auto-stop"].disabled, false);
  assert.equal(popup.text("status"), "Scanning");
});

test("starting the automatic scan re-enables the button and explains when it cannot start", async () => {
  const wrongSite = await openPopup({ tab: { id: 1, url: "https://example.com/" } });
  await wrongSite.elements["auto-start"].click();
  assert.equal(wrongSite.text("status"), "Automatic mode supports Instagram, Facebook, X, and TikTok profiles.");
  assert.equal(wrongSite.elements["auto-start"].disabled, false);

  const refused = await openPopup({ tabReplies: { AUTO_START: { ok: false, error: "Not a profile" } } });
  await refused.elements["auto-start"].click();
  assert.equal(refused.text("status"), "Not a profile");

  const silent = await openPopup({ tabReplies: { AUTO_START: null } });
  await silent.elements["auto-start"].click();
  assert.equal(silent.text("status"), "Could not start automatic downloading.");
});

test("stopping the automatic scan shows the state, or the reason it failed", async () => {
  const popup = await openPopup({
    tabReplies: { AUTO_STOP: { ok: true, state: { running: false, message: "Stopped" } } }
  });
  popup.elements["auto-stop"].disabled = false;
  await popup.elements["auto-stop"].click();
  assert.equal(popup.text("status"), "Stopped");
  assert.equal(popup.elements["auto-start"].disabled, false);
  assert.equal(popup.elements["auto-stop"].disabled, true);

  const failed = await openPopup({ tabReplies: { AUTO_STOP: { ok: false, error: "No scan" } } });
  await failed.elements["auto-stop"].click();
  assert.equal(failed.text("status"), "No scan");

  const silent = await openPopup({ tabReplies: { AUTO_STOP: undefined } });
  await silent.elements["auto-stop"].click();
  assert.equal(silent.text("status"), "Could not stop automatic downloading.");
});

test("a scan already running on the tab is reflected when the popup opens", async () => {
  const running = await openPopup({
    tabReplies: { AUTO_STATUS: { state: { running: true, message: "Already scanning" } } }
  });
  assert.equal(running.elements["auto-start"].disabled, true);
  assert.equal(running.elements["auto-stop"].disabled, false);
  assert.equal(running.text("status").includes("Already scanning"), true);

  const idle = await openPopup({ tabReplies: { AUTO_STATUS: {} } });
  assert.equal(idle.elements["auto-start"].disabled, false);

  const nothing = await openPopup({ tabReplies: { AUTO_STATUS: new Error("no content script") } });
  assert.equal(nothing.elements["auto-start"].disabled, false);

  const withoutMessage = await openPopup({ tabReplies: { AUTO_STATUS: { state: { running: true } } } });
  assert.equal(withoutMessage.elements["auto-start"].disabled, true);
});

test("progress and done messages from the page update the buttons; other messages are ignored", async () => {
  const popup = await openPopup();
  const [listener] = popup.listeners.message;
  listener({ type: "AUTO_PROGRESS", state: { running: true, message: "Page 2" } });
  assert.equal(popup.text("status").includes("Page 2"), true);
  assert.equal(popup.elements["auto-stop"].disabled, false);
  listener({ type: "AUTO_DONE", state: { running: false, message: "Finished" } });
  assert.equal(popup.text("status"), "Finished");
  assert.equal(popup.elements["auto-start"].disabled, false);
  listener({ type: "SOMETHING_ELSE", state: { running: true, message: "no" } });
  listener(undefined);
  assert.equal(popup.text("status"), "Finished");
});
