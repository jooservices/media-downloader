import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import js from "@eslint/js";
import globals from "globals";
import nodePlugin from "eslint-plugin-n";
import sonarjs from "eslint-plugin-sonarjs";

// The service worker and the content scripts are classic scripts that share one global scope
// (importScripts / the manifest's js list), so a function declared in one file is used in another.
// Collect those top-level names so `no-undef` still catches a name that exists nowhere.
// Names declared with `let` are reassigned from other files too, so they are writable there.
const FUNCTION_DECLARATION = /^(?:async\s+)?function\s+(\w+)/gm;
const VARIABLE_DECLARATION = /^(const|let|var)\s+(\w+|\{[^}]+\})/gm;

function declaredNames(source) {
  const names = [];
  for (const match of source.matchAll(FUNCTION_DECLARATION)) {
    names.push({ name: match[1], writable: false });
  }
  for (const match of source.matchAll(VARIABLE_DECLARATION)) {
    const writable = match[1] !== "const";
    const target = match[2].replace(/^\{|\}$/g, "");
    for (const part of target.split(",")) {
      names.push({ name: part.trim(), writable });
    }
  }
  return names.filter(entry => entry.name);
}

function sharedScopeConfigs(directory, base) {
  const declared = new Map();
  const files = readdirSync(directory).filter(name => name.endsWith(".js"));
  for (const file of files) {
    for (const { name, writable } of declaredNames(readFileSync(path.join(directory, file), "utf8"))) {
      declared.set(name, { file, writable });
    }
  }
  return files.map(file => {
    const others = {};
    for (const [name, info] of declared) {
      if (info.file !== file) {
        others[name] = info.writable ? "writable" : "readonly";
      }
    }
    return {
      files: [`${directory}/${file}`],
      languageOptions: { sourceType: "script", globals: { ...base, ...others } }
    };
  });
}

const extensionGlobals = {
  chrome: "readonly",
  PageMediaLib: "readonly",
  PageMediaParsers: "writable",
  PageMediaSaver: "writable",
  PageMediaDetection: "writable"
};

const strictRules = {
  eqeqeq: ["error", "always"],
  curly: ["error", "all"],
  "no-var": "error",
  "prefer-const": "error",
  "no-eval": "error",
  "no-implied-eval": "error",
  "no-new-func": "error",
  "no-throw-literal": "error",
  "no-shadow": "error",
  "no-unused-vars": ["error", { vars: "local", args: "after-used", caughtErrors: "all" }],
  "no-useless-catch": "error",
  "no-return-await": "error",
  "require-await": "error",
  complexity: ["error", { max: 20 }],
  "max-depth": ["error", 5],
  "max-params": ["error", 6]
};

export default [
  { ignores: ["node_modules/**", "build/**", "dist/**", "coverage/**", "tests/fixtures/**", "package-lock.json"] },
  js.configs.recommended,
  sonarjs.configs.recommended,
  {
    rules: strictRules
  },
  {
    // Shared rules for the page, the content scripts and the service worker (no Node APIs).
    files: ["lib/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        module: "writable",
        require: "readonly",
        ...extensionGlobals
      }
    }
  },
  ...sharedScopeConfigs("src/background", { ...globals.serviceworker, ...extensionGlobals }),
  {
    files: ["src/content/**/*.js"],
    languageOptions: { sourceType: "script", globals: { ...globals.browser, ...extensionGlobals } }
  },
  {
    files: ["src/page/**/*.js"],
    languageOptions: { sourceType: "script", globals: { ...globals.browser, ...extensionGlobals } }
  },
  {
    files: ["src/popup/**/*.js"],
    languageOptions: { sourceType: "script", globals: { ...globals.browser, ...extensionGlobals } }
  },
  {
    // The dashboard's helpers are classic scripts that also load in Node for their tests.
    files: ["src/options/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...extensionGlobals,
        PageMediaOptions: "writable",
        PageMediaStrings: "writable",
        module: "writable"
      }
    }
  },
  {
    files: ["cli/**/*.mjs", "tools/**/*.mjs", "tests/**/*.mjs", "eslint.config.mjs", ".github/**/*.mjs"],
    ...nodePlugin.configs["flat/recommended-module"],
    languageOptions: { sourceType: "module", globals: { ...globals.node } }
  },
  {
    files: ["cli/**/*.mjs", "tools/**/*.mjs", "tests/**/*.mjs", "eslint.config.mjs", ".github/**/*.mjs"],
    rules: { "n/no-unsupported-features/node-builtins": ["error", { version: ">=22" }] }
  },
  {
    // Tests build fake pages and fake DOMs on purpose.
    files: ["tests/**/*.mjs"],
    // The tests load the extension's classic scripts into fake pages with node:vm and fake
    // the async browser APIs with plain synchronous functions.
    rules: {
      "sonarjs/no-duplicate-string": "off",
      "sonarjs/no-hardcoded-passwords": "off",
      "sonarjs/code-eval": "off",
      "sonarjs/no-clear-text-protocols": "off",
      "sonarjs/no-nested-functions": "off",
      "require-await": "off"
    }
  }
];
