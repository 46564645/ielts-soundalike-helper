"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");

const bridge = fs.readFileSync("page-capture.js", "utf8");
const session = fs.readFileSync("study-session.js", "utf8");
assert.match(bridge, /return nativePlay\.apply\(this, args\)/,
  "observing native audio must preserve the website play result");
assert.doesNotMatch(bridge, /audio-takeover-mode|activateFallback|stopImmediatePropagation/,
  "the extension no longer automatically intercepts website playback");
assert.match(bridge, /ielts-study-manual-stop-native/);
assert.match(bridge, /activeStudyMedia\?\.pause\(\)/,
  "a manual cache tap may pause only the observed study player");
assert.match(session, /document\.dispatchEvent\(new Event\("ielts-study-manual-stop-native"\)\)/);
assert.doesNotMatch(session, /setInterval\([^)]*play|autoplay/i,
  "the helper never starts audio without a manual speaker action");
console.log("Manual audio coexistence tests passed");
