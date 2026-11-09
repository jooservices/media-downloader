import vm from "node:vm";
import { runScript } from "./run-script.mjs";

// A very small DOM: just what the popup and the dashboard page scripts touch. Elements keep their
// children, text, listeners and flags so a test can click, type and read the result.
export class FakeElement {
  constructor(tag = "div", id = "") {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.placeholder = "";
    this.type = "";
    this._text = "";
  }

  get textContent() {
    return this._text + this.children.map(child => child.textContent).join("");
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes) {
    this._text = "";
    this.children = [...nodes];
  }

  addEventListener(type, listener) {
    this.listeners[type] = [...(this.listeners[type] || []), listener];
  }

  // Runs the listeners and resolves once the async ones have finished.
  async dispatch(type, event = {}) {
    const fired = { preventDefault() {}, ...event };
    await Promise.all((this.listeners[type] || []).map(listener => listener(fired)));
  }

  click() {
    return this.dispatch("click");
  }

  find(predicate) {
    for (const child of this.children) {
      if (predicate(child)) {
        return child;
      }
      const deeper = child.find(predicate);
      if (deeper) {
        return deeper;
      }
    }
    return null;
  }

  findAll(predicate) {
    return this.children.flatMap(child => [...(predicate(child) ? [child] : []), ...child.findAll(predicate)]);
  }
}

export const settle = async (turns = 12) => {
  for (let index = 0; index < turns; index++) {
    await new Promise(resolve => setImmediate(resolve));
  }
};

// Builds a page whose elements exist for every id given, and runs the scripts (relative paths) in it.
export function loadPage({ ids, scripts, chrome, navigatorLanguage = "en-US", extra = {}, translated = [] }) {
  const elements = Object.fromEntries(ids.map(id => [id, new FakeElement("div", id)]));
  const intervals = [];
  const document = {
    hidden: false,
    documentElement: { lang: "" },
    querySelector: selector => elements[selector.replace(/^#/, "")] || null,
    getElementById: id => elements[id] || null,
    querySelectorAll: selector =>
      translated.filter(node => (selector === "[data-i18n]" ? node.dataset.i18n : node.dataset.i18nPlaceholder)),
    createElement: tag => new FakeElement(tag)
  };
  const closed = { count: 0 };
  const sandbox = {
    document,
    chrome,
    navigator: { language: navigatorLanguage },
    URL,
    Promise,
    console,
    setInterval: (callback, ms) => intervals.push({ callback, ms }),
    ...extra
  };
  sandbox.window = sandbox;
  sandbox.window.close = () => {
    closed.count++;
  };
  return { elements, document, intervals, closed, sandbox, run: () => runAll(sandbox, scripts) };
}

function runAll(sandbox, scripts) {
  const context = vm.createContext(sandbox);
  for (const script of scripts) {
    runScript(script, context);
  }
  return context;
}
