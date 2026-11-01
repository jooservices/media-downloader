// File and folder naming. Every file is saved as
// <Downloads>/<site>/<account>/<name>_<width>x<height>.<ext>.
(function initPaths(global) {
  "use strict";

  const cleanPart = (value, fallback = "account") => {
    const result = String(value || "")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/[. ]+$/g, "")
      .trim()
      .slice(0, 80);
    return result || fallback;
  };

  function buildSavePath(platform, account, filename) {
    return `${platform}/${account}/${filename}`;
  }

  // Adds _<width>x<height> before the extension when both sizes are known.
  function withResolution(filename, width, height) {
    const w = Number(width);
    const h = Number(height);
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) return filename;
    const dot = filename.lastIndexOf(".");
    return dot > 0 ? `${filename.slice(0, dot)}_${w}x${h}${filename.slice(dot)}` : `${filename}_${w}x${h}`;
  }

  function imageExtension(url) {
    try {
      const ext = new URL(url).pathname.match(/\.(jpe?g|png|webp|gif|avif)$/i)?.[1]?.toLowerCase();
      return ext === "jpeg" ? "jpg" : (ext || "jpg");
    } catch {
      return "jpg";
    }
  }

  const api = Object.freeze({ cleanPart, buildSavePath, withResolution, imageExtension });

  (global.PageMediaLib ||= {}).paths = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
