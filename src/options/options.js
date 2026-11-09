// The dashboard's page script: it only connects the page to the extension (read the state, send what
// the user does). What is shown and how it is judged lives in options-model.js and the extension.
(function initOptionsPage() {
  "use strict";

  const { parseLinks, describeJob, summarize, signInNeeded, settingsToForm, formToSettings } = PageMediaOptions;
  const t = PageMediaStrings.translator(chrome.i18n?.getUILanguage?.() || navigator.language);
  const POLL_MS = 2000;

  const el = id => document.getElementById(id);
  const send = message => chrome.runtime.sendMessage(message);
  let settingsEdited = false;
  let latest = null;

  function translatePage() {
    document.documentElement.lang = PageMediaStrings.pick(chrome.i18n?.getUILanguage?.() || navigator.language);
    for (const node of document.querySelectorAll("[data-i18n]")) {
      node.textContent = t(node.dataset.i18n);
    }
    for (const node of document.querySelectorAll("[data-i18n-placeholder]")) {
      node.placeholder = t(node.dataset.i18nPlaceholder);
    }
  }

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function renderSignIn(snapshot) {
    const needed = signInNeeded(snapshot.login, snapshot.jobs);
    el("sign-in").hidden = needed.length === 0;
    const list = el("sign-in-list");
    list.replaceChildren();
    for (const site of needed) {
      const item = make("li", "row");
      item.append(make("span", "", t("signInNeeded", { site: site.label })));
      const open = make("button", "small", t("signInButton", { site: site.label }));
      open.type = "button";
      open.addEventListener("click", () => chrome.tabs.create({ url: site.url }));
      item.append(open);
      list.append(item);
    }
  }

  function renderSites(snapshot) {
    const chips = el("sites");
    chips.replaceChildren();
    for (const info of Object.values(snapshot.login)) {
      const text = `${info.label}: ${info.signedIn ? t("siteStatusIn") : t("siteStatusOut")}`;
      chips.append(make("li", `chip ${info.signedIn ? "ok" : "bad"}`, text));
    }
  }

  function jobActions(row) {
    const box = make("div", "job-actions");
    for (const action of row.actions) {
      const button = make("button", "small secondary", t(`action_${action}`));
      button.type = "button";
      button.addEventListener("click", () => act(action, row.id));
      box.append(button);
    }
    return box;
  }

  function renderJobs(snapshot) {
    const labels = Object.fromEntries(Object.entries(snapshot.login).map(([site, info]) => [site, info.label]));
    const list = el("jobs");
    list.replaceChildren();
    for (const job of snapshot.jobs) {
      const row = describeJob(job, labels);
      const item = make("li");
      const title = make("div", "job-title", `${row.site} · ${row.account}`);
      title.append(make("span", `state ${row.tone}`, t(`state_${row.state}`)));
      item.append(title, jobActions(row));
      const files = row.files ? `${t("files", { count: row.files })} · ` : "";
      item.append(make("div", "job-detail", `${files}${row.detail}`));
      list.append(item);
    }
    el("empty").hidden = snapshot.jobs.length > 0;
    el("summary").textContent = t("summary", summarize(snapshot.jobs));
  }

  function renderControls(snapshot) {
    el("pause").textContent = snapshot.paused ? t("resume") : t("pause");
    el("paused-note").hidden = !snapshot.paused;
  }

  function renderSettings(snapshot) {
    if (settingsEdited) {
      return;
    }
    const form = settingsToForm(snapshot.settings);
    el("workers-x").value = form.workers.x;
    el("workers-instagram").value = form.workers.instagram;
    el("workers-facebook").value = form.workers.facebook;
    el("workers-tiktok").value = form.workers.tiktok;
    el("delay-min").value = form.delayMin;
    el("delay-max").value = form.delayMax;
    el("attempts").value = form.maxAttempts;
    el("unlimited").checked = form.unlimited;
    el("limit").value = form.limit;
    el("limit").disabled = form.unlimited;
  }

  function render(snapshot) {
    latest = snapshot;
    renderSignIn(snapshot);
    renderSites(snapshot);
    renderJobs(snapshot);
    renderControls(snapshot);
    renderSettings(snapshot);
  }

  async function refresh() {
    const reply = await send({ type: "QUEUE_STATE" }).catch(() => null);
    if (reply?.ok) {
      render(reply);
    }
  }

  const say = (id, text) => {
    el(id).textContent = text;
  };

  async function act(action, jobId) {
    const reply = await send({ type: "QUEUE_ACTION", action, jobId });
    if (!reply?.ok) {
      say("add-result", t("problem", { error: reply?.error }));
    }
    refresh();
  }

  async function addLinks() {
    const urls = parseLinks(el("links").value);
    if (!urls.length) {
      return;
    }
    const reply = await send({ type: "QUEUE_ADD", urls });
    if (!reply?.ok) {
      say("add-result", t("problem", { error: reply?.error }));
      return;
    }
    el("links").value = "";
    const skipped = reply.skipped.length ? ` ${t("skipped", { count: reply.skipped.length })}` : "";
    say("add-result", `${t("added", { count: reply.created.length })}${skipped}`);
    refresh();
  }

  function readForm() {
    return formToSettings({
      workers: {
        x: el("workers-x").value,
        instagram: el("workers-instagram").value,
        facebook: el("workers-facebook").value,
        tiktok: el("workers-tiktok").value
      },
      delayMin: el("delay-min").value,
      delayMax: el("delay-max").value,
      maxAttempts: el("attempts").value,
      unlimited: el("unlimited").checked,
      limit: el("limit").value
    });
  }

  async function saveSettings(event) {
    event.preventDefault();
    const reply = await send({ type: "QUEUE_SETTINGS_SAVE", settings: readForm() });
    if (reply?.ok) {
      settingsEdited = false;
      say("settings-result", t("saved"));
      refresh();
    } else {
      say("settings-result", t("problem", { error: reply?.error }));
    }
  }

  function bind() {
    el("add").addEventListener("click", addLinks);
    el("settings").addEventListener("submit", saveSettings);
    el("settings").addEventListener("input", () => {
      settingsEdited = true;
      el("limit").disabled = el("unlimited").checked;
    });
    el("pause").addEventListener("click", async () => {
      await send({ type: "QUEUE_PAUSE", paused: !latest?.paused });
      refresh();
    });
    el("clear").addEventListener("click", () => act("clear-finished"));
    el("signed-in").addEventListener("click", async () => {
      await send({ type: "QUEUE_SIGNED_IN" });
      refresh();
    });
  }

  translatePage();
  bind();
  refresh();
  setInterval(() => {
    if (!document.hidden) {
      refresh();
    }
  }, POLL_MS);
})();
