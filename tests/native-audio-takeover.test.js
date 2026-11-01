"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const file = fs.readFileSync("page-capture.js", "utf8");
function harness() {
  const attrs = new Map();
  const domListeners = new Map();
  const emitted = [];
  const scheduled = new Map();
  let nextTimer = 0;
  let elapsed = 10000;

  const root = {
    setAttribute(name, value) { attrs.set(name, String(value)); },
    getAttribute(name) { return attrs.get(name) || null; }
  };
  const document = {
    documentElement: root,
    addEventListener(name, fn) {
      if (!domListeners.has(name)) domListeners.set(name, []);
      domListeners.get(name).push(fn);
    },
    dispatchEvent(event) {
      if (event.type === "ielts-native-audio-event") {
        emitted.push(JSON.parse(attrs.get("data-ielts-native-audio-event")));
      }
      for (const fn of domListeners.get(event.type) || []) fn(event);
    }
  };
  class FakeMedia {
    constructor() {
      this.tagName = "AUDIO";
      this.listeners = new Map();
      this.playCount = 0;
      this.pauseCount = 0;
      this.paused = true;
      this.helper = false;
    }
    hasAttribute(name) { return name === "data-ielts-helper-backup" && this.helper; }
    addEventListener(name, callback) {
      if (!this.listeners.has(name)) this.listeners.set(name, []);
      this.listeners.get(name).push(callback);
    }
    dispatch(name) {
      for (const fn of this.listeners.get(name) || []) fn({ type: name });
    }
    play() {
      this.playCount++;
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.pauseCount++;
      this.paused = true;
      this.dispatch("pause");
    }
  }
  class FakeXHR {}
  FakeXHR.prototype.open = function () {};
  FakeXHR.prototype.send = function () {};
  const context = {
    HTMLMediaElement: FakeMedia,
    XMLHttpRequest: FakeXHR,
    document,
    Event: class { constructor(type) { this.type = type; } },
    CustomEvent: class { constructor(type) { this.type = type; } },
    URL,
    location: { hostname: "www.idictation.cn", pathname: "/home", origin: "https://www.idictation.cn", href: "https://www.idictation.cn/home" },
    Date: class extends Date { static now() { return elapsed; } },
    setTimeout(fn, time) {
      const id = ++nextTimer;
      scheduled.set(id, { fn, at: elapsed + time });
      return id;
    },
    clearTimeout(id) { scheduled.delete(id); },
    window: { fetch: () => Promise.resolve({}), setTimeout(fn, time) {
      const id = ++nextTimer;
      scheduled.set(id, { fn, at: elapsed + time });
      return id;
    } }
  };
  vm.runInNewContext(file, context);
  function tick(ms) {
    const goal = elapsed + ms;
    let loops = 0;
    while (loops++ < 1000) {
      const due = [...scheduled.entries()].filter(([, task]) => task.at <= goal)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      elapsed = due[1].at;
      scheduled.delete(due[0]);
      due[1].fn();
    }
    elapsed = goal;
  }
  return { root, document, attrs, emitted, FakeMedia, tick };
}

(async () => {
  const h = harness();
  assert.equal(h.root.getAttribute("data-ielts-native-audio-bridge"), "html-media-v1");
  h.root.setAttribute("data-ielts-audio-takeover-mode", "auto");
  h.root.setAttribute("data-ielts-current-backup-ready", "yes");

  // A manual click before the website actually uses an HTML media player
  // must not risk overlapping an unknown Web Audio player.
  h.document.dispatchEvent({ type: "ielts-native-audio-request-backup" });
  assert.equal(h.emitted.filter((e) => e.type === "takeover").length, 0);
  assert.equal(h.emitted.at(-1).type, "native-unobserved");

  const ok = new h.FakeMedia();
  await ok.play();
  assert.equal(ok.playCount, 1, "auto mode must keep the original site audio");
  ok.dispatch("playing");
  h.tick(2400);
  assert.equal(h.emitted.filter((e) => e.type === "takeover").length, 0,
    "original audio is already playing: never double-play the backup");

  const stalled = new h.FakeMedia();
  await stalled.play();
  h.tick(2200);
  assert.equal(stalled.playCount, 1);
  assert.equal(stalled.pauseCount, 1, "takeover must stop original audio");
  assert.equal(h.emitted.filter((e) => e.type === "takeover").length, 1);

  // Replaying the site button while backup is active must not restart original.
  h.tick(300);
  await stalled.play();
  assert.equal(stalled.playCount, 1);
  assert.equal(h.emitted.filter((e) => e.type === "takeover").length, 2);

  h.document.dispatchEvent({ type: "ielts-native-audio-reset" });
  h.root.setAttribute("data-ielts-audio-takeover-mode", "force");
  const forced = new h.FakeMedia();
  await forced.play();
  assert.equal(forced.playCount, 0, "forced mode must suppress original only when backup is ready");
  assert.equal(h.emitted.filter((e) => e.type === "takeover").length, 3);

  // On failed backup, the website's original player is allowed to recover.
  h.document.dispatchEvent({ type: "ielts-native-audio-backup-failed" });
  assert.equal(forced.playCount, 1);

  h.document.dispatchEvent({ type: "ielts-native-audio-reset" });
  h.root.setAttribute("data-ielts-current-backup-ready", "no");
  const uncached = new h.FakeMedia();
  await uncached.play();
  assert.equal(uncached.playCount, 1, "missing backup must never silence the site");

  h.document.dispatchEvent({ type: "ielts-native-audio-reset" });
  h.root.setAttribute("data-ielts-current-backup-ready", "yes");
  const extension = new h.FakeMedia();
  extension.helper = true;
  await extension.play();
  assert.equal(extension.playCount, 1, "extension's own audio must bypass interception");

  h.root.setAttribute("data-ielts-audio-takeover-mode", "off");
  h.document.dispatchEvent({ type: "ielts-native-audio-mode-change" });
  const original = new h.FakeMedia();
  await original.play();
  assert.equal(original.playCount, 1, "off mode must not intercept site audio");

  console.log("Native HTML-audio fallback tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
