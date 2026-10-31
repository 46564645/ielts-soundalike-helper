(() => {
  "use strict";
  // Non-invasive: only prepare words already visible in the extension's own cards.
  // Never guess hidden dictation answers or start audio automatically.
  const MAX_WINDOW = 20;
  const seen = new Set();
  let timer = 0;
  let lastSignature = "";
  let accent = "us";
  let enabled = true;
  chrome.storage.sync.get({ accent: "us", enabled: true }, (v) => {
    accent = v.accent === "uk" ? "uk" : "us";
    enabled = v.enabled !== false;
    schedule();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.accent) accent = changes.accent.newValue === "uk" ? "uk" : "us";
    if (changes.enabled) enabled = changes.enabled.newValue !== false;
    lastSignature = "";
    seen.clear();
    schedule();
  });
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(scan, 300);
  }
  function scan() {
    if (!enabled) return;
    const hosts = document.querySelectorAll("ielts-soundalike-helper");
    const words = [];
    for (const host of hosts) {
      if (host.hidden) continue;
      const root = host.shadowRoot || host;
      for (const node of root.querySelectorAll(".word, .candidate-word")) {
        const word = (node.textContent || "").trim();
        if (!/^[a-z][a-z' -]{0,70}$/i.test(word)) continue;
        const key = word.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        words.push(word);
        if (words.length >= MAX_WINDOW) break;
      }
      if (words.length >= MAX_WINDOW) break;
    }
    const signature = accent + ":" + words.join("|");
    if (!words.length || signature === lastSignature) return;
    lastSignature = signature;
    chrome.runtime.sendMessage({ type: "PREFETCH_AUDIO_WORDS", words, accent }, () => {
      void chrome.runtime.lastError;
    });
    if (seen.size > 200) seen.clear();
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(); });
  schedule();
})();