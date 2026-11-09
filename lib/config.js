// User settings and their validation. Shared by the CLI (config.json) and the extension (options page),
// so both accept and reject exactly the same values.
(function initConfig(global) {
  "use strict";

  const sites = typeof require === "function" ? require("./sites.js") : global.PageMediaLib.sites;
  const PLATFORM_NAMES = Object.freeze(sites.names());
  const MAX_WORKERS = 8;

  const DEFAULT_CONFIG = Object.freeze({
    workers: Object.freeze(Object.fromEntries(PLATFORM_NAMES.map(name => [name, 1]))),
    delaySeconds: Object.freeze({ min: 15, max: 60 }),
    maxAttempts: 3,
    limit: null,
    downloadDir: null,
    notify: null
  });

  // "x" and "twitter" name the same site; the extension and the job files call it Twitter.
  const PLATFORM_ALIASES = sites.aliases();

  const isWholeNumber = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

  function parseWorkers(raw) {
    const workers = { ...DEFAULT_CONFIG.workers };
    for (const [key, value] of Object.entries(raw ?? {})) {
      const platform = PLATFORM_ALIASES.get(key.toLowerCase());
      if (!platform) {
        throw new Error(`workers: unknown site “${key}”. Use ${sites.aliasHint()}.`);
      }
      if (!isWholeNumber(value, 1, MAX_WORKERS)) {
        throw new Error(`workers.${key} must be a whole number from 1 to ${MAX_WORKERS}.`);
      }
      workers[platform] = value;
    }
    return workers;
  }

  function parseDelay(raw) {
    const delay = { ...DEFAULT_CONFIG.delaySeconds, ...(raw ?? {}) };
    const valid = [delay.min, delay.max].every(value => Number.isFinite(value) && value >= 0 && value <= 3600);
    if (!valid || delay.min > delay.max) {
      throw new Error("delaySeconds needs min and max between 0 and 3600, with min not above max.");
    }
    return { min: delay.min, max: delay.max };
  }

  function parseLimit(raw) {
    if (raw === null || raw === undefined) {
      return null;
    }
    if (!isWholeNumber(raw, 1, 1_000_000)) {
      throw new Error("limit must be a whole number of at least 1, or null for no limit.");
    }
    return raw;
  }

  function trimTrailingSeparators(value) {
    let end = value.length;
    while (end > 0 && (value[end - 1] === "\\" || value[end - 1] === "/")) {
      end--;
    }
    return value.slice(0, end);
  }

  const isWindowsAbsolute = value => /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");

  // A drive root or a system folder would be a dangerous place to move files into.
  function parseDownloadDir(raw) {
    if (raw === null || raw === undefined || raw === "") {
      return null;
    }
    if (typeof raw !== "string" || raw.includes("\0")) {
      throw new Error("downloadDir must be a full path such as D:\\Media, \\\\nas\\share\\Media, or /home/me/Media.");
    }
    if (raw.startsWith("/")) {
      const normalized = trimTrailingSeparators(raw);
      if (!normalized || normalized === "/") {
        throw new Error("downloadDir cannot be the root of a drive; choose a folder such as /home/me/Media.");
      }
      return normalized;
    }
    if (!isWindowsAbsolute(raw)) {
      throw new Error("downloadDir must be a full path such as D:\\Media, \\\\nas\\share\\Media, or /home/me/Media.");
    }
    const unified = raw.replaceAll("/", "\\");
    const isUnc = unified.startsWith("\\\\");
    const normalized =
      (isUnc ? "\\\\" : "") + trimTrailingSeparators(unified.slice(isUnc ? 2 : 0)).replace(/\\{2,}/g, "\\");
    if (normalized.length === 2 && normalized[1] === ":") {
      throw new Error("downloadDir cannot be the root of a drive; choose a folder such as D:\\Media.");
    }
    const lower = normalized.toLowerCase();
    const forbidden = ["windows", "program files"].some(name => {
      const root = `${lower.slice(0, 3)}${name}`;
      return lower[1] === ":" && (lower === root || lower.startsWith(`${root}\\`) || lower.startsWith(`${root} (x86)`));
    });
    if (forbidden) {
      throw new Error("downloadDir cannot be inside the Windows or Program Files folders.");
    }
    return normalized;
  }

  const NOTIFY_EVENTS = Object.freeze(["new-content", "problem", "backoff-start", "backoff-end"]);
  const NOTIFY_FORMATS = Object.freeze(["json", "text"]);
  const LOCAL_HOSTS = Object.freeze(["127.0.0.1", "localhost", "[::1]"]);
  function isAllowedWebhook(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.includes(url.hostname));
    } catch {
      return false;
    }
  }

  // Where to send a message when a scan brings new files or runs into trouble. https, or http on this computer.
  function parseNotify(raw) {
    if (raw === null || raw === undefined) {
      return null;
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("notify must be an object with a url, or null.");
    }
    if (typeof raw.url !== "string" || !isAllowedWebhook(raw.url)) {
      throw new Error("notify.url must be an https link (or http on this computer).");
    }
    const format = raw.format ?? "json";
    if (!NOTIFY_FORMATS.includes(format)) {
      throw new Error(`notify.format must be one of: ${NOTIFY_FORMATS.join(", ")}.`);
    }
    const events = raw.events ?? [...NOTIFY_EVENTS];
    if (!Array.isArray(events) || !events.length || !events.every(event => NOTIFY_EVENTS.includes(event))) {
      throw new Error(`notify.events must list some of: ${NOTIFY_EVENTS.join(", ")}.`);
    }
    return { url: raw.url, format, events: [...new Set(events)] };
  }

  // Turns whatever the user wrote into a complete, valid config, or explains exactly what is wrong.
  function parseConfig(raw) {
    if (raw !== null && raw !== undefined && (typeof raw !== "object" || Array.isArray(raw))) {
      throw new Error("The settings must be a JSON object.");
    }
    const input = raw ?? {};
    const maxAttempts = input.maxAttempts ?? DEFAULT_CONFIG.maxAttempts;
    if (!isWholeNumber(maxAttempts, 1, 20)) {
      throw new Error("maxAttempts must be a whole number from 1 to 20.");
    }
    return {
      workers: parseWorkers(input.workers),
      delaySeconds: parseDelay(input.delaySeconds),
      maxAttempts,
      limit: parseLimit(input.limit),
      downloadDir: parseDownloadDir(input.downloadDir),
      notify: parseNotify(input.notify)
    };
  }

  const api = Object.freeze({ PLATFORM_NAMES, MAX_WORKERS, DEFAULT_CONFIG, parseConfig });

  global.PageMediaLib ??= {};
  global.PageMediaLib.config = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
