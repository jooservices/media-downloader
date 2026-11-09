import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../../cli/config.mjs";

const plain = value => JSON.parse(JSON.stringify(value));

test("notify: off by default, https or local http only, with a format and a choice of events", () => {
  assert.equal(parseConfig({}).notify, null);
  assert.equal(parseConfig({ notify: null }).notify, null);
  assert.deepEqual(plain(parseConfig({ notify: { url: "https://ntfy.sh/topic" } }).notify), {
    url: "https://ntfy.sh/topic",
    format: "json",
    events: ["new-content", "problem"]
  });
  const twice = parseConfig({
    notify: { url: "http://127.0.0.1:8080/hook", format: "text", events: ["problem", "problem"] }
  });
  assert.deepEqual(plain(twice.notify.events), ["problem"]);
  assert.equal(parseConfig({ notify: { url: "http://localhost/x" } }).notify.url, "http://localhost/x");
  assert.equal(parseConfig({ notify: { url: "http://[::1]:9/x" } }).notify.url, "http://[::1]:9/x");
});

test("notify: anything else is refused with a message that names the setting", () => {
  for (const bad of [
    "yes",
    [],
    {},
    { url: 5 },
    { url: "http://example.com/x" },
    { url: "not a url" },
    { url: "https://ok.example/x", format: "xml" },
    { url: "https://ok.example/x", events: [] },
    { url: "https://ok.example/x", events: ["other"] },
    { url: "https://ok.example/x", events: "problem" }
  ]) {
    assert.throws(() => parseConfig({ notify: bad }), /notify/, JSON.stringify(bad));
  }
});
