"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const bg = fs.readFileSync("background.js", "utf8");
const content = fs.readFileSync("content.js", "utf8");
let listener;
const vocabulary = [
  { word: "night", ukIpa: "naɪt", meaning: "夜晚" },
  { word: "knight", ukIpa: "naɪt", meaning: "骑士" },
  { word: "write", ukIpa: "raɪt", meaning: "书写" },
  { word: "right", ukIpa: "raɪt", meaning: "右边" }
];
const context = {
  importScripts() {},
  globalThis: null,
  IELTS_VOCABULARY: vocabulary,
  IeltsPhonetics: {
    normalizeWord: (word) => String(word || "").toLowerCase().trim(),
    tokenizeIpa: (ipa) => [String(ipa || "").replace(/[/\s]/g, "")].filter(Boolean)
  },
  IeltsCorrection: {},
  chrome: { runtime: {
    onMessage: { addListener(fn) { listener = fn; } }
  } }
};
context.globalThis = context;
vm.runInNewContext(bg, context);

function resolve(ipa, meaning) {
  let response;
  listener({ type: "RESOLVE_CLUE", ipa, meaning }, {}, (result) => { response = result; });
  return response;
}

const clear = resolve("naɪt", "骑士");
assert.equal(clear.found, true);
assert.equal(clear.word, "knight");
assert.equal(clear.audioMatchSafe, true, "unambiguous IPA and meaning may use cached audio");
const ambiguous = resolve("naɪt", "");
assert.equal(ambiguous.audioMatchSafe, false, "ambiguous homophones may not be taken over");
const unrelated = resolve("raɪt", "没听清");
assert.equal(unrelated.audioMatchSafe, false, "weak meaning cannot cause wrong pronunciation");
assert.equal(resolve("zzzzz", "无关词").found, false);

assert.match(content, /if \(response\.audioMatchSafe === true\) prepareStudyBackup/);
assert.match(content, /const isCached = \/\^data:/,
  "a remote URL must not be described as a successful local audio cache");
assert.match(content, /studyBackup\.word \+ "\\|" \+ settings\.accent/,
  "cache must be keyed by word and accent");
assert.match(content, /chooseStudyAudioMode\(value\)/);
assert.match(content, /ielts-native-audio-request-backup/);
assert.match(content, /data-ielts-helper-backup/);
assert.match(content, /native-unobserved/);
assert.doesNotMatch(content, /textContent = studyBackup\.word/,
  "the floating mode controls may not reveal the current spelling");
console.log("Current word eligibility and takeover UI tests passed");
