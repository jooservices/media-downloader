// Wires the queue engine to the real browser: storage, tabs, cookies, the alarm that keeps it ticking,
// and the messages the dashboard sends. Everything else in the queue is plain logic with its own tests.
const QUEUE_ALARM = "pms-queue";
const QUEUE_TICK_MINUTES = 0.5;

const queueEngine = createQueueEngine({
  store: createJobStore(chrome.storage.local),
  settings: createQueueSettings(chrome.storage.local),
  login: createLoginChecker(chrome.cookies),
  tabs: {
    create: options => chrome.tabs.create(options),
    remove: tabId => chrome.tabs.remove(tabId),
    sendMessage: (tabId, message) => chrome.tabs.sendMessage(tabId, message)
  },
  now: () => Date.now(),
  random: () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32,
  log: message => console.log(`[queue] ${message}`)
});

const asResponse = work =>
  work.then(
    result => ({ ok: true, ...result }),
    error => ({ ok: false, error: error?.message || String(error) })
  );

// Messages from the dashboard (options page and popup).
const queueHandlers = {
  QUEUE_STATE: () => asResponse(queueEngine.snapshot()),
  QUEUE_ADD: message => asResponse(queueEngine.add(Array.isArray(message.urls) ? message.urls : [])),
  QUEUE_ACTION: message => asResponse(queueEngine.act(message.action, message.jobId).then(() => ({}))),
  QUEUE_SETTINGS_SAVE: message =>
    asResponse(queueEngine.saveSettings(message.settings).then(settings => ({ settings }))),
  QUEUE_PAUSE: message => asResponse(queueEngine.setPaused(message.paused).then(() => ({}))),
  QUEUE_SIGNED_IN: () => asResponse(queueEngine.signedIn().then(() => ({})))
};

chrome.alarms.create(QUEUE_ALARM, { periodInMinutes: QUEUE_TICK_MINUTES });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === QUEUE_ALARM) {
    queueEngine.tick().catch(() => undefined);
  }
});

// After the browser itself restarts, nothing is still scanning: end what was running so it can be retried.
chrome.runtime.onStartup.addListener(() => {
  queueEngine
    .recover()
    .then(() => queueEngine.tick())
    .catch(() => undefined);
});

// The first thing a new user sees is the dashboard, where they sign in and add profiles.
// Not while the CLI has already opened a page for a job: the dashboard would take the foreground and the
// browser slows a background tab down, which starves the scan running in it.
async function cliJobIsOpen() {
  try {
    const tabs = await chrome.tabs.query({});
    return tabs.some(tab => {
      try {
        return PageMediaLib.urls.cliJobIdFromHash(new URL(tab.url).hash) !== null;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

chrome.runtime.onInstalled.addListener(async details => {
  if (details.reason === "install" && !(await cliJobIsOpen())) {
    chrome.runtime.openOptionsPage().catch(() => undefined);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    queueEngine.tabNavigated(tabId, changeInfo.url).catch(() => undefined);
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  queueEngine.tabClosed(tabId).catch(() => undefined);
});
