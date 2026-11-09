import assert from "node:assert/strict";
import test from "node:test";
import { FakeElement, loadPage, settle } from "../helpers/fake-dom.mjs";

const IDS = [
  "sign-in",
  "sign-in-list",
  "signed-in",
  "links",
  "add",
  "add-result",
  "sites",
  "pause",
  "clear",
  "summary",
  "paused-note",
  "jobs",
  "empty",
  "settings",
  "workers-x",
  "workers-instagram",
  "workers-facebook",
  "workers-tiktok",
  "delay-min",
  "delay-max",
  "attempts",
  "unlimited",
  "limit",
  "settings-result"
];
const SCRIPTS = [
  "lib/sites.js",
  "src/options/options-strings.js",
  "src/options/options-model.js",
  "src/options/options.js"
];

const LOGIN = {
  Twitter: { label: "X", signedIn: false, signInUrl: "https://x.com/i/flow/login" },
  Instagram: { label: "Instagram", signedIn: true, signInUrl: "https://www.instagram.com/accounts/login/" }
};
const SETTINGS = {
  workers: { Twitter: 2, Instagram: 1, Facebook: 3, TikTok: 4 },
  delaySeconds: { min: 5, max: 9 },
  maxAttempts: 3,
  limit: null
};
const snapshot = (overrides = {}) => ({
  ok: true,
  login: LOGIN,
  jobs: [],
  paused: false,
  settings: SETTINGS,
  ...overrides
});

// Opens the dashboard page against a scripted extension. `state` is what QUEUE_STATE answers now (change it
// between steps); `replies` answers the other messages by type.
async function openDashboard({ state = snapshot(), replies = {}, language = "en", translated = [] } = {}) {
  const sent = [];
  const tabsCreated = [];
  const current = { state, replies: { ...replies } };
  const chrome = {
    i18n: { getUILanguage: () => language },
    runtime: {
      sendMessage: async message => {
        sent.push(JSON.parse(JSON.stringify(message)));
        if (message.type === "QUEUE_STATE") {
          if (current.state instanceof Error) {
            throw current.state;
          }
          return current.state;
        }
        const reply = current.replies[message.type];
        return typeof reply === "function" ? reply(message) : (reply ?? { ok: true });
      }
    },
    tabs: {
      create: options => {
        tabsCreated.push(JSON.parse(JSON.stringify(options)));
      }
    }
  };
  const page = loadPage({ ids: IDS, scripts: SCRIPTS, chrome, translated });
  page.run();
  await settle();
  const text = id => page.elements[id].textContent;
  return { ...page, sent, tabsCreated, current, text, sentOf: type => sent.filter(message => message.type === type) };
}

const job = (overrides = {}) => ({
  jobId: "j1",
  platform: "Twitter",
  account: "alice",
  status: "queued",
  started: 0,
  message: "",
  ...overrides
});

test("static text and placeholders are translated and the page language is set", async () => {
  const label = new FakeElement("h2");
  label.dataset.i18n = "queueHeading";
  const field = new FakeElement("textarea");
  field.dataset.i18nPlaceholder = "addPlaceholder";
  const dashboard = await openDashboard({ language: "vi-VN", translated: [label, field] });
  assert.equal(label.textContent, "Danh sách của bạn");
  assert.match(field.placeholder, /^Dán các liên kết/);
  assert.equal(dashboard.document.documentElement.lang, "vi");

  const fallback = await openDashboard({ language: "fr" });
  assert.equal(fallback.document.documentElement.lang, "en");
});

test("the sign-in banner lists each signed-out site with a button that opens its sign-in page", async () => {
  const dashboard = await openDashboard({ state: snapshot({ jobs: [job()] }) });
  assert.equal(dashboard.elements["sign-in"].hidden, false);
  const [item] = dashboard.elements["sign-in-list"].children;
  assert.match(item.children[0].textContent, /Sign in to X/);
  const button = item.children[1];
  assert.equal(button.textContent, "Open X sign-in");
  assert.equal(button.type, "button");
  await button.click();
  assert.deepEqual(dashboard.tabsCreated, [{ url: "https://x.com/i/flow/login" }]);

  const quiet = await openDashboard();
  assert.equal(quiet.elements["sign-in"].hidden, true);
  assert.equal(quiet.elements["sign-in-list"].children.length, 0);
});

test("each site shows a chip for whether the browser is signed in", async () => {
  const dashboard = await openDashboard();
  const chips = dashboard.elements.sites.children.map(chip => [chip.textContent, chip.className]);
  assert.deepEqual(chips, [
    ["X: Not signed in", "chip bad"],
    ["Instagram: Signed in", "chip ok"]
  ]);
});

test("jobs are listed with site, account, state, file count and only the buttons that apply", async () => {
  const jobs = [
    job({ jobId: "a", status: "running", started: 2, videoStarted: 1, message: "Scanning" }),
    job({ jobId: "b", status: "error", platform: "Instagram", account: "bob", message: "Sign in needed" }),
    job({ jobId: "c", status: "complete" })
  ];
  const dashboard = await openDashboard({ state: snapshot({ jobs }) });
  const rows = dashboard.elements.jobs.children;
  assert.equal(rows.length, 3);
  assert.equal(rows[0].children[0].textContent, "X · aliceRunning");
  assert.equal(rows[0].children[2].textContent, "3 files · Scanning");
  assert.deepEqual(
    rows[0].children[1].children.map(button => button.textContent),
    ["Stop"]
  );
  assert.deepEqual(
    rows[1].children[1].children.map(button => button.textContent),
    ["Try again", "Remove"]
  );
  assert.equal(rows[1].children[2].textContent, "Sign in needed", "no file prefix when nothing was saved");
  assert.equal(dashboard.elements.empty.hidden, true);
  assert.match(dashboard.text("summary"), /1 running · 0 waiting · 1 done · 1 need attention · 3 files saved/);
});

test("with no jobs the empty note shows", async () => {
  const dashboard = await openDashboard();
  assert.equal(dashboard.elements.empty.hidden, false);
  assert.equal(dashboard.elements.jobs.children.length, 0);
});

test("a job button sends that action for that job and refreshes the list", async () => {
  const dashboard = await openDashboard({ state: snapshot({ jobs: [job({ status: "error" })] }) });
  dashboard.current.state = snapshot({ jobs: [] });
  const retry = dashboard.elements.jobs.children[0].children[1].children[0];
  await retry.click();
  await settle();
  assert.deepEqual(dashboard.sentOf("QUEUE_ACTION"), [{ type: "QUEUE_ACTION", action: "retry", jobId: "j1" }]);
  assert.equal(dashboard.elements.jobs.children.length, 0, "the list was refreshed after the action");
  assert.equal(dashboard.text("add-result"), "");
});

test("a refused job action is reported", async () => {
  const dashboard = await openDashboard({
    state: snapshot({ jobs: [job({ status: "error" })] }),
    replies: { QUEUE_ACTION: { ok: false, error: "No such job" } }
  });
  await dashboard.elements.jobs.children[0].children[1].children[1].click();
  assert.equal(dashboard.text("add-result"), "Something went wrong: No such job");
});

test("Clear finished asks to clear the finished jobs", async () => {
  const dashboard = await openDashboard();
  await dashboard.elements.clear.click();
  assert.deepEqual(dashboard.sentOf("QUEUE_ACTION"), [{ type: "QUEUE_ACTION", action: "clear-finished" }]);
});

test("the pause button reads Pause all or Resume and toggles the queue", async () => {
  const dashboard = await openDashboard();
  assert.equal(dashboard.text("pause"), "Pause all");
  assert.equal(dashboard.elements["paused-note"].hidden, true);

  dashboard.current.state = snapshot({ paused: true });
  await dashboard.elements.pause.click();
  await settle();
  assert.deepEqual(dashboard.sentOf("QUEUE_PAUSE"), [{ type: "QUEUE_PAUSE", paused: true }]);
  assert.equal(dashboard.text("pause"), "Resume");
  assert.equal(dashboard.elements["paused-note"].hidden, false);

  await dashboard.elements.pause.click();
  assert.deepEqual(dashboard.sentOf("QUEUE_PAUSE").at(-1), { type: "QUEUE_PAUSE", paused: false });
});

test("I have signed in tells the extension and refreshes", async () => {
  const dashboard = await openDashboard();
  const before = dashboard.sentOf("QUEUE_STATE").length;
  await dashboard.elements["signed-in"].click();
  assert.equal(dashboard.sentOf("QUEUE_SIGNED_IN").length, 1);
  assert.equal(dashboard.sentOf("QUEUE_STATE").length, before + 1);
});

test("pasted links are sent once, the box clears, and skipped links are counted", async () => {
  const dashboard = await openDashboard({
    replies: { QUEUE_ADD: { ok: true, created: [{}, {}], skipped: [{}] } }
  });
  dashboard.elements.links.value = "https://x.com/a, https://x.com/b not-a-link";
  await dashboard.elements.add.click();
  assert.deepEqual(dashboard.sentOf("QUEUE_ADD"), [
    { type: "QUEUE_ADD", urls: ["https://x.com/a", "https://x.com/b"] }
  ]);
  assert.equal(dashboard.elements.links.value, "");
  assert.equal(dashboard.text("add-result"), "Added 2. Skipped 1 (already listed or not a profile link).");

  dashboard.elements.links.value = "https://x.com/c";
  dashboard.current.replies.QUEUE_ADD = { ok: true, created: [{}], skipped: [] };
  await dashboard.elements.add.click();
  assert.equal(dashboard.text("add-result"), "Added 1.");
});

test("adding nothing sends nothing, and a refused add keeps the text and shows the reason", async () => {
  const dashboard = await openDashboard({ replies: { QUEUE_ADD: { ok: false, error: "Too many" } } });
  dashboard.elements.links.value = "just words";
  await dashboard.elements.add.click();
  assert.equal(dashboard.sentOf("QUEUE_ADD").length, 0);

  dashboard.elements.links.value = "https://x.com/a";
  await dashboard.elements.add.click();
  assert.equal(dashboard.text("add-result"), "Something went wrong: Too many");
  assert.equal(dashboard.elements.links.value, "https://x.com/a");
});

test("the settings form shows the saved settings, with the limit box off when unlimited", async () => {
  const dashboard = await openDashboard();
  const value = id => dashboard.elements[id].value;
  assert.deepEqual(["workers-x", "workers-instagram", "workers-facebook", "workers-tiktok"].map(value), [
    "2",
    "1",
    "3",
    "4"
  ]);
  assert.deepEqual([value("delay-min"), value("delay-max"), value("attempts")], ["5", "9", "3"]);
  assert.equal(dashboard.elements.unlimited.checked, true);
  assert.equal(dashboard.elements.limit.disabled, true);

  const limited = await openDashboard({ state: snapshot({ settings: { ...SETTINGS, limit: 25 } }) });
  assert.equal(limited.elements.unlimited.checked, false);
  assert.equal(limited.elements.limit.value, "25");
  assert.equal(limited.elements.limit.disabled, false);
});

test("saving sends the form as numbers and reports success, then lets the page follow the saved state", async () => {
  const dashboard = await openDashboard();
  dashboard.elements["workers-x"].value = "4";
  dashboard.elements.unlimited.checked = false;
  dashboard.elements.limit.value = "12";
  await dashboard.elements.settings.dispatch("input");
  assert.equal(dashboard.elements.limit.disabled, false);

  await dashboard.elements.settings.dispatch("submit");
  const [saved] = dashboard.sentOf("QUEUE_SETTINGS_SAVE");
  assert.deepEqual(saved.settings.workers, { x: 4, instagram: 1, facebook: 3, tiktok: 4 });
  assert.deepEqual(saved.settings.delaySeconds, { min: 5, max: 9 });
  assert.equal(saved.settings.limit, 12);
  assert.equal(dashboard.text("settings-result"), "Settings saved.");

  dashboard.current.state = snapshot({ settings: { ...SETTINGS, maxAttempts: 7 } });
  await dashboard.elements.pause.click();
  await settle();
  assert.equal(dashboard.elements.attempts.value, "7", "after saving the form follows the extension again");
});

test("an unfinished edit is not overwritten by a refresh, and a refused save shows the reason", async () => {
  const dashboard = await openDashboard({
    replies: { QUEUE_SETTINGS_SAVE: { ok: false, error: "Delay is too long" } }
  });
  dashboard.elements.attempts.value = "9";
  await dashboard.elements.settings.dispatch("input");
  dashboard.current.state = snapshot({ settings: { ...SETTINGS, maxAttempts: 5 } });
  await dashboard.elements.clear.click();
  await settle();
  assert.equal(dashboard.elements.attempts.value, "9");

  await dashboard.elements.settings.dispatch("submit");
  assert.equal(dashboard.text("settings-result"), "Something went wrong: Delay is too long");
  assert.equal(dashboard.elements.attempts.value, "9", "still the user's edit after a refused save");
});

test("an unlimited tick sends no limit and disables the box as it is clicked", async () => {
  const dashboard = await openDashboard({ state: snapshot({ settings: { ...SETTINGS, limit: 5 } }) });
  dashboard.elements.unlimited.checked = true;
  await dashboard.elements.settings.dispatch("input");
  assert.equal(dashboard.elements.limit.disabled, true);
  await dashboard.elements.settings.dispatch("submit");
  assert.equal(dashboard.sentOf("QUEUE_SETTINGS_SAVE")[0].settings.limit, null);
});

test("an unreachable or refusing extension leaves the page as it was", async () => {
  const down = await openDashboard({ state: new Error("worker asleep") });
  assert.equal(down.elements.sites.children.length, 0);

  const refusing = await openDashboard({ state: { ok: false } });
  assert.equal(refusing.elements.jobs.children.length, 0);
});

test("the page polls every two seconds while visible and stays quiet while hidden", async () => {
  const dashboard = await openDashboard();
  assert.equal(dashboard.intervals.length, 1);
  assert.equal(dashboard.intervals[0].ms, 2000);
  const before = dashboard.sentOf("QUEUE_STATE").length;
  dashboard.intervals[0].callback();
  await settle();
  assert.equal(dashboard.sentOf("QUEUE_STATE").length, before + 1);

  dashboard.document.hidden = true;
  dashboard.intervals[0].callback();
  await settle();
  assert.equal(dashboard.sentOf("QUEUE_STATE").length, before + 1);
});
