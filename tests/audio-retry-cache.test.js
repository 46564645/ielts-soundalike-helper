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
      if (shared.networkDown) throw new Error("Failed to fetch");
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
            if (shared.storageFail) {
              context.chrome.runtime.lastError = { message: "QUOTA_BYTES exceeded" };
              cb();
              context.chrome.runtime.lastError = null;
              return;
            }
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
  const savedAudio = shared.storage.get("wordAudioV2:us:again");
  assert.match(savedAudio, /^data:audio\/mpeg;base64,/);
  assert.equal(Buffer.from(savedAudio.split(",")[1], "base64").toString(), "audio test bytes");
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
  shared.networkDown = true;
  const failed = await first.send("PREFETCH_AUDIO_WORDS", ["unavailable"]);
  assert.equal(failed.statuses.unavailable, "failed");
  assert.match(failed.error, /网络或扩展权限限制/);
  shared.networkDown = false;
  const recovered = await first.send("PREFETCH_AUDIO_WORDS", ["unavailable"]);
  assert.equal(recovered.statuses.unavailable, "ready", "manual retry must recover without reinstalling");

  // A downloaded but unsaved audio file must not be counted as a network
  // failure. Once storage works, the same audio is persisted without a reload.
  const storageProblem = { storage: new Map(), downloadCount: 0, storageFail: true };
  const storageWorker = harness(storageProblem);
  const unsaved = await storageWorker.send("PREFETCH_AUDIO_WORDS", ["storageword"]);
  assert.equal(unsaved.count, 0);
  assert.equal(unsaved.memoryCount, 1);
  assert.equal(unsaved.statuses.storageword, "memory");
  assert.match(unsaved.storageReasons.storageword, /本地存储空间不足/);
  assert.equal(unsaved.failures["本地存储空间不足"], undefined,
    "local save problem is not a download failure");
  storageProblem.storageFail = false;
  const savedRetry = await storageWorker.send("PREFETCH_AUDIO_WORDS", ["storageword"]);
  assert.equal(savedRetry.count, 1);
  assert.equal(savedRetry.statuses.storageword, "ready");
  assert.equal(storageProblem.downloadCount, 1,
    "retry of local storage must reuse already downloaded audio");

  console.log("Audio retry cache and persistence tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
