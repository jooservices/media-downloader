// File and folder naming. Every file is saved as
// <Downloads>/<site>/<account>/<name>_<width>x<height>.<ext>.
(function initPaths(global) {
  "use strict";

  // Characters Windows does not allow in a file or folder name, and control characters.
  const FORBIDDEN = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);
  const isForbidden = char => FORBIDDEN.has(char) || char.charCodeAt(0) < 0x20;

  function trimTrailingDotsAndSpaces(text) {
    let end = text.length;
    while (end > 0 && (text[end - 1] === "." || text[end - 1] === " ")) {
      end--;
    }
    return text.slice(0, end);
  }

  const cleanPart = (value, fallback = "account") => {
    const replaced = Array.from(String(value || ""), char => (isForbidden(char) ? "_" : char)).join("");
    const result = trimTrailingDotsAndSpaces(replaced).trim().slice(0, 80);
    return result || fallback;
  };

  function buildSavePath(platform, account, filename) {
    return `${platform}/${account}/${filename}`;
  }

  // Adds _<width>x<height> before the extension when both sizes are known.
  function withResolution(filename, width, height) {
    const w = Number(width);
    const h = Number(height);
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
      return filename;
    }
    const dot = filename.lastIndexOf(".");
    return dot > 0 ? `${filename.slice(0, dot)}_${w}x${h}${filename.slice(dot)}` : `${filename}_${w}x${h}`;
  }

  function imageExtension(url) {
    try {
      const ext = new URL(url).pathname.match(/\.(jpe?g|png|webp|gif|avif)$/i)?.[1]?.toLowerCase();
      return ext === "jpeg" ? "jpg" : ext || "jpg";
    } catch {
      return "jpg";
    }
  }

  const api = Object.freeze({ cleanPart, buildSavePath, withResolution, imageExtension });

  global.PageMediaLib ??= {};
  global.PageMediaLib.paths = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
