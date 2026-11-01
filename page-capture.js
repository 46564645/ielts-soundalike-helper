(function () {
  "use strict";

  const ARTICLE_LIST_PATH = "/api/study/article/v1/list";
  const TRANSCRIPT_ATTRIBUTE = "data-ielts-speaking-transcript";

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (...args) {
      const requestUrl = requestUrlFrom(args[0]);
      const pending = originalFetch.apply(this, args);
      if (requestUrl.includes(ARTICLE_LIST_PATH)) {
        pending.then((response) => response.clone().json()).then(capturePayload).catch(() => {});
      }
      if (isStudyDataRequest(requestUrl)) {
        pending.then((response) => {
          if (!String(response.headers.get("content-type") || "").includes("json")) return null;
          return response.clone().json();
        }).then(captureFutureWordQueue).catch(() => {});
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
    if (requestUrl.includes(ARTICLE_LIST_PATH) || isStudyDataRequest(requestUrl)) {
      this.addEventListener("load", () => {
        try {
          const payload = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
          if (requestUrl.includes(ARTICLE_LIST_PATH)) capturePayload(payload);
          if (isStudyDataRequest(requestUrl)) captureFutureWordQueue(payload);
        } catch {
          // Never affect the site's response processing.
        }
      }, { once: true });
    }
    return xhrSend.apply(this, args);
  };

  // Observe only data already delivered to the user's current study session.
  // Never request hidden endpoints, advance questions or reveal upcoming answers.
  const QUEUE_ATTRIBUTE = "data-ielts-future-audio-queue";
  let lastQueueSignature = "";
  function isStudyDataRequest(url) {
    if (location.hostname !== "www.idictation.cn" || location.pathname !== "/home") return false;
    try {
      const parsed = new URL(url, location.href);
      return parsed.origin === location.origin && /\\/api\\//i.test(parsed.pathname)
        && /(?:study|dictation|word|review|learn|train|practice|exercise|session|task|list)/i.test(parsed.pathname);
    } catch {
      return false;
    }
  }
  function extractEnglishWord(row) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return "";
    const raw = row.word ?? row.wordName ?? row.word_name ?? row.english ?? row.vocabulary;
    if (typeof raw !== "string") return "";
    const word = raw.trim().toLowerCase();
    return /^[a-z][a-z' -]{0,65}$/i.test(word) ? word : "";
  }
  function captureFutureWordQueue(payload) {
    if (!payload || typeof payload !== "object") return;
    const pending = [{ data: payload, depth: 0 }];
    let bestWords = [];
    let examined = 0;
    while (pending.length && examined++ < 350) {
      const { data, depth } = pending.shift();
      if (Array.isArray(data)) {
        const words = data.slice(0, 120).map(extractEnglishWord).filter(Boolean);
        if (words.length >= 3 && words.length > bestWords.length && words.length >= Math.ceil(data.length * 0.6)) {
          bestWords = words;
        }
        if (depth < 6) for (const value of data.slice(0, 80)) {
          if (value && typeof value === "object") pending.push({ data: value, depth: depth + 1 });
        }
      } else if (data && typeof data === "object" && depth < 6) {
        for (const value of Object.values(data).slice(0, 40)) {
          if (value && typeof value === "object") pending.push({ data: value, depth: depth + 1 });
        }
      }
    }
    const words = [...new Set(bestWords)].slice(0, 50);
    if (words.length < 3) return;
    const signature = words.join("|");
    if (signature === lastQueueSignature) return;
    lastQueueSignature = signature;
    document.documentElement?.setAttribute(QUEUE_ATTRIBUTE, JSON.stringify({
      words, detected: words.length, observedAt: Date.now()
    }));
    document.dispatchEvent(new CustomEvent("ielts-future-audio-queue-ready"));
  }

  function capturePayload(payload) {
    const rows = findSentenceRows(payload);
    if (!rows.length) return;
    const sentences = rows.map((item) => ({
      content: clean(item?.content || item?.text, 3000),
      translate: clean(item?.translate || item?.translation, 2000)
    })).filter((item) => item.content);
    if (!sentences.length) return;
    const serialized = JSON.stringify({ capturedAt: Date.now(), sentences }).slice(0, 120000);
    document.documentElement?.setAttribute(TRANSCRIPT_ATTRIBUTE, serialized);
    document.dispatchEvent(new CustomEvent("ielts-speaking-transcript-ready"));
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
