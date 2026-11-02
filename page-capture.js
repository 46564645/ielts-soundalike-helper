(function () {
  "use strict";

  if (window.__ieltsSoundalikeMainBridgeV220) return;
  window.__ieltsSoundalikeMainBridgeV220 = true;

  const ARTICLE_LIST_PATH = "/api/study/article/v1/list";
  const LEXICON_LIST_PATH = "/api/study/lexicon/v1/list";
  const TRANSCRIPT_ATTRIBUTE = "data-ielts-speaking-transcript";
  const CATALOG_ATTRIBUTE = "data-ielts-study-audio-catalog";
  const QUEUE_ATTRIBUTE = "data-ielts-study-runtime-queue";
  const PLAY_ATTRIBUTE = "data-ielts-study-native-play";
  const catalog = new Map();
  let lastCatalogSignature = "";
  let lastQueueSignature = "";

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (...args) {
      const requestUrl = requestUrlFrom(args[0]);
      const pending = originalFetch.apply(this, args);
      if (requestUrl.includes(ARTICLE_LIST_PATH) || requestUrl.includes(LEXICON_LIST_PATH)) {
        pending.then((response) => response.clone().json()).then((payload) => {
          if (requestUrl.includes(ARTICLE_LIST_PATH)) captureTranscript(payload);
          if (requestUrl.includes(LEXICON_LIST_PATH)) captureLexiconCatalog(payload);
        }).catch(() => {});
      }
      return pending;
    };
  }

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ieltsCaptureUrl = String(url || "");
    return xhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const requestUrl = String(this.__ieltsCaptureUrl || "");
    if (requestUrl.includes(ARTICLE_LIST_PATH) || requestUrl.includes(LEXICON_LIST_PATH)) {
      this.addEventListener("load", () => {
        try {
          const payload = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
          if (requestUrl.includes(ARTICLE_LIST_PATH)) captureTranscript(payload);
          if (requestUrl.includes(LEXICON_LIST_PATH)) captureLexiconCatalog(payload);
        } catch {
          // The bridge must never affect the study page.
        }
      }, { once: true });
    }
    return xhrSend.apply(this, args);
  };

  function cleanWord(value) {
    const word = String(value || "").trim().toLowerCase();
    return /^[a-z][a-z' -]{0,65}$/i.test(word) ? word : "";
  }

  function captureLexiconCatalog(payload) {
    const rows = payload?.values?.data;
    if (!Array.isArray(rows) || !rows.length) return;
    for (const row of rows) {
      const word = cleanWord(row?.word);
      if (!word) continue;
      catalog.set(word, {
        id: Number(row?.id) || 0,
        wordId: Number(row?.word_id) || 0,
        word,
        ukIpa: clean(row?.phonetic_transcriptions?.ukphone || row?.phonetic_transcription, 120),
        usIpa: clean(row?.phonetic_transcriptions?.usphone, 120),
        ukAudio: safeAudioUrl(row?.["phonetic-y"]),
        usAudio: safeAudioUrl(row?.["phonetic-m"])
      });
    }
    publishCatalog();
    publishRuntimeQueue();
  }

  function safeAudioUrl(value) {
    try {
      const url = new URL(String(value || ""), location.href);
      if (url.protocol !== "https:") return "";
      if (url.hostname !== "idictation-article.oss-cn-beijing.aliyuncs.com") return "";
      return url.href.slice(0, 1000);
    } catch {
      return "";
    }
  }

  function publishCatalog() {
    const items = Array.from(catalog.values());
    if (!items.length) return;
    const signature = items.map((item) => `${item.id}:${item.word}:${item.ukAudio}:${item.usAudio}`).join("|");
    if (signature === lastCatalogSignature) return;
    lastCatalogSignature = signature;
    publish(CATALOG_ATTRIBUTE, "ielts-study-audio-catalog-ready", { items, observedAt: Date.now() });
  }

  function findRuntimeStudyState() {
    const candidates = [];
    const app = document.querySelector?.("#app");
    if (app?.__vue_app__?._instance) candidates.push(app.__vue_app__._instance);
    if (app?.__vueParentComponent) candidates.push(app.__vueParentComponent);
    for (const node of document.querySelectorAll?.("main,[data-v-db1d9977]") || []) {
      if (node.__vueParentComponent) candidates.push(node.__vueParentComponent);
      if (candidates.length >= 8) break;
    }
    const pending = candidates.map((value) => ({ value, depth: 0 }));
    const seen = new WeakSet();
    let examined = 0;
    while (pending.length && examined++ < 1400) {
      const { value, depth } = pending.shift();
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);
      const state = queueShape(value);
      if (state) return state;
      if (depth >= 7 || (typeof Node !== "undefined" && value instanceof Node) ||
          (typeof Window !== "undefined" && value instanceof Window)) continue;
      let keys;
      try { keys = Reflect.ownKeys(value).slice(0, 80); } catch { continue; }
      for (const key of keys) {
        if (typeof key === "string" && !/^(?:parent|appContext|provides|ctx|proxy|subTree|component|setupState|data|exposed|value|t)$/i.test(key) && depth > 3) continue;
        let child;
        try { child = value[key]; } catch { continue; }
        if (child && typeof child === "object") pending.push({ value: child, depth: depth + 1 });
      }
    }
    return null;
  }

  function queueShape(value) {
    let words;
    let currentWord;
    let currentIndex;
    try {
      words = value.words;
      currentWord = value.currentWord;
      currentIndex = Number(value.currentIndex);
    } catch { return null; }
    if (!Array.isArray(words) || words.length < 1 || words.length > 2000 || !Number.isInteger(currentIndex)) return null;
    if (currentIndex < 0 || currentIndex >= words.length || !currentWord || typeof currentWord !== "object") return null;
    const valid = words.filter((row) => cleanWord(row?.word)).length;
    if (valid < Math.max(1, Math.ceil(words.length * 0.75))) return null;
    const current = cleanWord(currentWord.word);
    const indexed = cleanWord(words[currentIndex]?.word);
    if (!current || (indexed && current !== indexed)) return null;
    return { words, currentWord, currentIndex, source: "vue-runtime" };
  }

  function drawerStudyState() {
    const rows = Array.from(document.querySelectorAll?.("[data-word-index]") || []);
    if (rows.length < 3) return null;
    const parsed = rows.map((node) => {
      const text = String(node.textContent || "");
      const match = text.match(/\b[a-z][a-z' -]{0,65}\b/i);
      return match ? { node, row: { word: cleanWord(match[0]) } } : null;
    }).filter((entry) => entry?.row.word && catalog.has(entry.row.word));
    if (parsed.length < Math.ceil(rows.length * 0.6)) return null;
    let currentIndex = parsed.findIndex(({ node }) => node.id === "current" || node.classList?.contains("current"));
    if (currentIndex < 0) currentIndex = 0;
    const words = parsed.map((entry) => entry.row);
    return { words, currentWord: words[currentIndex], currentIndex, source: "word-drawer" };
  }

  function occurrence(row, index) {
    const word = cleanWord(row?.word);
    const item = catalog.get(word) || {};
    return {
      occurrenceId: `${index}:${Number(row?.id) || item.id || item.wordId || word}`,
      id: Number(row?.id) || item.id || 0,
      wordId: Number(row?.word_id) || item.wordId || 0,
      word,
      ukAudio: safeAudioUrl(row?.["phonetic-y"] || item.ukAudio),
      usAudio: safeAudioUrl(row?.["phonetic-m"] || item.usAudio)
    };
  }

  function publishRuntimeQueue() {
    if (location.hostname !== "www.idictation.cn" || location.pathname !== "/home") return;
    const state = findRuntimeStudyState() || drawerStudyState();
    if (!state) return;
    const occurrences = state.words.map(occurrence).filter((item) => item.word);
    if (!occurrences.length || state.currentIndex >= occurrences.length) return;
    const signature = `${state.currentIndex}|${occurrences.map((item) => item.occurrenceId + ":" + item.word).join("|")}`;
    if (signature === lastQueueSignature) return;
    lastQueueSignature = signature;
    publish(QUEUE_ATTRIBUTE, "ielts-study-runtime-queue-ready", {
      occurrences, currentIndex: state.currentIndex, source: state.source, observedAt: Date.now()
    });
  }

  function observeNativePlay() {
    const nativePlay = typeof HTMLMediaElement !== "undefined" && HTMLMediaElement.prototype.play;
    if (typeof nativePlay !== "function") return;
    let activeStudyMedia = null;
    HTMLMediaElement.prototype.play = function (...args) {
      try {
        const src = String(this.currentSrc || this.src || "");
        const match = Array.from(catalog.values()).find((item) => src && (src === item.ukAudio || src === item.usAudio));
        if (match) {
          activeStudyMedia = this;
          publish(PLAY_ATTRIBUTE, "ielts-study-native-play", {
            word: match.word, audioUrl: src, observedAt: Date.now()
          });
        }
      } catch {}
      return nativePlay.apply(this, args);
    };
    document.addEventListener("ielts-study-manual-stop-native", () => {
      try { activeStudyMedia?.pause(); } catch {}
    });
  }

  function publish(attribute, eventName, payload) {
    const root = document.documentElement;
    if (!root) return;
    root.setAttribute(attribute, JSON.stringify(payload).slice(0, 600000));
    document.dispatchEvent(new CustomEvent(eventName));
  }

  observeNativePlay();
  if (typeof window.setInterval === "function") {
    const scanTimer = window.setInterval(publishRuntimeQueue, 500);
    window.addEventListener?.("pagehide", () => window.clearInterval(scanTimer), { once: true });
  }

  function captureTranscript(payload) {
    const rows = findSentenceRows(payload);
    if (!rows.length) return;
    const sentences = rows.map((item) => ({
      content: clean(item?.content || item?.text, 3000),
      translate: clean(item?.translate || item?.translation, 2000)
    })).filter((item) => item.content);
    if (!sentences.length) return;
    publish(TRANSCRIPT_ATTRIBUTE, "ielts-speaking-transcript-ready", { capturedAt: Date.now(), sentences });
  }

  function findSentenceRows(value) {
    const queue = [{ value, depth: 0 }];
    while (queue.length) {
      const current = queue.shift();
      if (Array.isArray(current.value)) {
        if (current.value.some((item) => item && typeof item === "object" && (item.content || item.text))) return current.value;
        if (current.depth < 4) for (const item of current.value) queue.push({ value: item, depth: current.depth + 1 });
      } else if (current.value && typeof current.value === "object" && current.depth < 4) {
        for (const item of Object.values(current.value)) queue.push({ value: item, depth: current.depth + 1 });
      }
    }
    return [];
  }

  function requestUrlFrom(input) {
    if (typeof input === "string") return input;
    return String(input?.url || "");
  }

  function clean(value, limit) {
    return String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
  }
})();
