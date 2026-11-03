"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const attributes = new Map();
const documentListeners = new Map();
const buttons = [];
const audios = [];
const storage = new Map();
let visibleWord = null;

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
  constructor(src) {
    this.src = src;
    this.preload = "";
    this.currentTime = 0;
    this.played = false;
    audios.push(this);
  }
  setAttribute() {}
  play() { this.played = true; return Promise.resolve(); }
  pause() {}
}

const document = {
  documentElement: root,
  addEventListener(type, fn) { documentListeners.set(type, fn); },
  removeEventListener(type) { documentListeners.delete(type); },
  dispatchEvent() {},
  createElement() { return makeButton(); },
  querySelector(selector) {
    return selector === "main .error-word-study > span" ? visibleWord : null;
  },
  querySelectorAll() { return []; }
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
    lastError: null,
    sendMessage(_message, callback) {
      chrome.runtime.lastError = { message: "no background worker" };
      callback(undefined);
      chrome.runtime.lastError = null;
    }
  }
};

const context = {
  location: { hostname: "www.idictation.cn", pathname: "/home" },
  document, chrome, Audio: FakeAudio,
  Event: class { constructor(type) { this.type = type; } },
  setTimeout, clearTimeout, console,
  innerWidth: 390, innerHeight: 844,
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const command = "https://idictation-article.oss-cn-beijing.aliyuncs.com/wy_audios/command-us.mp3";
  const second = "https://idictation-article.oss-cn-beijing.aliyuncs.com/wy_audios/second-us.mp3";

  attributes.set("data-ielts-study-audio-catalog", JSON.stringify({
    items: [
      { word: "command", ukAudio: "", usAudio: command },
      { word: "second", ukAudio: "", usAudio: second }
    ],
    observedAt: Date.now()
  }));
  fire("ielts-study-audio-catalog-ready");
  attributes.set("data-ielts-study-runtime-queue", JSON.stringify({
    occurrences: [
      { word: "command", occurrenceId: "0:1", ukAudio: "", usAudio: command },
      { word: "second", occurrenceId: "1:2", ukAudio: "", usAudio: second }
    ],
    currentIndex: 0, source: "test", observedAt: Date.now()
  }));
  fire("ielts-study-runtime-queue-ready");

  await context.IeltsStudySession.activate();
  await wait(20);
  assert.equal(audios.at(-1)?.src, command, "queue preloads the current word first");

  // The queue still says "command", but the page already shows "second".
  visibleWord = { textContent: "second" };
  const speaker = buttons.at(-1);
  const event = { pointerId: 1, clientX: 130, clientY: 250, preventDefault() {}, stopPropagation() {} };
  speaker.listeners.get("pointerdown")(event);
  speaker.listeners.get("pointerup")(event);
  await wait(180);

  assert.equal(audios.at(-1)?.src, second, "the speaker click follows the word on screen, not the stale queue");
  assert.equal(audios.at(-1)?.played, true);

  console.log("Study session click-time word resolution tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
