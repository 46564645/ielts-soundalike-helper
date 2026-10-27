"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

test("Safari manifest keeps the required hosts without unsupported TTS permission", () => {
  const edgeManifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const safariManifest = JSON.parse(fs.readFileSync(path.join(root, "safari", "manifest.json"), "utf8"));

  assert.equal(safariManifest.manifest_version, 3);
  assert.equal(safariManifest.version, edgeManifest.version);
  assert.equal(safariManifest.browser_specific_settings.safari.strict_min_version, "15.4");
  assert.ok(!safariManifest.permissions.includes("tts"));
  assert.ok(safariManifest.host_permissions.includes("https://ielts.itongzhuo.com/*"));
  assert.ok(safariManifest.host_permissions.includes("https://www.idictation.cn/*"));
});

test("Safari uses a page bridge instead of Chromium's MAIN world manifest key", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "safari", "manifest.json"), "utf8"));
  const bridgeScript = manifest.content_scripts.find((item) => item.js?.includes("safari-page-loader.js"));
  const publicResources = manifest.web_accessible_resources.flatMap((item) => item.resources || []);

  assert.ok(bridgeScript);
  assert.equal(bridgeScript.world, undefined);
  assert.ok(publicResources.includes("page-capture.js"));
  assert.ok(fs.existsSync(path.join(root, "safari-page-loader.js")));
});

test("overlay includes iOS viewport and bottom-sheet behavior", () => {
  const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
  assert.match(content, /visualViewport/);
  assert.match(content, /overlayMobileHeight/);
  assert.match(content, /max-width:820px/);
  assert.match(content, /safe-area-inset-bottom/);
});
