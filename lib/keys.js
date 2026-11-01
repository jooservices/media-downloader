// One identity per saved file, whatever account folder or page it was found on:
// <Platform>|photo|<post id>|<n>, <Platform>|image|<post id>|<n> and <Platform>|video|<post id>|<n>.
// The old keys carried the account name, so the same media seen through two
// accounts was saved twice; toCanonicalKey maps old keys onto the new form.
(function initKeys(global) {
  "use strict";

  const PLATFORM_NAMES = new Set(["Instagram", "Facebook", "Twitter"]);

  const photoKey = (platform, id, index = 1) => `${platform}|photo|${id}|${index}`;
  const videoKey = (platform, id, index = 1) => `${platform}|video|${id}|${index}`;
  // A photo saved at the largest size its page's data lists. It has its own kind so a
  // smaller copy recorded earlier under photoKey (a thumbnail taken from the page)
  // never stops the full-size one from being saved.
  const imageKey = (platform, id, index = 1) => `${platform}|image|${id}|${index}`;

  // Old forms: "<Platform>:<account>:<id>:<n>" (photo) and
  // "<Platform>:<owner>:video:<id>" or "...:<id>:<n>" (video). Anything else,
  // including a key that is already canonical, is returned unchanged.
  function toCanonicalKey(key) {
    const text = String(key);
    if (text.includes("|")) return text;
    const parts = text.split(":");
    if (!PLATFORM_NAMES.has(parts[0])) return text;
    if (parts[2] === "video" && (parts.length === 4 || (parts.length === 5 && /^\d+$/.test(parts[4])))) {
      return videoKey(parts[0], parts[3], parts.length === 5 ? Number(parts[4]) : 1);
    }
    if (parts.length === 4 && /^\d+$/.test(parts[3])) return photoKey(parts[0], parts[2], Number(parts[3]));
    return text;
  }

  const api = Object.freeze({ photoKey, videoKey, imageKey, toCanonicalKey });

  (global.PageMediaLib ||= {}).keys = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
