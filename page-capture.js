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
      return parsed.origin === location.origin && /\/api\//i.test(parsed.pathname)
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
    // Three exercises may contain only one or two distinct words during retry.
    if (!words.length) return;
    const signature = words.join("|");
    if (signature === lastQueueSignature) return;
    lastQueueSignature = signature;
    document.documentElement?.setAttribute(QUEUE_ATTRIBUTE, JSON.stringify({
      words, detected: words.length, observedAt: Date.now()
    }));
    document.dispatchEvent(new CustomEvent("ielts-future-audio-queue-ready"));
  }


  // Playback watchdog for the website's own HTML <audio> player. The main
  // world can see native play()/playing/error events; the isolated extension
  // script cannot reliably intercept those calls on iOS.
  function installAudioTakeoverBridge() {
    if (location.hostname !== "www.idictation.cn") return;
    // Site versions may use Web Audio instead of HTMLMediaElement.
    // The speaker click listener must still be available in that case.
    const nativePlay = typeof HTMLMediaElement !== "undefined" &&
      typeof HTMLMediaElement.prototype.play === "function"
        ? HTMLMediaElement.prototype.play : null;
    const tracked = new WeakSet();
    let activeAudio = null;
    let attemptId = 0;
    let nativePlaying = false;
    let backupActive = false;
    let watchdog = null;
    let lastBackupReplay = 0;
    let backupTicket = 0;
    let backupStartTimer = null;

    function root() { return document.documentElement; }
    function mode() {
      const value = root()?.getAttribute("data-ielts-audio-takeover-mode");
      return value === "force" || value === "off" ? value : "auto";
    }
    function ready() {
      return root()?.getAttribute("data-ielts-current-backup-ready") === "yes";
    }
    function studyAudio(media) {
      return location.pathname === "/home" &&
        String(media?.tagName || "").toLowerCase() === "audio" &&
        !media.hasAttribute("data-ielts-helper-backup");
    }
    function emit(type, reason, ticket = 0) {
      const el = root();
      if (!el) return;
      el.setAttribute("data-ielts-native-audio-event",
        JSON.stringify({ type, reason: reason || "", ticket, at: Date.now() }));
      document.dispatchEvent(new Event("ielts-native-audio-event"));
    }
    function clearWatchdog() {
      if (watchdog !== null) clearTimeout(watchdog);
      watchdog = null;
    }
    function clearBackupStartTimer() {
      if (backupStartTimer !== null) clearTimeout(backupStartTimer);
      backupStartTimer = null;
    }
    function activateFallback(reason) {
      if (mode() === "off" || !ready()) return false;
      clearWatchdog();
      clearBackupStartTimer();
      backupActive = true;
      try { activeAudio?.pause(); } catch {}
      const ticket = ++backupTicket;
      emit("takeover", reason, ticket);
      // If the content-script listener is unavailable or iOS blocks audio,
      // do not leave the website player muted indefinitely.
      backupStartTimer = setTimeout(() => {
        backupStartTimer = null;
        if (!backupActive || ticket !== backupTicket) return;
        if (root()?.getAttribute("data-ielts-fallback-started") === String(ticket)) return;
        backupActive = false;
        root()?.setAttribute("data-ielts-fallback-cancel", String(ticket));
        document.dispatchEvent(new Event("ielts-native-audio-cancel-backup"));
        emit("backup-timeout", "备用发音没有成功启动，已尝试恢复原声");
        const native = activeAudio;
        if (native && nativePlay) {
          try { Promise.resolve(nativePlay.call(native)).catch(() => {}); } catch {}
        }
      }, 3000);
      return true;
    }
    function scheduleWatchdog(media, id, ms = 2100) {
      clearWatchdog();
      watchdog = setTimeout(() => {
        watchdog = null;
        if (id !== attemptId || media !== activeAudio || nativePlaying ||
            mode() === "off" || backupActive) return;
        if (!activateFallback("原声缓冲超时")) emit("waiting", "原声未开始播放，备用音频未就绪");
      }, ms);
    }
    function listen(media) {
      if (tracked.has(media)) return;
      tracked.add(media);
      media.addEventListener("playing", () => {
        if (media !== activeAudio) return;
        if (backupActive) {
          try { media.pause(); } catch {}
          return;
        }
        nativePlaying = true;
        clearWatchdog();
        emit("native-playing");
      });
      media.addEventListener("waiting", () => {
        if (media !== activeAudio || backupActive || mode() === "off") return;
        nativePlaying = false;
        scheduleWatchdog(media, attemptId, 2100);
      });
      media.addEventListener("stalled", () => {
        if (media !== activeAudio || backupActive || mode() === "off") return;
        nativePlaying = false;
        scheduleWatchdog(media, attemptId, 2100);
      });
      media.addEventListener("error", () => {
        if (media !== activeAudio || backupActive || mode() === "off") return;
        if (!activateFallback("原声音频出错")) emit("native-error", "备用音频未就绪");
      });
      media.addEventListener("pause", () => {
        if (media === activeAudio && !backupActive) clearWatchdog();
      });
      media.addEventListener("ended", () => {
        if (media === activeAudio) clearWatchdog();
      });
    }

    if (nativePlay) HTMLMediaElement.prototype.play = function (...args) {
      if (!studyAudio(this) || mode() === "off") return nativePlay.apply(this, args);
      listen(this);
      activeAudio = this;
      const currentMode = mode();
      if (backupActive) {
        // Repeated taps replay the backup, never allow the original source
        // to start underneath it. Throttle duplicate framework play calls.
        if (ready() && Date.now() - lastBackupReplay > 250) {
          lastBackupReplay = Date.now();
          activateFallback("再次播放备用发音");
        }
        return Promise.resolve();
      }
      if (currentMode === "force" && ready()) {
        attemptId++;
        nativePlaying = false;
        lastBackupReplay = Date.now();
        activateFallback("已开启接管模式");
        return Promise.resolve();
      }
      const id = ++attemptId;
      nativePlaying = false;
      emit("attempt");
      let result;
      try {
        result = nativePlay.apply(this, args);
      } catch (error) {
        if (!activateFallback("原声播放异常")) emit("native-error", "原声无法启动");
        throw error;
      }
      if (result && typeof result.catch === "function") {
        result.catch(() => {
          if (id !== attemptId || nativePlaying || backupActive) return;
          if (!activateFallback("原声播放被拒绝")) emit("native-error", "原声播放失败");
        });
      }
      scheduleWatchdog(this, id);
      return result;
    };


    // Native listener for the original website's speaker icon. React normally
    // attaches delegated click handlers below document; capture runs first.
    // Do not block unrelated buttons or reveal the current word.
    function findSiteSpeakerControl(target) {
      if (!target || typeof target.closest !== "function") return null;
      const icon = target.closest("svg,i,[class*='volume'],[class*='speaker'],[class*='sound']");
      const control = target.closest("button,[role='button']") ||
        icon?.closest?.("button,[role='button']") || null;
      if (!control || !control.closest("main")) return null;
      const label = [
        control.getAttribute("aria-label"), control.getAttribute("title"),
        control.getAttribute("data-testid"), control.getAttribute("data-state")
      ].filter(Boolean).join(" ").toLowerCase();
      const speakerIcon = control.querySelector(
        "svg[class*='volume'],svg[class*='speaker'],svg[class*='audio']," +
        "svg[class*='sound'],svg[class*='headphone'],i[class*='volume']," +
        "[data-lucide*='volume'],[data-icon*='volume']"
      );
      const named = /(播放|发音|朗读|重播|重听|喇叭|读音|音频|声音|listen|audio|sound|speaker|volume|pronounc)/i.test(label);
      if (!named && !speakerIcon && !(
        icon && /(volume|speaker|sound|audio|headphone)/i.test(String(icon.getAttribute("class") || ""))
      )) return null;
      if (/(下一题|上一题|提交|答案|选择|认识|不认识|隐藏|设置)/.test(label)) return null;
      return control;
    }
    document.addEventListener("click", (event) => {
      if (location.pathname !== "/home" || !findSiteSpeakerControl(event.target)) return;
      const currentMode = mode();
      const hasBackup = ready();
      if (currentMode === "force" && hasBackup ||
          currentMode === "auto" && hasBackup &&
            typeof navigator !== "undefined" && navigator.onLine === false) {
        // Block the site click before React can play another audio stream.
        if (event.cancelable) event.preventDefault();
        event.stopImmediatePropagation();
        event.stopPropagation();
        activateFallback(currentMode === "force"
          ? "网站喇叭已拦截，播放备用发音" : "离线模式，播放备用发音");
        return;
      }
      emit("speaker-click", hasBackup
        ? "检测到网站喇叭；正常模式继续由原声播放"
        : "检测到网站喇叭；当前题备用发音尚未准备");
    }, true);

    document.addEventListener("ielts-native-audio-manual-stop", () => {
      // Direct UI playback is a user gesture. Pause any observed native
      // HTML audio first, but cannot guarantee control of unobserved Web Audio.
      if (activeAudio) {
        try { activeAudio.pause(); } catch {}
        clearWatchdog();
      }
    });

    document.addEventListener("ielts-native-audio-reset", () => {
      attemptId++;
      backupTicket++;
      clearBackupStartTimer();
      backupActive = false;
      nativePlaying = false;
      activeAudio = null;
      clearWatchdog();
    });
    document.addEventListener("ielts-native-audio-mode-change", () => {
      if (mode() === "off") {
        backupActive = false;
        backupTicket++;
        clearBackupStartTimer();
        clearWatchdog();
      }
    });
    document.addEventListener("ielts-native-audio-ready", () => {
      if (!backupActive && activeAudio && !nativePlaying && mode() === "force") {
        activateFallback("备用发音准备完成");
      }
    });
    document.addEventListener("ielts-native-audio-request-backup", () => {
      // No observed site player means no safe way to stop a Web Audio source.
      // Arm force mode, but do not play concurrently with unknown native audio.
      if (!activeAudio) {
        emit("native-unobserved", "尚未检测到网站音频，请先点击原播放按钮");
        return;
      }
      if (ready() && mode() !== "off") {
        lastBackupReplay = Date.now();
        activateFallback("手动点击接管");
      }
    });
    document.addEventListener("ielts-native-audio-backup-failed", () => {
      backupActive = false;
      backupTicket++;
      clearBackupStartTimer();
      clearWatchdog();
      // A backup that fails must never prevent the user using the site.
      const native = activeAudio;
      if (native && nativePlay && !nativePlaying) {
        try { Promise.resolve(nativePlay.call(native)).catch(() => {}); } catch {}
      }
    });

    function announceReady() {
      const el = root();
      if (!el) return;
      el.setAttribute("data-ielts-native-audio-bridge",
        nativePlay ? "html-media+speaker-v2" : "speaker-only-v2");
      emit("bridge-ready");
    }
    announceReady();
    if (!root()) document.addEventListener("DOMContentLoaded", announceReady, { once: true });
  }
  installAudioTakeoverBridge();

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
