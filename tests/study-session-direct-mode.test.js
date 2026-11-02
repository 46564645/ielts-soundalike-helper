"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const attributes = new Map();
const documentListeners = new Map();
const buttons = [];
const audios = [];
const storage = new Map();

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
  dispatchEvent() {},
  createElement() { return makeButton(); },
  querySelector() { return null; }
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

(async () => {
  const us = "https://idictation-article.oss-cn-beijing.aliyuncs.com/wy_audios/command-us.mp3";
  const uk = "https://idictation-article.oss-cn-beijing.aliyuncs.com/wy_audios/command-uk.mp3";

  attributes.set("data-ielts-study-audio-catalog", JSON.stringify({
    items: [{ word: "command", ukAudio: uk, usAudio: us }], observedAt: Date.now()
  }));
  fire("ielts-study-audio-catalog-ready");
  attributes.set("data-ielts-study-runtime-queue", JSON.stringify({
    occurrences: [{ word: "command", occurrenceId: "0:1", ukAudio: uk, usAudio: us }],
    currentIndex: 0, source: "test", observedAt: Date.now()
  }));
  fire("ielts-study-runtime-queue-ready");

  await context.IeltsStudySession.activate();
  const status = context.IeltsStudySession.getStatus();
  assert.equal(status.active, true, "speaker session must survive a missing background worker");
  assert.equal(status.phase, "ready");
  assert.equal(status.ready, 1);
  assert.equal(audios.at(-1)?.src, us, "direct mode plays the site's US audio URL");

  context.IeltsStudySession.setAccent("uk");
  assert.equal(audios.at(-1)?.src, uk, "accent switch reloads the UK URL");

  const speaker = buttons.at(-1);
  assert.equal(speaker.hidden, false);
  const event = {
    pointerId: 1, clientX: 130, clientY: 250,
    preventDefault() {}, stopPropagation() {}
  };
  speaker.listeners.get("pointerdown")(event);
  speaker.listeners.get("pointerup")(event);
  assert.equal(audios.at(-1)?.played, true, "tapping the speaker plays the direct URL");

  console.log("Study session direct-mode (Orion no-background) tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
