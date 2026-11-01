// The scan limit chosen in the popup: a number of files, or "unlimited" (checkbox).
// The CLI has its own option and never reads this.
(function initSettings(global) {
  "use strict";

  const DEFAULT_SCAN_LIMIT = 10;
  const STORAGE_KEY = "scanLimit";
  const DEFAULTS = Object.freeze({ limit: DEFAULT_SCAN_LIMIT, unlimited: false });

  // Anything stored that is not a whole number of at least 1 falls back to the default.
  function normalizeScanLimit(stored) {
    const limit = Number(stored?.limit);
    return {
      limit: Number.isInteger(limit) && limit >= 1 ? limit : DEFAULT_SCAN_LIMIT,
      unlimited: stored?.unlimited === true
    };
  }

  // The limit a scan should use: a number, or null for no limit.
  const effectiveScanLimit = stored => {
    const setting = normalizeScanLimit(stored);
    return setting.unlimited ? null : setting.limit;
  };

  const api = Object.freeze({ DEFAULT_SCAN_LIMIT, STORAGE_KEY, DEFAULTS, normalizeScanLimit, effectiveScanLimit });

  (global.PageMediaLib ||= {}).settings = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
