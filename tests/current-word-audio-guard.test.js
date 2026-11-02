"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const bg = fs.readFileSync("background.js", "utf8");
const content = fs.readFileSync("content.js", "utf8");
const session = fs.readFileSync("study-session.js", "utf8");
let listener;
const vocabulary = [
  { word: "night", ukIpa: "naɪt", meaning: "夜晚" },
  { word: "knight", ukIpa: "naɪt", meaning: "骑士" }
];
const context = {
  importScripts() {}, globalThis: null, IELTS_VOCABULARY: vocabulary,
  IeltsPhonetics: {
    normalizeWord: (word) => String(word || "").toLowerCase().trim(),
    tokenizeIpa: (ipa) => [String(ipa || "").replace(/[/\s]/g, "")].filter(Boolean)
  },
  IeltsCorrection: {},
  chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } }
};
context.globalThis = context;
vm.runInNewContext(bg, context);
let response;
listener({ type: "RESOLVE_CLUE", ipa: "naɪt", meaning: "骑士" }, {}, (value) => { response = value; });
assert.equal(response.word, "knight");
assert.equal(response.audioMatchSafe, true);

assert.match(content, /IeltsStudySession\?\.activate\(\)/,
  "the cache starts only when the first judged result is revealed");
assert.match(content, /IeltsStudySession\?\.setCurrentWord\(word\)/);
assert.doesNotMatch(content, /class="current-backup-play"|class="future-cache-status"/,
  "the analysis panel must not duplicate the persistent speaker or cache panel");
assert.match(session, /button\.id = "ielts-manual-study-speaker"/);
assert.match(session, /pointerdown[\s\S]*event\.preventDefault\(\)/,
  "touching the speaker must not move focus away from the dictation input");
assert.match(session, /GET_STUDY_SESSION_AUDIO/);
assert.doesNotMatch(session, /SpeechSynthesisUtterance|speechSynthesis/,
  "manual cache playback must not silently fall back to device TTS");
console.log("Current word manual-audio guard tests passed");
