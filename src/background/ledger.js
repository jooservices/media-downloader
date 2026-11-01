// The record of what has been saved, so the same media is never downloaded twice.
// It lives in IndexedDB, which has no practical size limit and takes one small
// write per file; the old list in chrome.storage was cut to its last 10,000 keys.
const LEDGER_DB_NAME = "page-media-saver";
const LEDGER_STORE = "downloaded";
let ledgerDb = null;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function openLedger() {
  if (ledgerDb) return ledgerDb;
  const opening = indexedDB.open(LEDGER_DB_NAME, 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore(LEDGER_STORE, { keyPath: "key" });
  ledgerDb = await requestResult(opening);
  await importLegacyLedger(ledgerDb);
  return ledgerDb;
}

// Keys written by earlier versions lived in chrome.storage.local; move them once,
// in the new key form, so nothing already saved is downloaded again.
async function importLegacyLedger(db) {
  const { downloadedKeys = [], ledgerImported = false } = await chrome.storage.local.get({ downloadedKeys: [], ledgerImported: false });
  if (ledgerImported) return;
  if (downloadedKeys.length) {
    const transaction = db.transaction(LEDGER_STORE, "readwrite");
    const store = transaction.objectStore(LEDGER_STORE);
    for (const key of downloadedKeys) store.put({ key: PageMediaLib.keys.toCanonicalKey(key), at: 0 });
    await transactionDone(transaction);
  }
  await chrome.storage.local.set({ ledgerImported: true });
  await chrome.storage.local.remove("downloadedKeys");
}

// Both the key as given and its canonical form count, so a key from an old
// content script (or an old job) still finds what the new form recorded.
async function ledgerHas(key) {
  const db = await openLedger();
  const store = db.transaction(LEDGER_STORE, "readonly").objectStore(LEDGER_STORE);
  for (const candidate of new Set([key, PageMediaLib.keys.toCanonicalKey(key)])) {
    if (await requestResult(store.get(candidate))) return true;
  }
  return false;
}

async function ledgerAdd(key) {
  const db = await openLedger();
  const transaction = db.transaction(LEDGER_STORE, "readwrite");
  transaction.objectStore(LEDGER_STORE).put({ key: PageMediaLib.keys.toCanonicalKey(key), at: Date.now() });
  await transactionDone(transaction);
}

async function ledgerCount() {
  const db = await openLedger();
  return requestResult(db.transaction(LEDGER_STORE, "readonly").objectStore(LEDGER_STORE).count());
}
