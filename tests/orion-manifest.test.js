"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const edge = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const orion = JSON.parse(fs.readFileSync(path.join(root, "orion", "manifest.json"), "utf8"));

assert.equal(orion.manifest_version, 3);
assert.equal(orion.version, edge.version, "Orion build must share the desktop version");
assert.deepEqual(orion.permissions, ["storage", "activeTab"], "Orion iOS rejects or ignores Chromium-only permissions");

for (const entry of orion.content_scripts) {
  assert.equal(entry.world, undefined, "Orion manifest must not rely on Chromium's MAIN world key");
}

const loader = orion.content_scripts.find((entry) => entry.js?.includes("safari-page-loader.js"));
assert.ok(loader, "Orion needs the page bridge loader");
assert.equal(loader.run_at, "document_start");

const pageScripts = orion.content_scripts.find((entry) => entry.js?.includes("study-session.js"));
assert.ok(pageScripts, "Orion content scripts must include the study session module");
assert.ok(pageScripts.js.includes("lib/phonetics.js"));
assert.ok(pageScripts.js.includes("content.js"));

const publicResources = orion.web_accessible_resources.flatMap((entry) => entry.resources || []);
assert.ok(publicResources.includes("page-capture.js"));
assert.ok(publicResources.includes("audio/phonemes/kk/*.mp3"));
assert.ok(!orion.permissions.includes("unlimitedStorage"));
assert.ok(!orion.permissions.includes("tabs"));

const referenced = new Set();
if (orion.background?.service_worker) referenced.add(orion.background.service_worker);
for (const entry of orion.content_scripts) for (const file of entry.js || []) referenced.add(file);
for (const entry of orion.web_accessible_resources) {
  for (const file of entry.resources || []) if (!file.includes("*")) referenced.add(file);
}
referenced.add(orion.action.default_popup);
referenced.add(orion.options_page);
for (const file of referenced) {
  assert.ok(fs.existsSync(path.join(root, file)), `Orion manifest references missing file: ${file}`);
}

assert.ok(fs.existsSync(path.join(root, "scripts", "build-orion.sh")), "Orion packaging script is required");
console.log("Orion manifest compatibility tests passed");
