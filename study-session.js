(function () {
  "use strict";

  if (globalThis.IeltsStudySession || location.hostname !== "www.idictation.cn") return;

  const P = globalThis.IeltsPhonetics;
  const WINDOW_SIZE = 30;
  const REFILL_AT = 10;
  const CATALOG_ATTRIBUTE = "data-ielts-study-audio-catalog";
  const QUEUE_ATTRIBUTE = "data-ielts-study-runtime-queue";
  const POSITION_KEY = "studySpeakerPositionV1";
  const catalog = new Map();
  let queue = { occurrences: [], currentIndex: 0, source: "" };
  let session = { active: false, starting: false, id: "", coverageEnd: 0, generation: 0, direct: false };
  let accent = "us";
  let currentWord = "";
  let currentAudio = null;
  let currentAudioUrl = "";
  let currentLoad = 0;
  let speaker = null;
  let cacheStatus = { phase: "waiting", ready: 0, total: 0, failed: 0 };

  document.addEventListener("ielts-study-audio-catalog-ready", consumeCatalog);
  document.addEventListener("ielts-study-runtime-queue-ready", consumeQueue);
  window.addEventListener("resize", clampSpeakerPosition);
  window.visualViewport?.addEventListener("resize", clampSpeakerPosition);
  window.setTimeout(consumeCatalog, 0);
  window.setTimeout(consumeQueue, 0);

  function normalizeWord(value) {
    return P?.normalizeWord ? P.normalizeWord(value) : String(value || "").trim().toLowerCase();
  }

  function consumeAttribute(name) {
    const root = document.documentElement;
    const raw = root?.getAttribute(name);
    if (!raw) return null;
    root.removeAttribute(name);
    try { return JSON.parse(raw); } catch { return null; }
  }

  function consumeCatalog() {
    const payload = consumeAttribute(CATALOG_ATTRIBUTE);
    if (!payload || Math.abs(Date.now() - Number(payload.observedAt || 0)) > 10 * 60 * 1000) return;
    for (const item of Array.isArray(payload.items) ? payload.items : []) {
      const word = normalizeWord(item?.word);
      if (word) catalog.set(word, { ...item, word });
    }
    hydrateQueueAudio();
    if (session.active) scheduleWindow();
  }

  function consumeQueue() {
    const payload = consumeAttribute(QUEUE_ATTRIBUTE);
    if (!payload || Math.abs(Date.now() - Number(payload.observedAt || 0)) > 2 * 60 * 1000) return;
    const occurrences = (Array.isArray(payload.occurrences) ? payload.occurrences : []).map((item, index) => {
      const word = normalizeWord(item?.word);
      return word ? { ...item, word, occurrenceId: String(item.occurrenceId || `${index}:${word}`) } : null;
    }).filter(Boolean);
    const currentIndex = Number(payload.currentIndex);
    if (!occurrences.length || !Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= occurrences.length) return;
    queue = { occurrences, currentIndex, source: String(payload.source || "") };
    hydrateQueueAudio();
    const current = occurrences[currentIndex];
    if (current?.word) setCurrentWord(current.word);
    if (session.active) scheduleWindow();
  }

  function hydrateQueueAudio() {
    queue.occurrences = queue.occurrences.map((item) => {
      const known = catalog.get(item.word) || {};
      return {
        ...item,
        ukAudio: item.ukAudio || known.ukAudio || "",
        usAudio: item.usAudio || known.usAudio || ""
      };
    });
  }

  async function activate() {
    if (session.active || session.starting || location.pathname !== "/home") return;
    session.starting = true;
    try {
      const response = await sendMessage({ type: "START_STUDY_AUDIO_SESSION" });
      if (!response?.ok || !response.sessionId) throw new Error(response?.error || "无法创建缓存会话");
      session = { active: true, starting: false, id: response.sessionId, coverageEnd: 0, generation: 0, direct: false };
    } catch {
      // Orion/iOS may run without a usable background worker or tab context.
      // Keep the speaker working by playing the site's own audio URLs.
      session = { active: true, starting: false, id: "", coverageEnd: 0, generation: 0, direct: true };
    }
    ensureSpeaker();
    speaker.hidden = false;
    scheduleWindow();
    prepareCurrentAudio();
  }

  function setAccent(value) {
    const next = value === "uk" ? "uk" : "us";
    if (next === accent) return;
    accent = next;
    session.coverageEnd = 0;
    currentAudioUrl = "";
    currentAudio = null;
    if (session.active) scheduleWindow();
    prepareCurrentAudio();
  }

  function setCurrentWord(value) {
    const word = normalizeWord(value);
    if (!word || word === currentWord) return;
    currentWord = word;
    currentAudioUrl = "";
    if (currentAudio) {
      try { currentAudio.pause(); currentAudio.src = ""; } catch {}
      currentAudio = null;
    }
    prepareCurrentAudio();
    renderSpeaker();
  }

  function scheduleWindow() {
    if (!session.active || (!session.id && !session.direct) || !queue.occurrences.length) {
      cacheStatus = { phase: "waiting", ready: 0, total: 0, failed: 0 };
      renderSpeaker();
      return;
    }
    const start = Math.max(0, queue.currentIndex);
    if (!session.coverageEnd) session.coverageEnd = Math.min(queue.occurrences.length, start + WINDOW_SIZE + 1);
    if (session.coverageEnd - start <= REFILL_AT && session.coverageEnd < queue.occurrences.length) {
      session.coverageEnd = Math.min(queue.occurrences.length, session.coverageEnd + WINDOW_SIZE);
    }
    if (session.coverageEnd < start + 1) session.coverageEnd = Math.min(queue.occurrences.length, start + WINDOW_SIZE + 1);
    const covered = queue.occurrences.slice(start, session.coverageEnd);
    const unique = new Map();
    for (const item of covered) {
      const audioUrl = accent === "uk" ? item.ukAudio : item.usAudio;
      if (audioUrl && !unique.has(item.word)) unique.set(item.word, { word: item.word, audioUrl });
    }
    const items = Array.from(unique.values());
    if (!items.length) {
      cacheStatus = { phase: "waiting", ready: 0, total: covered.length, failed: 0 };
      renderSpeaker();
      return;
    }
    if (session.direct) {
      cacheStatus = { phase: "ready", ready: items.length, total: items.length, failed: 0 };
      prepareCurrentAudio();
      renderSpeaker();
      return;
    }
    const generation = ++session.generation;
    cacheStatus = { phase: "loading", ready: 0, total: items.length, failed: 0 };
    renderSpeaker();
    void sendMessage({
      type: "PREFETCH_STUDY_SESSION_AUDIO",
      sessionId: session.id,
      items,
      accent
    }).then((response) => {
      if (generation !== session.generation || !session.active) return;
      const ready = Number(response?.count || 0);
      cacheStatus = {
        phase: response?.ok && ready ? "ready" : "failed",
        ready,
        total: items.length,
        failed: Math.max(0, items.length - ready)
      };
      prepareCurrentAudio();
      renderSpeaker();
    }).catch(() => {
      if (generation !== session.generation) return;
      cacheStatus = { phase: "failed", ready: 0, total: items.length, failed: items.length };
      renderSpeaker();
    });
  }

  function prepareCurrentAudio() {
    if (!session.active || !currentWord) return;
    if (session.direct || !session.id) {
      applyDirectAudio();
      return;
    }
    const load = ++currentLoad;
    const word = currentWord;
    sendMessage({ type: "GET_STUDY_SESSION_AUDIO", sessionId: session.id, word, accent })
      .then((response) => {
        if (load !== currentLoad || word !== currentWord) return;
        const url = String(response?.audioUrl || "");
        if (!response?.ok || !response.available || !isAudioDataUrl(url)) {
          applyDirectAudio();
          return;
        }
        setCurrentAudio(url);
      }).catch(() => {
        if (load === currentLoad) applyDirectAudio();
      });
  }

  function isAudioDataUrl(url) {
    return /^data:(?:audio\/|application\/octet-stream|binary\/octet-stream)/i.test(url);
  }

  function directAudioUrl(word) {
    const item = catalog.get(normalizeWord(word));
    return accent === "uk" ? String(item?.ukAudio || "") : String(item?.usAudio || "");
  }

  function applyDirectAudio() {
    const url = directAudioUrl(currentWord);
    if (!url) {
      currentAudioUrl = "";
      currentAudio = null;
      renderSpeaker();
      return;
    }
    setCurrentAudio(url);
  }

  function setCurrentAudio(url) {
    if (url === currentAudioUrl && currentAudio) {
      renderSpeaker();
      return;
    }
    currentAudioUrl = url;
    currentAudio = new Audio(url);
    currentAudio.preload = "auto";
    currentAudio.setAttribute("data-ielts-helper-manual", "true");
    renderSpeaker();
  }

  function ensureSpeaker() {
    if (speaker) return speaker;
    const button = document.createElement("button");
    button.id = "ielts-manual-study-speaker";
    button.type = "button";
    button.setAttribute("aria-label", "播放当前词缓存");
    button.innerHTML = '<span aria-hidden="true">◖</span><i></i>';
    button.style.cssText = "position:fixed;z-index:2147483646;width:36px;height:36px;padding:0;border:1px solid rgba(255,255,255,.72);border-radius:50%;background:#123f49;color:#fff;box-shadow:0 5px 18px rgba(8,35,41,.28);display:grid;place-items:center;font:700 22px/1 Georgia,serif;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;cursor:grab;outline:none;";
    document.documentElement.appendChild(button);
    speaker = button;
    restoreSpeakerPosition();
    installSpeakerPointerControl(button);
    renderSpeaker();
    return button;
  }

  function installSpeakerPointerControl(button) {
    let drag = null;
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = button.getBoundingClientRect();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
      button.setPointerCapture?.(event.pointerId);
      button.style.cursor = "grabbing";
    });
    button.addEventListener("pointermove", (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      event.preventDefault();
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (Math.hypot(dx, dy) > 6) drag.moved = true;
      if (!drag.moved) return;
      const point = clampPoint(drag.left + dx, drag.top + dy);
      button.style.left = `${point.left}px`;
      button.style.top = `${point.top}px`;
      button.style.right = "auto";
      button.style.bottom = "auto";
    });
    const finish = (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      const shouldPlay = !drag.moved;
      drag = null;
      button.style.cursor = "grab";
      try { button.releasePointerCapture?.(event.pointerId); } catch {}
      saveSpeakerPosition();
      if (shouldPlay) playCurrent();
    };
    button.addEventListener("pointerup", finish);
    button.addEventListener("pointercancel", (event) => {
      if (drag?.id === event.pointerId) drag = null;
      button.style.cursor = "grab";
    });
    button.addEventListener("touchstart", (event) => event.preventDefault(), { passive: false });
    button.addEventListener("click", (event) => event.preventDefault());
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        playCurrent();
      }
    });
  }

  function playCurrent() {
    if (!currentAudio || !currentAudioUrl) {
      prepareCurrentAudio();
      pulseSpeaker("failed");
      return;
    }
    document.dispatchEvent(new Event("ielts-study-manual-stop-native"));
    try {
      currentAudio.pause();
      currentAudio.currentTime = 0;
      const promise = currentAudio.play();
      pulseSpeaker("playing");
      promise?.catch(() => pulseSpeaker("failed"));
    } catch {
      pulseSpeaker("failed");
    }
  }

  function renderSpeaker() {
    if (!speaker) return;
    const ready = Boolean(currentAudio && currentAudioUrl);
    const state = ready ? "ready" : cacheStatus.phase === "loading" ? "loading" : "waiting";
    speaker.dataset.state = state;
    speaker.style.background = ready ? "#0f6b72" : state === "loading" ? "#9a6a18" : "#56636a";
    speaker.style.opacity = ready ? "1" : ".78";
    speaker.title = ready ? "播放当前词缓存" : state === "loading" ? "当前词音频正在缓存" : "当前词缓存尚未准备";
    speaker.setAttribute("aria-label", speaker.title);
  }

  function pulseSpeaker(state) {
    if (!speaker) return;
    speaker.dataset.state = state;
    speaker.animate?.([
      { transform: "scale(1)" },
      { transform: state === "playing" ? "scale(.88)" : "translateX(-2px)" },
      { transform: "scale(1)" }
    ], { duration: 220, easing: "ease-out" });
  }

  function viewportRect() {
    const visual = window.visualViewport;
    return {
      left: visual?.offsetLeft || 0,
      top: visual?.offsetTop || 0,
      width: visual?.width || window.innerWidth,
      height: visual?.height || window.innerHeight
    };
  }

  function clampPoint(left, top) {
    const view = viewportRect();
    const margin = 6;
    return {
      left: Math.min(Math.max(left, view.left + margin), view.left + view.width - 36 - margin),
      top: Math.min(Math.max(top, view.top + margin), view.top + view.height - 36 - margin)
    };
  }

  function clampSpeakerPosition() {
    if (!speaker) return;
    const rect = speaker.getBoundingClientRect();
    const point = clampPoint(rect.left, rect.top);
    speaker.style.left = `${point.left}px`;
    speaker.style.top = `${point.top}px`;
    speaker.style.right = "auto";
    speaker.style.bottom = "auto";
  }

  function restoreSpeakerPosition() {
    chrome.storage.local.get({ [POSITION_KEY]: null }, (state) => {
      const saved = state?.[POSITION_KEY];
      const view = viewportRect();
      const point = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)
        ? clampPoint(saved.x, saved.y)
        : clampPoint(view.left + view.width - 50, view.top + view.height * .55);
      if (!speaker) return;
      speaker.style.left = `${point.left}px`;
      speaker.style.top = `${point.top}px`;
    });
  }

  function saveSpeakerPosition() {
    if (!speaker) return;
    const rect = speaker.getBoundingClientRect();
    chrome.storage.local.set({ [POSITION_KEY]: { x: rect.left, y: rect.top } });
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(response);
      });
    });
  }

  globalThis.IeltsStudySession = Object.freeze({
    activate,
    setCurrentWord,
    setAccent,
    getStatus: () => ({ ...cacheStatus, active: session.active, source: queue.source })
  });
})();
