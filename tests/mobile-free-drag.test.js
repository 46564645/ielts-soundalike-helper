"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const content = fs.readFileSync("content.js", "utf8");
const session = fs.readFileSync("study-session.js", "utf8");
const start = content.indexOf("function clampMobileHeight(value) {");
const end = content.indexOf("function clampHostPosition()", start);
assert(start >= 0 && end > start);
const clamp = vm.runInNewContext("(" + content.slice(start, end).trim() + ")", {
  availableViewportHeight: () => 800
});
assert.equal(clamp(1), 60);
assert.equal(clamp(160), 160);
assert.equal(clamp(1000), 792);
assert.match(content, /\.panel\{width:100vw;[^\n]*min-height:60px;/);
assert.match(content, /\.body\{padding:10px[^\n]*overflow-y:scroll/);
assert.match(session, /Math\.hypot\(dx, dy\) > 6/,
  "a short tap and a drag use different interactions");
assert.match(session, /visualViewport/,
  "speaker position follows the visible area above the iPhone keyboard");
assert.match(session, /touchstart[\s\S]*passive: false/);
assert.doesNotMatch(session, /\.blur\(|\.focus\(/,
  "speaker interaction must preserve the existing input and caret");
console.log("Mobile free-drag and focus-preservation tests passed");
