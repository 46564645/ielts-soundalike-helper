"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function harness(payload, state) {
  const attrs = new Map();
  const events = [];
  const listeners = new Map();
  const root = {
    setAttribute(name, value) { attrs.set(name, value); },
    getAttribute(name) { return attrs.get(name) || null; },
    removeAttribute(name) { attrs.delete(name); }
  };
  const app = { __vue_app__: { _instance: { setupState: { t: state } } } };
  const document = {
    documentElement: root,
    querySelector(selector) { return selector === "#app" ? app : null; },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
    dispatchEvent(event) { events.push(event.type); listeners.get(event.type)?.(event); }
  };
  class XHR {}
  XHR.prototype.open = function () {};
  XHR.prototype.send = function () {};
  const response = { clone: () => ({ json: async () => payload }) };
  const window = {
    fetch: async () => response,
    setInterval() { return 1; }, clearInterval() {}, addEventListener() {}
  };
  const context = {
    window, XMLHttpRequest: XHR, document, URL, WeakSet, Reflect,
    location: { hostname: "www.idictation.cn", pathname: "/home", origin: "https://www.idictation.cn", href: "https://www.idictation.cn/home" },
    CustomEvent: class { constructor(type) { this.type = type; } },
    Event: class { constructor(type) { this.type = type; } }, Date
  };
  vm.runInNewContext(fs.readFileSync("page-capture.js", "utf8"), context);
  return { window, attrs, events, document };
}

(async () => {
  const audio = (word) => `https://idictation-article.oss-cn-beijing.aliyuncs.com/wy_audios/${word}.mp3`;
  const rows = ["file", "command", "display"].map((word, index) => ({
    id: index + 1, word_id: index + 11, word,
    "phonetic-y": audio(word + "-uk"), "phonetic-m": audio(word + "-us")
  }));
  const runtimeWords = [rows[1], rows[2], rows[1], rows[0]];
  const h = harness({ values: { data: rows } }, {
    words: runtimeWords, currentWord: runtimeWords[1], currentIndex: 1, wordsCopy: runtimeWords.slice(),
    progress_num: 1, words_total: runtimeWords.length
  });
  await h.window.fetch("/api/study/lexicon/v1/list");
  await new Promise((resolve) => setImmediate(resolve));
  const catalog = JSON.parse(h.attrs.get("data-ielts-study-audio-catalog"));
  assert.equal(catalog.items.length, 3);
  assert.equal(catalog.items[1].word, "command");
  const queue = JSON.parse(h.attrs.get("data-ielts-study-runtime-queue"));
  assert.deepEqual(Array.from(queue.occurrences, (item) => item.word), ["command", "display", "command", "file"]);
  assert.equal(queue.currentIndex, 1);
  assert.equal(queue.source, "vue-runtime");
  assert.notEqual(queue.occurrences[0].occurrenceId, queue.occurrences[2].occurrenceId,
    "repeat positions stay distinct while sharing one word audio key");

  h.document.dispatchEvent({ type: "ielts-study-request-current-word" });
  const current = JSON.parse(h.attrs.get("data-ielts-study-current-word"));
  assert.equal(current.word, "display", "speaker click resolves the live dictation word");

  const walkman = harness({ values: { data: rows } }, {
    words: runtimeWords, currentWord: runtimeWords[1], currentIndex: 1
  });
  await walkman.window.fetch("/api/study/lexicon/v1/list");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(walkman.attrs.get("data-ielts-study-runtime-queue"), undefined,
    "walkman state without dictation fields must not be mistaken for the queue");
  console.log("Runtime study queue capture tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
