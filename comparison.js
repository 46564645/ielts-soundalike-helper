"use strict";

const COMPARISONS_KEY = "pronunciationComparisonsV1";
const list = document.querySelector("#comparison-list");
const empty = document.querySelector("#empty");
const search = document.querySelector("#search");
const accentFilter = document.querySelector("#accent-filter");
const groupCount = document.querySelector("#group-count");
const pairCount = document.querySelector("#pair-count");
let comparisons = [];
let activeAudio = null;
let activeAudioRestore = null;
const wordAudioCache = new Map();
const wordAudioPending = new Map();
const wordAudioLoaders = new WeakMap();
const wordAudioObserver = "IntersectionObserver" in window
  ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        wordAudioObserver.unobserve(entry.target);
        wordAudioLoaders.get(entry.target)?.();
      }
    }, { rootMargin: "420px 0px" })
  : null;
const pluralUsageCache = new Map();
const pluralUsagePending = new Map();
const pluralLoaders = new WeakMap();
const pluralObserver = "IntersectionObserver" in window
  ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        pluralObserver.unobserve(entry.target);
        pluralLoaders.get(entry.target)?.();
      }
    }, { rootMargin: "280px 0px" })
  : null;

loadComparisons();
search.addEventListener("input", render);
accentFilter.addEventListener("change", render);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[COMPARISONS_KEY]) loadComparisons();
});

function loadComparisons() {
  chrome.storage.local.get({ [COMPARISONS_KEY]: [] }, (state) => {
    comparisons = (Array.isArray(state[COMPARISONS_KEY]) ? state[COMPARISONS_KEY] : [])
      .filter(isValidComparison)
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    render();
  });
}

function render() {
  pluralObserver?.disconnect();
  wordAudioObserver?.disconnect();
  list.replaceChildren();
  const query = normalize(search.value);
  const accent = accentFilter.value;
  const filtered = comparisons.filter((item) => {
    if (accent !== "all" && item.accent !== accent) return false;
    if (!query) return true;
    return normalize(`${item.target.word} ${item.target.meaning} ${item.candidate.word} ${item.candidate.meaning}`).includes(query);
  });
  const groups = groupComparisons(filtered);
  groupCount.textContent = String(groups.length);
  pairCount.textContent = String(filtered.length);
  empty.hidden = groups.length > 0;
  for (const group of groups) list.append(renderGroup(group));
}

function groupComparisons(items) {
  const map = new Map();
  for (const item of items) {
    const key = `${item.accent}:${normalize(item.target.word)}`;
    if (!map.has(key)) map.set(key, { key, accent: item.accent, target: item.target, items: [] });
    map.get(key).items.push(item);
  }
  return [...map.values()].sort((a, b) => Number(b.items[0]?.createdAt || 0) - Number(a.items[0]?.createdAt || 0));
}

function renderGroup(group) {
  const section = node("article", "comparison-group");
  const heading = node("header", "group-heading");
  const title = node("div");
  title.append(
    textNode("strong", `${group.target.word} 的对比组`),
    textNode("span", group.accent === "uk" ? "英式" : "美式", "accent-badge"),
    textNode("span", `${group.items.length} 个收藏词`, "count-badge")
  );
  const removeGroup = textNode("button", "删除整组", "remove-group");
  removeGroup.type = "button";
  removeGroup.addEventListener("click", () => removeRecords(group.items.map((item) => item.id)));
  heading.append(title, removeGroup);

  const grid = node("div", "group-grid");
  const targetColumn = node("div", "target-column");
  targetColumn.append(textNode("span", "本题原词", "target-label"), renderWordCard(group.target, group.accent));
  const candidateColumn = node("div", "candidate-column");
  const stack = node("div", "candidate-stack");
  candidateColumn.append(textNode("span", "收藏的相似词", "candidate-label"), stack);
  for (const item of group.items) stack.append(renderWordCard(item.candidate, item.accent, item.id));
  grid.append(targetColumn, candidateColumn);
  section.append(heading, grid);
  return section;
}

function renderWordCard(word, accent, recordId = "") {
  const card = node("article", "word-card");
  const details = node("div");
  const title = node("div", "word-title");
  title.append(textNode("strong", word.word));
  details.append(
    title,
    textNode("div", word.ipa ? `/${word.ipa}/` : "/暂无音标/", "ipa"),
    textNode("p", word.meaning || "暂无中文释义", "meaning")
  );
  const pluralBox = node("section", "plural-box loading");
  pluralBox.setAttribute("aria-label", `${word.word} 的复数用法`);
  pluralBox.append(textNode("strong", "复数用法分析中…", "plural-loading"));
  details.append(pluralBox);
  schedulePluralUsage(word.word, accent, pluralBox);
  const play = textNode("button", "🔊", "play-word");
  play.type = "button";
  play.disabled = true;
  play.classList.add("loading");
  play.title = `播放 ${word.word} 的${accent === "uk" ? "英式" : "美式"}发音`;
  play.setAttribute("aria-label", play.title);
  let preparedAudioUrl = "";
  scheduleWordAudio(play, word.word, accent, (audioUrl) => {
    preparedAudioUrl = audioUrl;
    play.disabled = false;
    play.classList.remove("loading");
  });
  play.addEventListener("click", () => playWord(word.word, accent, play, preparedAudioUrl));
  card.append(details, play);
  if (recordId) {
    const remove = textNode("button", "取消收藏", "remove-pair");
    remove.type = "button";
    remove.addEventListener("click", () => removeRecords([recordId]));
    card.append(remove);
  }
  return card;
}

function schedulePluralUsage(word, accent, container) {
  const load = () => loadPluralUsage(word, accent, container);
  if (!pluralObserver) {
    load();
    return;
  }
  pluralLoaders.set(container, load);
  pluralObserver.observe(container);
}

function loadPluralUsage(word, accent, container) {
  const key = `${accent}:${normalize(word)}`;
  if (pluralUsageCache.has(key)) {
    renderPluralUsage(container, pluralUsageCache.get(key), word, accent);
    return;
  }
  let pending = pluralUsagePending.get(key);
  if (!pending) {
    pending = new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "PREPARE_PLURAL_USAGE", word, accent }, (response) => {
        resolve(chrome.runtime.lastError
          ? { ok: false, configured: true, available: false, error: "复数说明暂时无法加载" }
          : response || { ok: false, configured: true, available: false });
      });
    }).then((response) => {
      pluralUsageCache.set(key, response);
      pluralUsagePending.delete(key);
      return response;
    });
    pluralUsagePending.set(key, pending);
  }
  pending.then((response) => renderPluralUsage(container, response, word, accent));
}

function renderPluralUsage(container, response, baseWord, accent) {
  container.replaceChildren();
  container.classList.remove("loading", "unavailable");
  if (!response?.configured) {
    container.classList.add("unavailable");
    container.append(textNode("strong", "配置 DeepSeek 后显示复数形式与可数用法", "plural-note"));
    return;
  }
  if (!response.ok || !response.available || !response.data) {
    container.classList.add("unavailable");
    container.append(textNode("strong", response?.error || "复数用法暂时无法加载", "plural-note"));
    return;
  }
  const data = response.data;
  const line = node("div", "plural-line");
  line.append(
    textNode("span", "复数", "plural-label"),
    textNode("strong", data.plural || "无常用复数", "plural-word"),
    textNode("span", nounTypeLabel(data.nounType), `noun-type ${data.nounType || "not_noun"}`)
  );
  if (data.plural) {
    const play = textNode("button", "🔊", "plural-play");
    play.type = "button";
    play.disabled = true;
    play.title = `播放 ${data.plural} 的发音`;
    let preparedAudioUrl = "";
    prepareWordAudio(data.plural, accent).then((audioUrl) => {
      preparedAudioUrl = audioUrl;
      play.disabled = false;
    });
    play.addEventListener("click", () => playWord(data.plural, accent, play, preparedAudioUrl));
    line.append(play);
  }
  container.append(line);
  if (data.plural) {
    container.append(textNode("div", data.pluralIpa ? `/${data.pluralIpa}/` : "复数音标暂缺", "plural-ipa"));
  }
  container.append(textNode("strong", data.note || `${baseWord} 的复数用法请结合语境判断。`, "plural-note"));
}

function nounTypeLabel(value) {
  if (value === "countable") return "可数";
  if (value === "uncountable") return "不可数";
  if (value === "both") return "可数/不可数";
  return "非名词用法";
}

function prepareWordAudio(word, accent) {
  const key = `${accent}:${normalize(word)}`;
  if (wordAudioCache.has(key)) return Promise.resolve(wordAudioCache.get(key));
  if (wordAudioPending.has(key)) return wordAudioPending.get(key);
  const pending = new Promise((resolve) => {
    let settled = false;
    const finish = (audioUrl = "") => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      wordAudioCache.set(key, audioUrl);
      wordAudioPending.delete(key);
      resolve(audioUrl);
    };
    const timeout = window.setTimeout(() => finish(""), 8000);
    chrome.runtime.sendMessage({ type: "GET_COMPARISON_AUDIO", word, accent }, (response) => {
      finish(chrome.runtime.lastError || !response?.ok ? "" : response.audioUrl || "");
    });
  });
  wordAudioPending.set(key, pending);
  return pending;
}

function scheduleWordAudio(button, word, accent, onReady) {
  const load = () => prepareWordAudio(word, accent).then(onReady);
  if (!wordAudioObserver) {
    load();
    return;
  }
  wordAudioLoaders.set(button, load);
  wordAudioObserver.observe(button);
}

function stopWordAudio() {
  if (activeAudio) {
    activeAudio.pause();
    activeAudio.currentTime = 0;
    activeAudio = null;
  }
  activeAudioRestore?.();
  activeAudioRestore = null;
}

function playWord(word, accent, button, audioUrl = "") {
  stopWordAudio();
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    button.classList.remove("playing");
    button.setAttribute("aria-pressed", "false");
    if (activeAudioRestore === restore) activeAudioRestore = null;
  };
  activeAudioRestore = restore;
  button.classList.add("playing");
  button.setAttribute("aria-pressed", "true");
  if (!audioUrl) {
    speakWord(word, accent);
    restore();
    return;
  }
  const audio = new Audio(audioUrl);
  activeAudio = audio;
  audio.addEventListener("ended", restore, { once: true });
  audio.addEventListener("error", () => {
    speakWord(word, accent);
    restore();
  }, { once: true });
  audio.play().catch(() => {
    speakWord(word, accent);
    restore();
  });
}

function speakWord(word, accent) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(word);
  utterance.lang = accent === "uk" ? "en-GB" : "en-US";
  window.speechSynthesis.speak(utterance);
}

function removeRecords(ids) {
  const removed = new Set(ids);
  chrome.storage.local.set({
    [COMPARISONS_KEY]: comparisons.filter((item) => !removed.has(item.id))
  });
}

function isValidComparison(item) {
  return Boolean(item?.id && item?.target?.word && item?.candidate?.word);
}

function normalize(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function node(tag, className = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function textNode(tag, text, className = "") {
  const element = node(tag, className);
  element.textContent = text;
  return element;
}
