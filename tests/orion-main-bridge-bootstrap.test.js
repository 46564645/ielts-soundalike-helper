"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const orionManifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const safariManifest = JSON.parse(fs.readFileSync("safari/manifest.json", "utf8"));
const main = orionManifest.content_scripts.filter((entry) => entry.js.includes("page-capture.js"));
const fallback = orionManifest.content_scripts.filter((entry) => entry.js.includes("safari-page-loader.js"));
assert.equal(main.length, 1);
assert.equal(fallback.length, 1, "Orion must have a second main-world bridge loading path");
assert(orionManifest.web_accessible_resources.some((entry) => entry.resources.includes("page-capture.js")));
assert(safariManifest.content_scripts.some((entry) => entry.js.includes("safari-page-loader.js")));
assert.match(fs.readFileSync("page-capture.js", "utf8"), /__ieltsSoundalikeMainBridgeV211/);

const source = fs.readFileSync("safari-page-loader.js", "utf8");
let root = null;
const listeners = new Map();
let created = 0;
const document = {
  documentElement: null,
  head: null,
  querySelector() { return null; },
  addEventListener(type, callback) { listeners.set(type, callback); },
  createElement(type) {
    assert.equal(type, "script");
    created++;
    return {
      dataset: {},
      addEventListener() {},
      remove() {}
    };
  }
};
const context = {
  document,
  chrome: { runtime: { getURL: (file) => "extension://test/" + file } }
};
vm.runInNewContext(source, context);
assert.equal(created, 0, "no documentElement at document_start must not crash");
assert.equal(typeof listeners.get("readystatechange"), "function");

root = {
  getAttribute(name) {
    // An isolated-world script might set this attribute although the actual
    // website's HTMLAudioElement has not been hooked yet.
    return name === "data-ielts-native-audio-bridge" ? "html-media+speaker-v2" : null;
  },
  appendChild(script) { assert.match(script.src, /page-capture\.js$/); }
};
document.documentElement = root;
listeners.get("readystatechange")();
assert.equal(created, 1, "main-world fallback must still inject despite isolated-world marker");
listeners.get("DOMContentLoaded")();
assert.equal(created, 1, "late DOM event must not inject twice");

console.log("Orion/Safari page bridge fallback tests passed");
