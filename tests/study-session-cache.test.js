"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

let messageListener;
let removedListener;
let downloads = 0;
const storage = new Map();
const context = {
  importScripts() {}, globalThis: null, Blob, Buffer, Response, URL, AbortController,
  setTimeout, clearTimeout, console,
  fetch: async () => {
    downloads++;
    return new Response(new Blob([Buffer.from("site audio")], { type: "audio/mpeg" }), { status: 200 });
  },
  chrome: {
    runtime: { lastError: null, onMessage: { addListener(fn) { messageListener = fn; } } },
    tabs: {
      onRemoved: { addListener(fn) { removedListener = fn; } },
      query(_query, callback) { callback([]); },
      create(_options, callback) { callback?.(); }
    },
    storage: { local: {
      get(defaults, callback) {
        const result = { ...defaults };
        for (const key of Object.keys(defaults)) if (storage.has(key)) result[key] = storage.get(key);
        callback(result);
      },
      set(values, callback) { for (const [key, value] of Object.entries(values)) storage.set(key, value); callback?.(); },
      remove(keys, callback) { for (const key of keys) storage.delete(key); callback?.(); }
    } }
  },
  IELTS_VOCABULARY: [], IeltsCorrection: {},
  IeltsPhonetics: { normalizeWord: (word) => String(word || "").trim().toLowerCase() }
};
context.globalThis = context;
vm.runInNewContext(fs.readFileSync("background.js", "utf8"), context);

function send(message, tabId = 42) {
  return new Promise((resolve, reject) => {
    const handled = messageListener(message, { tab: { id: tabId } }, resolve);
    if (!handled) reject(new Error("message was not handled"));
  });
}

(async () => {
  const started = await send({ type: "START_STUDY_AUDIO_SESSION" });
  assert.equal(started.ok, true);
  const url = "https://idictation-article.oss-cn-beijing.aliyuncs.com/wy_audios/command.mp3";
  const prefetched = await send({
    type: "PREFETCH_STUDY_SESSION_AUDIO", sessionId: started.sessionId, accent: "us",
    items: [{ word: "command", audioUrl: url }, { word: "command", audioUrl: url }]
  });
  assert.equal(prefetched.count, 1);
  assert.equal(downloads, 1, "a repeated occurrence reuses one downloaded file");
  const cached = await send({
    type: "GET_STUDY_SESSION_AUDIO", sessionId: started.sessionId, accent: "us", word: "command"
  });
  assert.equal(cached.available, true);
  assert.match(cached.audioUrl, /^data:audio\/mpeg;base64,/);
  removedListener(42);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal([...storage.keys()].some((key) => key.includes(started.sessionId)), false,
    "closing the exercise tab removes only its session namespace");
  console.log("Study session cache lifecycle tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
