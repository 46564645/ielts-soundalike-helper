"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../lib/phonetics.js");
require("../lib/correction.js");
require("../data/vocabulary.js");

const P = globalThis.IeltsPhonetics;
const C = globalThis.IeltsCorrection;

test("oxygen follows the sound-to-spelling route", () => {
  const result = C.analyzeSoundSpelling("oxigen", "oxygen", "/ˈɒksɪdʒən/");
  assert.deepEqual(
    result.blocks.map((block) => [block.sound, block.correct]),
    [
      ["/ɒ/", "o"],
      ["/ks/", "x"],
      ["/ɪ/", "y"],
      ["/dʒ/", "g"],
      ["/ən/", "en"]
    ]
  );
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].correctGrapheme, "y");
  assert.equal(result.issues[0].userGrapheme, "i");
  assert.match(result.issues[0].training, /“oxygen”中的 \/ɪ\/ → y/);
});

test("the first typed candidate is the closest spelling outside the correct answer", () => {
  const vocabulary = [
    { word: "cat", priority: true },
    { word: "coat", priority: true },
    { word: "cut", priority: false },
    { word: "dog", priority: true }
  ];
  const nearest = P.findClosestSpelling("cot", vocabulary, "cat");
  assert.equal(nearest.word, "cut");
  assert.equal(nearest.spellingDistance, 1);

  const exact = P.findClosestSpelling("coat", vocabulary, "cat");
  assert.equal(exact.word, "coat");
  assert.equal(exact.spellingDistance, 0);
});

test("every vocabulary entry keeps all letters and all available phonemes", () => {
  const validConfidence = new Set(["mapped", "estimated", "silent", "unmapped", "unknown"]);
  let mappedBlocks = 0;
  let totalBlocks = 0;
  for (const item of globalThis.IELTS_VOCABULARY) {
    const blocks = C.segmentSoundSpelling(item.word, item.ukIpa);
    const expectedWord = C.normalizeLetters(item.word);
    assert.equal(blocks.map((block) => block.grapheme).join(""), expectedWord, item.word);
    assert.deepEqual(blocks.flatMap((block) => block.phonemes), P.tokenizeIpa(item.ukIpa), item.word);
    assert.ok(blocks.every((block) => validConfidence.has(block.confidence)), item.word);
    if (item.ukIpa) {
      mappedBlocks += blocks.filter((block) => block.confidence === "mapped").length;
      totalBlocks += blocks.length;
    }
  }
  assert.ok(mappedBlocks / totalBlocks >= 0.95, `mapped coverage: ${mappedBlocks}/${totalBlocks}`);
});

test("irregular spellings are marked as estimates instead of claimed as rules", () => {
  const examples = [
    ["women", "/ˈwɪmɪn/"],
    ["colonel", "/ˈkɜːnəl/"],
    ["queue", "/kjuː/"]
  ];
  for (const [word, ipa] of examples) {
    const blocks = C.segmentSoundSpelling(word, ipa);
    assert.ok(blocks.some((block) => block.confidence !== "mapped"), word);
  }
});

test("a missing IPA is reported as unknown instead of calling every letter silent", () => {
  const result = C.analyzeSoundSpelling("oxigen", "oxygen", "");
  assert.ok(result.blocks.every((block) => block.sound === "无音标"));
  assert.ok(result.issues.every((issue) => issue.type === "unknown_sound"));
});

test("manual favorites rank the same sound-to-letter mapping by saved words", () => {
  const ranking = C.summarizeSoundFavorites([
    {
      id: "oxygen",
      sound: "/ɪ/",
      phonemes: ["ɪ"],
      grapheme: "y",
      word: "oxygen",
      ipa: "ˈɒksɪdʒən",
      accent: "uk",
      createdAt: 10
    },
    {
      id: "symbol",
      sound: "/ɪ/",
      phonemes: ["ɪ"],
      grapheme: "y",
      word: "symbol",
      ipa: "ˈsɪmbəl",
      accent: "uk",
      createdAt: 20
    },
    {
      id: "village",
      sound: "/ɪ/",
      phonemes: ["ɪ"],
      grapheme: "i",
      word: "village",
      ipa: "ˈvɪlɪdʒ",
      accent: "uk",
      createdAt: 30
    }
  ]);
  assert.equal(ranking.length, 2);
  assert.equal(ranking[0].sound, "/ɪ/");
  assert.equal(ranking[0].grapheme, "y");
  assert.equal(ranking[0].count, 2);
  assert.deepEqual(ranking[0].words.map((item) => item.word), ["symbol", "oxygen"]);
});
