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
    if (String(this.__ieltsCaptureUrl || "").includes(ARTICLE_LIST_PATH)) {
      this.addEventListener("load", () => {
        try {
          const payload = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
          capturePayload(payload);
        } catch {
          // Ignore non-JSON or inaccessible responses without affecting the website.
        }
      }, { once: true });
    }
    return xhrSend.apply(this, args);
  };

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
