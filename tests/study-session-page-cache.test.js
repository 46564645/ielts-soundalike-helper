"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const attributes = new Map();
const documentListeners = new Map();
const buttons = [];
const audios = [];
const storage = new Map();
const cacheEntries = new Map();
let objectUrls = 0;
let fetched = 0;

function makeButton() {
  const listeners = new Map();
  const button = {
    dataset: {}, style: {}, hidden: false, innerHTML: "", id: "", type: "",
    listeners,
    setAttribute() {}, removeAttribute() {},
    addEventListener(type, fn) { listeners.set(type, fn); },
    getBoundingClientRect() { return { left: 120, top: 240, width: 36, height: 36 }; },
    setPointerCapture() {}, releasePointerCapture() {},
    animate() {}
  };
  buttons.push(button);
  return button;
}

const root = {
  getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
  removeAttribute(name) { attributes.delete(name); },
  setAttribute(name, value) { attributes.set(name, value); },
  appendChild() {}
};

class FakeAudio {
  constructor(src) { this.src = src; this.preload = ""; this.currentTime = 0; this.played = false; audios.push(this); }
  setAttribute() {}
  play() { this.played = true; return Promise.resolve(); }
  pause() {}
}

const document = {
  documentElement: root,
  addEventListener(type, fn) { documentListeners.set(type, fn); },
  dispatchEvent() {},
  createElement() { return makeButton(); },
  querySelector() { return null; }
};

const cacheStore = {
  async match(url) { return cacheEntries.get(String(url)); },
  async put(url, response) { cacheEntries.set(String(url), response); },
  async keys() { return [...cacheEntries.keys()]; },
  async delete(url) { return cacheEntries.delete(String(url)); }
};

const chrome = {
  storage: {
    local: {
      get(defaults, callback) {
        const result = { ...defaults };
        for (const key of Object.keys(defaults)) if (storage.has(key)) result[key] = storage.get(key);
        callback(result);
      },
      set(values, callback) {
        for (const [key, value] of Object.entries(values)) storage.set(key, value);
        callback?.();
      }
    }
  },
  runtime: {
    lastError: { message: "no background worker" },
    sendMessage(_message, callback) { callback(undefined); }
  }
};

const context = {
  location: { hostname: "www.idictation.cn", pathname: "/home" },
  document, chrome, Audio: FakeAudio,
  Event: class { constructor(type) { this.type = type; } },
  setTimeout, clearTimeout, console,
  innerWidth: 390, innerHeight: 844,
  Response, Blob, Buffer,
  URL: {
    createObjectURL() { return `blob:mock/${++objectUrls}`; },
    revokeObjectURL() {}
  },
  caches: { open: async () => cacheStore },
  fetch: async () => {
    fetched += 1;
    return new Response(new Blob([Buffer.from("site audio")], { type: "audio/mpeg" }), { status: 200 });
  },
  IeltsPhonetics: { normalizeWord: (word) => String(word || "").trim().toLowerCase() }
};
context.globalThis = context;
context.window = context;
context.addEventListener = () => {};
vm.runInNewContext(fs.readFileSync("study-session.js", "utf8"), context);

function fire(type) {
  const handler = documentListeners.get(type);
  assert.equal(typeof handler, "function", `missing listener ${type}`);
  handler();
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

(async () => {
  const us = "https://idictation-article.oss-cn-beijing.aliyuncs.com/wy_audios/command-us.mp3";
  const second = "https://idictation-article.oss-cn-beijing.aliyuncs.com/wy_audios/second-us.mp3";

  attributes.set("data-ielts-study-audio-catalog", JSON.stringify({
    items: [
      { word: "command", ukAudio: "", usAudio: us },
      { word: "second", ukAudio: "", usAudio: second }
    ],
    observedAt: Date.now()
  }));
  fire("ielts-study-audio-catalog-ready");
  attributes.set("data-ielts-study-runtime-queue", JSON.stringify({
    occurrences: [
      { word: "command", occurrenceId: "0:1", ukAudio: "", usAudio: us },
      { word: "second", occurrenceId: "1:2", ukAudio: "", usAudio: second }
    ],
    currentIndex: 0, source: "test", observedAt: Date.now()
  }));
  fire("ielts-study-runtime-queue-ready");

  await context.IeltsStudySession.activate();
  await tick();

  assert.ok(fetched >= 2, "direct mode downloads the visible window into the page cache");
  assert.ok(cacheEntries.has(us), "US audio is cached in CacheStorage");
  assert.ok(cacheEntries.has(second), "next word audio is cached too");
  assert.match(audios.at(-1)?.src || "", /^blob:/, "playback uses the cached blob, not the network URL");

  attributes.set("data-ielts-study-runtime-queue", JSON.stringify({
    occurrences: [
      { word: "command", occurrenceId: "0:1", ukAudio: "", usAudio: us },
      { word: "second", occurrenceId: "1:2", ukAudio: "", usAudio: second }
    ],
    currentIndex: 1, source: "test", observedAt: Date.now()
  }));
  fire("ielts-study-runtime-queue-ready");
  await tick();

  assert.match(audios.at(-1)?.src || "", /^blob:/, "switching words reuses the cached audio offline");

  console.log("Study session page-cache (Orion direct mode) tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
