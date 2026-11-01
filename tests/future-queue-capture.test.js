"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function createHarness(payload) {
  const attrs = new Map();
  const dispatched = [];
  const documentElement = {
    setAttribute(key, value) { attrs.set(key, value); },
    getAttribute(key) { return attrs.get(key) || null; }
  };
  const listeners = new Map();
  const document = {
    documentElement,
    addEventListener(type, listener) {
      const group = listeners.get(type) || [];
      group.push(listener);
      listeners.set(type, group);
    },
    dispatchEvent(event) {
      dispatched.push(event.type);
      for (const listener of listeners.get(event.type) || []) listener(event);
    }
  };
  class MockXHR {}
  MockXHR.prototype.open = function () {};
  MockXHR.prototype.send = function () {};
  MockXHR.prototype.addEventListener = function () {};
  const response = {
    headers: { get: () => "application/json" },
    clone() { return { json: async () => payload }; }
  };
  const context = {
    window: { fetch: async () => response },
    XMLHttpRequest: MockXHR,
    document,
    CustomEvent: class { constructor(type) { this.type = type; } },
    Event: class { constructor(type) { this.type = type; } },
    URL,
    location: {
      hostname: "www.idictation.cn",
      pathname: "/home",
      origin: "https://www.idictation.cn",
      href: "https://www.idictation.cn/home"
    },
    Date
  };
  vm.runInNewContext(fs.readFileSync("page-capture.js", "utf8"), context);
  return { context, attrs, dispatched };
}

(async () => {
  const dataset = { data: { words: [
    { word: "apple" }, { word: "banana" }, { word: "cat" }, { word: "dog" }
  ] } };
  const h = createHarness(dataset);
  await h.context.window.fetch("/api/study/word/list");
  await new Promise((resolve) => setImmediate(resolve));
  const queue = JSON.parse(h.attrs.get("data-ielts-future-audio-queue"));
  assert.deepEqual(Array.from(queue.words), ["apple", "banana", "cat", "dog"]);
  assert.equal(h.dispatched.filter((e) => e === "ielts-future-audio-queue-ready").length, 1);

  // An incorrect answer can return several times in the same session.
  const retries = createHarness({ data: [{ word: "again" }, { word: "again" }, { word: "again" }] });
  await retries.context.window.fetch("/api/study/word/list");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    Array.from(JSON.parse(retries.attrs.get("data-ielts-future-audio-queue")).words),
    ["again"],
    "repeated review words should be captured once for preloading"
  );

  const single = createHarness({ data: [{ word: "apple" }] });
  await single.context.window.fetch("/api/study/word/list");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(single.attrs.get("data-ielts-future-audio-queue"), undefined);

  const wrongEndpoint = createHarness(dataset);
  await wrongEndpoint.context.window.fetch("/api/account/profile");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(wrongEndpoint.attrs.get("data-ielts-future-audio-queue"), undefined);

  const max = createHarness({ list: Array.from({ length: 90 }, (_, i) => ({ word: "word" + i })) });
  await max.context.window.fetch("/api/study/word/list");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(max.attrs.get("data-ielts-future-audio-queue"), undefined, "numbered tokens are not considered ordinary vocabulary");

  console.log("Future study queue capture tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
