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
      addPlaceholder: "Paste profile links here, one per line (X, Instagram, Facebook, TikTok)",
      addButton: "Add to the list",
      added: "Added {count}.",
      skipped: "Skipped {count} (already listed or not a profile link).",
      queueHeading: "Your list",
      empty: "Nothing here yet. Paste some profile links above.",
      summary: "{running} running · {waiting} waiting · {done} done · {problems} need attention · {files} files saved",
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
        "Files are saved in your browser's Downloads folder, in folders named after the site and the profile. To use another drive or folder, change it in the browser: Settings → Downloads.",
      problem: "Something went wrong: {error}"
    },
    vi: {
      title: "Page Media Saver",
      openDashboard: "Mở bảng điều khiển",
      subtitle: "Lưu ảnh và video của các trang cá nhân bạn thêm vào. Mọi thứ nằm trên máy của bạn.",
      signInHeading: "Hãy đăng nhập trước",
      signInNeeded:
        "Hãy đăng nhập {site} trên trình duyệt này rồi quay lại. Sẽ không có gì chạy ở đó cho đến khi bạn đăng nhập.",
      signInButton: "Mở trang đăng nhập {site}",
      signedIn: "Tôi đã đăng nhập",
      siteStatusIn: "Đã đăng nhập",
      siteStatusOut: "Chưa đăng nhập",
      addHeading: "Thêm trang cá nhân",
      addPlaceholder: "Dán các liên kết vào đây, mỗi dòng một liên kết (X, Instagram, Facebook, TikTok)",
      addButton: "Thêm vào danh sách",
      added: "Đã thêm {count}.",
      skipped: "Bỏ qua {count} (đã có trong danh sách hoặc không phải liên kết trang cá nhân).",
      queueHeading: "Danh sách của bạn",
      empty: "Chưa có gì. Hãy dán vài liên kết ở trên.",
      summary: "{running} đang chạy · {waiting} đang chờ · {done} xong · {problems} cần xem · {files} tệp đã lưu",
      pause: "Tạm dừng tất cả",
      resume: "Tiếp tục",
      paused: "Đang tạm dừng. Sẽ không bắt đầu thêm cho đến khi bạn tiếp tục.",
      clearFinished: "Xóa mục đã xong",
      state_running: "Đang chạy",
      state_queued: "Đang chờ",
      state_complete: "Xong",
      state_error: "Có lỗi",
      state_incomplete: "Dừng sớm",
      state_paused: "Đã dừng",
      action_stop: "Dừng",
      action_retry: "Thử lại",
      action_remove: "Xóa",
      files: "{count} tệp",
      settingsHeading: "Cài đặt",
      workersLabel: "Số trang chạy cùng lúc, mỗi trang web",
      workersHint: "1 là an toàn nhất. Dùng nhiều hơn làm tăng nguy cơ bị trang web giới hạn hoặc khóa tài khoản.",
      delayLabel: "Thời gian nghỉ giữa các trang cá nhân cùng một trang web (giây)",
      delayFrom: "từ",
      delayTo: "đến",
      retriesLabel: "Số lần thử khi một trang bị lỗi",
      limitLabel: "Số tệp cho mỗi trang cá nhân",
      limitUnlimited: "Tất cả",
      save: "Lưu cài đặt",
      saved: "Đã lưu cài đặt.",
      downloadsHeading: "Tệp được lưu ở đâu",
      downloadsText:
        "Tệp được lưu trong thư mục Tải xuống của trình duyệt, trong các thư mục đặt theo tên trang web và trang cá nhân. Muốn dùng ổ đĩa hoặc thư mục khác, hãy đổi trong trình duyệt: Cài đặt → Tải xuống.",
      problem: "Có lỗi xảy ra: {error}"
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
