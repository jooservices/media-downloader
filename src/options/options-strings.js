// Every piece of text on the dashboard, in each language it supports. A new language is one more
// entry here; nothing else changes. English is the fallback for any language not listed.
(function initOptionsStrings(global) {
  "use strict";

  const STRINGS = {
    en: {
      title: "Page Media Saver",
      openDashboard: "Open the dashboard",
      subtitle: "Save the photos and videos of the profiles you add. Everything stays on your computer.",
      signInHeading: "Sign in first",
      signInNeeded: "Sign in to {site} in this browser, then come back. Nothing starts there until you do.",
      signInButton: "Open {site} sign-in",
      signedIn: "I have signed in",
      siteStatusIn: "Signed in",
      siteStatusOut: "Not signed in",
      addHeading: "Add profiles",
      addPlaceholder: "Paste profile links here, one per line (X, Instagram, Facebook)",
      addButton: "Add to the list",
      added: "Added {count}.",
      skipped: "Skipped {count} (already listed or not a profile link).",
      queueHeading: "Your list",
      empty: "Nothing here yet. Paste some profile links above.",
      summary:
        "{running} running Â· {waiting} waiting Â· {done} done Â· {problems} need attention Â· {files} files saved",
      pause: "Pause all",
      resume: "Resume",
      paused: "Paused. Nothing new will start until you resume.",
      clearFinished: "Clear finished",
      state_running: "Running",
      state_queued: "Waiting",
      state_complete: "Done",
      state_error: "Problem",
      state_incomplete: "Stopped early",
      state_paused: "Stopped",
      action_stop: "Stop",
      action_retry: "Try again",
      action_remove: "Remove",
      files: "{count} files",
      settingsHeading: "Settings",
      workersLabel: "Profiles at the same time, per site",
      workersHint: "1 is the safest. Using more raises the chance a site limits or blocks your account.",
      delayLabel: "Pause between profiles on the same site (seconds)",
      delayFrom: "from",
      delayTo: "to",
      retriesLabel: "Tries for a profile that fails",
      limitLabel: "Files per profile",
      limitUnlimited: "All of them",
      save: "Save settings",
      saved: "Settings saved.",
      downloadsHeading: "Where the files go",
      downloadsText:
        "Files are saved in your browser's Downloads folder, in folders named after the site and the profile. To use another drive or folder, change it in the browser: Settings â†’ Downloads.",
      problem: "Something went wrong: {error}"
    },
    vi: {
      title: "Page Media Saver",
      openDashboard: "Mở bảng điều khiển",
      subtitle:
        "LÆ°u áº£nh vÃ  video cá»§a cÃ¡c trang cÃ¡ nhÃ¢n báº¡n thÃªm vÃ o. Má»i thá»© náº±m trÃªn mÃ¡y cá»§a báº¡n.",
      signInHeading: "HÃ£y Ä‘Äƒng nháº­p trÆ°á»›c",
      signInNeeded:
        "HÃ£y Ä‘Äƒng nháº­p {site} trÃªn trÃ¬nh duyá»‡t nÃ y rá»“i quay láº¡i. Sáº½ khÃ´ng cÃ³ gÃ¬ cháº¡y á»Ÿ Ä‘Ã³ cho Ä‘áº¿n khi báº¡n Ä‘Äƒng nháº­p.",
      signInButton: "Má»Ÿ trang Ä‘Äƒng nháº­p {site}",
      signedIn: "TÃ´i Ä‘Ã£ Ä‘Äƒng nháº­p",
      siteStatusIn: "ÄÃ£ Ä‘Äƒng nháº­p",
      siteStatusOut: "ChÆ°a Ä‘Äƒng nháº­p",
      addHeading: "ThÃªm trang cÃ¡ nhÃ¢n",
      addPlaceholder: "DÃ¡n cÃ¡c liÃªn káº¿t vÃ o Ä‘Ã¢y, má»—i dÃ²ng má»™t liÃªn káº¿t (X, Instagram, Facebook)",
      addButton: "ThÃªm vÃ o danh sÃ¡ch",
      added: "ÄÃ£ thÃªm {count}.",
      skipped: "Bá» qua {count} (Ä‘Ã£ cÃ³ trong danh sÃ¡ch hoáº·c khÃ´ng pháº£i liÃªn káº¿t trang cÃ¡ nhÃ¢n).",
      queueHeading: "Danh sÃ¡ch cá»§a báº¡n",
      empty: "ChÆ°a cÃ³ gÃ¬. HÃ£y dÃ¡n vÃ i liÃªn káº¿t á»Ÿ trÃªn.",
      summary:
        "{running} Ä‘ang cháº¡y Â· {waiting} Ä‘ang chá» Â· {done} xong Â· {problems} cáº§n xem Â· {files} tá»‡p Ä‘Ã£ lÆ°u",
      pause: "Táº¡m dá»«ng táº¥t cáº£",
      resume: "Tiáº¿p tá»¥c",
      paused: "Äang táº¡m dá»«ng. Sáº½ khÃ´ng báº¯t Ä‘áº§u thÃªm cho Ä‘áº¿n khi báº¡n tiáº¿p tá»¥c.",
      clearFinished: "XÃ³a má»¥c Ä‘Ã£ xong",
      state_running: "Äang cháº¡y",
      state_queued: "Äang chá»",
      state_complete: "Xong",
      state_error: "CÃ³ lá»—i",
      state_incomplete: "Dá»«ng sá»›m",
      state_paused: "ÄÃ£ dá»«ng",
      action_stop: "Dá»«ng",
      action_retry: "Thá»­ láº¡i",
      action_remove: "XÃ³a",
      files: "{count} tá»‡p",
      settingsHeading: "CÃ i Ä‘áº·t",
      workersLabel: "Sá»‘ trang cháº¡y cÃ¹ng lÃºc, má»—i trang web",
      workersHint:
        "1 lÃ  an toÃ n nháº¥t. DÃ¹ng nhiá»u hÆ¡n lÃ m tÄƒng nguy cÆ¡ bá»‹ trang web giá»›i háº¡n hoáº·c khÃ³a tÃ i khoáº£n.",
      delayLabel: "Thá»i gian nghá»‰ giá»¯a cÃ¡c trang cÃ¡ nhÃ¢n cÃ¹ng má»™t trang web (giÃ¢y)",
      delayFrom: "tá»«",
      delayTo: "Ä‘áº¿n",
      retriesLabel: "Sá»‘ láº§n thá»­ khi má»™t trang bá»‹ lá»—i",
      limitLabel: "Sá»‘ tá»‡p cho má»—i trang cÃ¡ nhÃ¢n",
      limitUnlimited: "Táº¥t cáº£",
      save: "LÆ°u cÃ i Ä‘áº·t",
      saved: "ÄÃ£ lÆ°u cÃ i Ä‘áº·t.",
      downloadsHeading: "Tá»‡p Ä‘Æ°á»£c lÆ°u á»Ÿ Ä‘Ã¢u",
      downloadsText:
        "Tá»‡p Ä‘Æ°á»£c lÆ°u trong thÆ° má»¥c Táº£i xuá»‘ng cá»§a trÃ¬nh duyá»‡t, trong cÃ¡c thÆ° má»¥c Ä‘áº·t theo tÃªn trang web vÃ  trang cÃ¡ nhÃ¢n. Muá»‘n dÃ¹ng á»• Ä‘Ä©a hoáº·c thÆ° má»¥c khÃ¡c, hÃ£y Ä‘á»•i trong trÃ¬nh duyá»‡t: CÃ i Ä‘áº·t â†’ Táº£i xuá»‘ng.",
      problem: "CÃ³ lá»—i xáº£y ra: {error}"
    }
  };

  // The dictionary for a browser language such as "vi", "vi-VN" or "en-US"; English when unknown.
  function pick(language) {
    const base = String(language || "en")
      .toLowerCase()
      .split("-")[0];
    return Object.hasOwn(STRINGS, base) ? base : "en";
  }

  // Fills {name} placeholders. A missing key shows the key itself, so a gap is visible, never blank.
  function translator(language) {
    const table = STRINGS[pick(language)];
    return (key, values = {}) =>
      String(table[key] ?? STRINGS.en[key] ?? key).replace(/\{(\w+)\}/g, (_, name) =>
        String(values[name] ?? `{${name}}`)
      );
  }

  const api = Object.freeze({ STRINGS, pick, translator });

  global.PageMediaStrings = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
