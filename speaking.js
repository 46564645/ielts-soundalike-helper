"use strict";

const JOB_KEY = "speakingExtractionJobV1";
const FAVORITES_KEY = "speakingMaterialFavoritesV1";
const jobId = new URLSearchParams(location.search).get("job") || "";
const statusPanel = document.querySelector("#status-panel");
const statusTitle = document.querySelector("#status-title");
const statusCopy = document.querySelector("#status-copy");
const retry = document.querySelector("#retry");
const resultShell = document.querySelector("#result-shell");
const phraseList = document.querySelector("#phrase-list");
const empty = document.querySelector("#empty");
const summary = document.querySelector("#summary");
const sourceMeta = document.querySelector("#source-meta");
const phraseCount = document.querySelector("#phrase-count");
const textCount = document.querySelector("#text-count");
const resultCount = document.querySelector("#result-count");
const favoriteCount = document.querySelector("#favorite-count");
const search = document.querySelector("#search");
const tabs = [...document.querySelectorAll("[data-view]")];
let job = null;
let favorites = [];
let view = "result";
let accent = "us";
let activeSpeechButton = null;

initialize();

async function initialize() {
  const [local, sync] = await Promise.all([
    getLocal({ [JOB_KEY]: null, [FAVORITES_KEY]: [] }),
    getSync({ accent: "us" })
  ]);
  job = local[JOB_KEY];
  favorites = Array.isArray(local[FAVORITES_KEY]) ? local[FAVORITES_KEY] : [];
  accent = sync.accent === "uk" ? "uk" : "us";
  render();
  if (job && String(job.id) === jobId && job.status === "queued") requestAnalysis();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[JOB_KEY]) job = changes[JOB_KEY].newValue;
  if (changes[FAVORITES_KEY]) favorites = Array.isArray(changes[FAVORITES_KEY].newValue) ? changes[FAVORITES_KEY].newValue : [];
  render();
});

for (const tab of tabs) tab.addEventListener("click", () => {
  view = tab.dataset.view;
  for (const item of tabs) {
    const selected = item === tab;
    item.classList.toggle("active", selected);
    item.setAttribute("aria-selected", String(selected));
  }
  renderList();
});
search.addEventListener("input", renderList);
retry.addEventListener("click", async () => {
  if (!job || String(job.id) !== jobId) return;
  job = { ...job, status: "queued", error: "" };
  await setLocal({ [JOB_KEY]: job });
  requestAnalysis();
});

function requestAnalysis() {
  retry.hidden = true;
  chrome.runtime.sendMessage({ type: "ANALYZE_SPEAKING_MATERIAL", jobId }, (response) => {
    if (chrome.runtime.lastError) showRequestError("分析连接中断，请重新分析");
    else if (!response?.ok) showRequestError(response?.error || "分析失败，请重试");
  });
}

function showRequestError(message) {
  if (job?.status === "complete") return;
  job = { ...job, status: "error", error: message };
  render();
}

function render() {
  const validJob = job && (!jobId || String(job.id) === jobId);
  if (!validJob) {
    showStatus("没有找到精听任务", "请回到精听页面，点击插件中的“开始提取”。", true);
    return;
  }
  const count = Number(job.page?.originalCharCount || String(job.page?.text || "").length);
  sourceMeta.textContent = `${job.page?.title || "精听页面"} · ${job.page?.segmentCount || 0} 段文本${job.page?.truncated ? " · 原文较长，已截取前 60,000 字" : ""}`;
  textCount.textContent = `${count.toLocaleString()} 字原文`;
  favoriteCount.textContent = String(favorites.length);
  if (job.status === "error") {
    showStatus("本次分析没有完成", job.error || "请检查网络与 DeepSeek 设置后重试。", true);
    return;
  }
  if (job.status !== "complete" || !job.result) {
    showStatus("正在分析精听原文", "会优先筛选自然、可迁移的雅思口语词组，通常需要几十秒。", false);
    return;
  }
  statusPanel.classList.add("done");
  resultShell.hidden = false;
  const phrases = Array.isArray(job.result.phrases) ? job.result.phrases : [];
  phraseCount.textContent = String(phrases.length);
  resultCount.textContent = String(phrases.length);
  summary.textContent = job.result.summary || "已按雅思口语实用度完成筛选。";
  renderList();
}

function showStatus(title, copy, isError) {
  statusPanel.classList.remove("done");
  statusPanel.classList.toggle("error", isError);
  resultShell.hidden = true;
  statusTitle.textContent = title;
  statusCopy.textContent = copy;
  retry.hidden = !isError || !job;
}

function renderList() {
  if (!job?.result) return;
  phraseList.replaceChildren();
  const source = view === "favorites" ? favorites : job.result.phrases;
  const query = normalize(search.value);
  const filtered = source.filter((item) => !query || normalize(`${item.phrase} ${item.meaningZh} ${item.usageZh} ${(item.topics || []).join(" ")}`).includes(query));
  empty.hidden = filtered.length > 0;
  for (const phrase of filtered) phraseList.append(renderPhrase(phrase));
}

function renderPhrase(item) {
  const card = node("article", "phrase-card");
  const body = node("div");
  const heading = node("div", "phrase-heading");
  heading.append(textNode("h2", item.phrase), textNode("span", item.register || "自然口语", "register"));
  body.append(heading, textNode("p", item.meaningZh || "", "meaning"), textNode("p", item.usageZh || "", "usage"));
  const topics = node("div", "topics");
  for (const topic of item.topics || []) topics.append(textNode("span", topic, "topic"));
  body.append(topics);
  const examples = node("div", "examples");
  if (item.sourceSentence) examples.append(renderExample("原文语境", item.sourceSentence, "source"));
  if (item.example) examples.append(renderExample("口语例句", item.example, "", item.exampleZh));
  body.append(examples);

  const actions = node("div", "card-actions");
  const speak = textNode("button", "🔊 播放词组", "speak");
  speak.type = "button";
  speak.addEventListener("click", () => speakPhrase(item.phrase, speak));
  const favorite = textNode("button", "", "favorite");
  favorite.type = "button";
  updateFavoriteButton(favorite, item.id);
  favorite.addEventListener("click", () => toggleFavorite(item));
  actions.append(speak, favorite);
  card.append(body, actions);
  return card;
}

function renderExample(label, english, className = "", chinese = "") {
  const box = node("div", `example ${className}`.trim());
  box.append(textNode("span", label), textNode("p", english));
  if (chinese) box.append(textNode("small", chinese));
  return box;
}

function speakPhrase(phrase, button) {
  if (!("speechSynthesis" in window)) return;
  if (activeSpeechButton === button && button.classList.contains("playing")) {
    speechSynthesis.cancel();
    button.classList.remove("playing");
    button.textContent = "🔊 播放词组";
    activeSpeechButton = null;
    return;
  }
  speechSynthesis.cancel();
  if (activeSpeechButton) {
    activeSpeechButton.classList.remove("playing");
    activeSpeechButton.textContent = "🔊 播放词组";
  }
  const utterance = new SpeechSynthesisUtterance(phrase);
  utterance.lang = accent === "uk" ? "en-GB" : "en-US";
  utterance.rate = .86;
  const voice = speechSynthesis.getVoices().find((item) => item.lang.toLowerCase().startsWith(accent === "uk" ? "en-gb" : "en-us"));
  if (voice) utterance.voice = voice;
  activeSpeechButton = button;
  button.classList.add("playing");
  button.textContent = "■ 停止播放";
  const restore = () => {
    if (activeSpeechButton !== button) return;
    button.classList.remove("playing");
    button.textContent = "🔊 播放词组";
    activeSpeechButton = null;
  };
  utterance.onend = restore;
  utterance.onerror = restore;
  speechSynthesis.speak(utterance);
}

async function toggleFavorite(item) {
  const exists = favorites.some((favorite) => favorite.id === item.id);
  favorites = exists
    ? favorites.filter((favorite) => favorite.id !== item.id)
    : [{ ...item, savedAt: Date.now(), sourceTitle: job?.page?.title || "精听页面" }, ...favorites].slice(0, 300);
  await setLocal({ [FAVORITES_KEY]: favorites });
}

function updateFavoriteButton(button, id) {
  const saved = favorites.some((item) => item.id === id);
  button.classList.toggle("saved", saved);
  button.textContent = saved ? "✓ 取消收藏" : "♡ 收藏词组";
}

function getLocal(defaults) { return new Promise((resolve) => chrome.storage.local.get(defaults, resolve)); }
function getSync(defaults) { return new Promise((resolve) => chrome.storage.sync.get(defaults, resolve)); }
function setLocal(value) { return new Promise((resolve, reject) => chrome.storage.local.set(value, () => chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve())); }
function normalize(value) { return String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim(); }
function node(tag, className = "") { const item = document.createElement(tag); if (className) item.className = className; return item; }
function textNode(tag, text, className = "") { const item = node(tag, className); item.textContent = text; return item; }
