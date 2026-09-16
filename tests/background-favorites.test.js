"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const listeners = [];
const localState = {};

global.importScripts = (...files) => {
  for (const file of files) require(path.resolve(__dirname, "..", file));
};
global.chrome = {
  runtime: {
    lastError: null,
    getURL: (file) => `chrome-extension://test/${file}`,
    onMessage: { addListener: (listener) => listeners.push(listener) }
  },
  storage: {
    local: {
      get(defaults, callback) {
        callback({ ...defaults, ...localState });
      },
      set(value, callback) {
        Object.assign(localState, value);
        callback?.();
      }
    }
  },
  tabs: { create: (_options, callback) => callback?.() }
};

require("../background.js");

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    const listener = listeners[0];
    const keepOpen = listener(message, {}, resolve);
    if (!keepOpen) reject(new Error(`message was not handled: ${message.type}`));
  });
}

test("a sound mapping is stored only after an explicit toggle", async () => {
  const before = await sendMessage({ type: "GET_LEARNING_STATE" });
  assert.equal(before.profile.favoriteCount, 0);

  const favorite = {
    phonemes: ["v"],
    grapheme: "v",
    word: "university",
    ipa: "juːnɪˈvɜːsəti",
    accent: "uk"
  };
  const saved = await sendMessage({ type: "TOGGLE_SOUND_SPELLING_FAVORITE", favorite });
  assert.equal(saved.saved, true);
  assert.equal(localState.soundSpellingFavoritesV1.length, 1);
  assert.equal(saved.learning.profile.ranking[0].sound, "/v/");
  assert.equal(saved.learning.profile.ranking[0].grapheme, "v");
  assert.equal(saved.learning.profile.ranking[0].words[0].word, "university");

  const removed = await sendMessage({ type: "TOGGLE_SOUND_SPELLING_FAVORITE", favorite });
  assert.equal(removed.saved, false);
  assert.equal(localState.soundSpellingFavoritesV1.length, 0);
});
