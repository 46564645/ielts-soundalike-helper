"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("content.js", "utf8");
const start = source.indexOf("function clampMobileHeight(value) {");
const end = source.indexOf("function clampHostPosition()", start);
assert(start >= 0 && end > start, "mobile height clamp must exist");
const clampSource = source.slice(start, end).trim();
const clamp = vm.runInNewContext("(" + clampSource + ")", {
  availableViewportHeight: () => 800
});
assert.equal(clamp(1), 60, "sheet should collapse to the visible handle");
assert.equal(clamp(60), 60);
assert.equal(clamp(160), 160, "free dragging to below the previous 220px limit");
assert.equal(clamp(220), 220);
assert.equal(clamp(700), 700);
assert.equal(clamp(1000), 792, "sheet should stop at the visible viewport");
assert.match(source, /\.panel\{width:100vw;[^\n]*min-height:60px;/,
  "mobile CSS must not restore the old 42vh min-height");
assert.doesNotMatch(source, /min-height:min\(340px,42dvh\)/);
assert.match(source, /moveEvent\.preventDefault\(\)/,
  "dragging the handle must not scroll the website");
assert.match(source, /\.body\{padding:10px[^\n]*overflow-y:scroll/,
  "long panel contents must be scrollable to the footer");
assert.match(source, /已到面板底部/);
assert.match(source, /下载未成功：/);
assert.match(source, /已下载但未持久保存：/);
console.log("Mobile free-drag and cache-diagnostics tests passed");
