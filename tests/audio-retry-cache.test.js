"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("background.js", "utf8");
function harness(shared) {
  let listener;
  const context = {
    importScripts() {},
    Blob,
    Buffer,
    Response,
    AbortSignal,
    URL,
    console,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async () => {
      shared.downloadCount++;
      return { ok: true, blob: async () => new Blob([Buffer.from("audio test bytes")], { type: "audio/mpeg" }) };
    },
    chrome: {
      runtime: {
        lastError: null,
        onMessage: { addListener(fn) { listener = fn; } }
      },
      storage: {
        local: {
          get(defaults, cb) {
            const result = { ...defaults };
            for (const key of Object.keys(defaults)) if (shared.storage.has(key)) result[key] = shared.storage.get(key);
            cb(result);
          },
          set(values, cb) {
            for (const [key, value] of Object.entries(values)) shared.storage.set(key, value);
            cb();
          },
          remove(keys, cb) {
            for (const key of keys) shared.storage.delete(key);
            cb();
          }
        }
      }
    },
    IELTs_CORPUS_SUMMARY: {},
    IELTS_VOCABULARY: [],
    IeltsPhonetics: { normalizeWord: (s) => String(s || "").trim().toLowerCase() },
    IeltsCorrection: {}
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return {
    send(type, words, accent = "us") {
      return new Promise((resolve, reject) => {
        const handled = listener({ type, words, accent }, {}, resolve);
        if (!handled) reject(new Error("Message was not handled"));
      });
    }
  };
}

(async () => {
  const shared = { storage: new Map(), downloadCount: 0 };
  const first = harness(shared);
  const a = await first.send("PREFETCH_AUDIO_WORDS", ["Again", "again", "mistake"]);
  assert.equal(a.total, 2, "duplicates in a retry queue must be deduplicated");
  assert.equal(a.count, 2, "downloaded audio should be persisted");
  assert.equal(shared.downloadCount, 2);
  const b = await first.send("PREFETCH_AUDIO_WORDS", ["again", "mistake"]);
  assert.equal(b.count, 2);
  assert.equal(shared.downloadCount, 2, "retry must not re-download already cached words");
  const rebooted = harness(shared);
  const c = await rebooted.send("PREFETCH_AUDIO_WORDS", ["again", "mistake"]);
  assert.equal(c.count, 2);
  assert.equal(shared.downloadCount, 2, "cache must survive a suspended iOS service worker");
  const parallel = harness(shared);
  const [d, e] = await Promise.all([
    parallel.send("PREFETCH_AUDIO_WORDS", ["fresh"]),
    parallel.send("PREFETCH_AUDIO_WORDS", ["fresh"])
  ]);
  assert.equal(d.count, 1);
  assert.equal(e.count, 1);
  assert.equal(shared.downloadCount, 3, "concurrent retry requests must share one download");
  console.log("Audio retry cache and persistence tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
