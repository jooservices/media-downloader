// Where Edge, Chrome and Firefox live on Windows, macOS and Linux, and how a profile is opened.
import path from "node:path";

export const BROWSER_IDS = Object.freeze(["edge", "chrome", "firefox"]);

const EXTENSIONS_PAGE = {
  edge: "edge://extensions",
  chrome: "chrome://extensions",
  firefox: "about:debugging#/runtime/this-firefox"
};

function joinFor(platform, ...parts) {
  return (platform === "win32" ? path.win32 : path.posix).join(...parts);
}

function windowsPrograms(env, segments) {
  return [env["PROGRAMFILES(X86)"], env.ProgramFiles, env.LOCALAPPDATA]
    .filter(Boolean)
    .map(root => joinFor("win32", root, ...segments));
}

export function browserLayout(platform, env = {}) {
  const home = env.HOME || env.USERPROFILE || "";
  if (platform === "win32") {
    return {
      edge: {
        id: "edge",
        label: "Edge",
        executables: windowsPrograms(env, ["Microsoft", "Edge", "Application", "msedge.exe"]),
        userData: joinFor("win32", env.LOCALAPPDATA || "", "Microsoft", "Edge", "User Data"),
        extensionsPage: EXTENSIONS_PAGE.edge
      },
      chrome: {
        id: "chrome",
        label: "Chrome",
        executables: windowsPrograms(env, ["Google", "Chrome", "Application", "chrome.exe"]),
        userData: joinFor("win32", env.LOCALAPPDATA || "", "Google", "Chrome", "User Data"),
        extensionsPage: EXTENSIONS_PAGE.chrome
      },
      firefox: {
        id: "firefox",
        label: "Firefox",
        executables: [env.ProgramFiles, env["PROGRAMFILES(X86)"]]
          .filter(Boolean)
          .map(root => joinFor("win32", root, "Mozilla Firefox", "firefox.exe")),
        userData: joinFor("win32", env.APPDATA || "", "Mozilla", "Firefox", "Profiles"),
        extensionsPage: EXTENSIONS_PAGE.firefox
      }
    };
  }
  const mac = platform === "darwin";
  const support = mac ? [home, "Library", "Application Support"] : [home, ".config"];
  return {
    edge: {
      id: "edge",
      label: "Edge",
      executables: mac
        ? ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
        : ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"],
      userData: joinFor(platform, ...support, mac ? "Microsoft Edge" : "microsoft-edge"),
      extensionsPage: EXTENSIONS_PAGE.edge
    },
    chrome: {
      id: "chrome",
      label: "Chrome",
      executables: mac
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"],
      userData: joinFor(platform, ...support, mac ? "Google" : "google-chrome", ...(mac ? ["Chrome"] : [])),
      extensionsPage: EXTENSIONS_PAGE.chrome
    },
    firefox: {
      id: "firefox",
      label: "Firefox",
      executables: mac ? ["/Applications/Firefox.app/Contents/MacOS/firefox"] : ["/usr/bin/firefox"],
      userData: mac
        ? joinFor(platform, home, "Library", "Application Support", "Firefox", "Profiles")
        : joinFor(platform, home, ".mozilla", "firefox"),
      extensionsPage: EXTENSIONS_PAGE.firefox
    }
  };
}

export function launchArgs(browser, profile, pageUrl) {
  if (browser === "firefox") {
    return ["-profile", profile.profilePath, "-new-tab", pageUrl];
  }
  return [`--profile-directory=${profile.profileDirectory}`, pageUrl];
}

export function chromiumExtensionId(preferences, expectedPath, samePath) {
  const settings = preferences?.extensions?.settings || {};
  const match = Object.entries(settings).find(
    ([, entry]) => typeof entry?.path === "string" && samePath(entry.path, expectedPath)
  );
  return match ? match[0] : null;
}

// A temporary Firefox add-on is stored as a filesystem path or a file:// URI.
export function firefoxAddonPath(addon) {
  if (typeof addon?.path === "string" && addon.path && !addon.path.includes("://")) {
    return addon.path;
  }
  const uri = addon?.rootURI || addon?.path;
  if (typeof uri !== "string" || !uri.startsWith("file:")) {
    return null;
  }
  try {
    let pathname = decodeURIComponent(new URL(uri).pathname);
    if (/^\/[A-Za-z]:\//.test(pathname)) {
      pathname = pathname.slice(1);
    }
    return pathname;
  } catch {
    return null;
  }
}

export function firefoxExtensionId(extensionsJson, expectedPath, samePath) {
  const addons = Array.isArray(extensionsJson?.addons) ? extensionsJson.addons : [];
  const match = addons.find(addon => {
    const addonPath = firefoxAddonPath(addon);
    return addonPath && samePath(addonPath, expectedPath);
  });
  return match?.id || null;
}

// An older install recorded only an Edge profile name. Fill in the rest from this machine.
export function resolvedProfile(saved, platform, env = {}) {
  const browser = BROWSER_IDS.includes(saved?.browser) ? saved.browser : "edge";
  const layout = browserLayout(platform, env)[browser];
  const profileDirectory = saved?.profileDirectory || "Default";
  const userData = saved?.userData || layout.userData;
  const tool = platform === "win32" ? path.win32 : path.posix;
  return {
    browser,
    label: layout.label,
    profileDirectory,
    userData,
    profilePath: saved?.profilePath || tool.join(userData, profileDirectory),
    executable: saved?.executable || null,
    extensionsPage: layout.extensionsPage
  };
}
