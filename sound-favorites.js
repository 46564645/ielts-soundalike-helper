"use strict";

const STORAGE_KEY = "soundSpellingFavoritesV1";
const P = globalThis.IeltsPhonetics;
const list = document.querySelector("#favorite-list");
const empty = document.querySelector("#empty");
const search = document.querySelector("#search");
const accentFilter = document.querySelector("#accent-filter");
const mappingCount = document.querySelector("#mapping-count");
const wordCount = document.querySelector("#word-count");
let favorites = [];
let activeAudio = null;

loadFavorites();
search.addEventListener("input", render);
accentFilter.addEventListener("change", render);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) loadFavorites();
});

function loadFavorites() {
  chrome.storage.local.get({ [STORAGE_KEY]: [] }, (state) => {
    favorites = (Array.isArray(state[STORAGE_KEY]) ? state[STORAGE_KEY] : [])
      .filter(isValidFavorite)
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    render();
  });
}

function render() {
  list.replaceChildren();
  const query = normalize(search.value);
  const accent = accentFilter.value;
  const filtered = favorites.filter((item) => {
    if (accent !== "all" && item.accent !== accent) return false;
    if (!query) return true;
    return normalize(`${item.sound} ${(item.phonemes || []).join(" ")} ${item.grapheme} ${item.word} ${item.ipa}`).includes(query);
  });
  const groups = groupFavorites(filtered);
  mappingCount.textContent = String(groups.length);
  wordCount.textContent = String(filtered.length);
  empty.hidden = groups.length > 0;
  for (const [index, group] of groups.entries()) list.append(renderGroup(group, index));
}

function groupFavorites(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.phonemes.join(" ")}\u0000${normalize(item.grapheme)}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        sound: item.sound || `/${item.phonemes.join("")}/`,
        phonemes: item.phonemes,
        grapheme: item.grapheme,
        lastSavedAt: 0,
        items: []
      });
    }
    const group = groups.get(key);
    group.lastSavedAt = Math.max(group.lastSavedAt, Number(item.createdAt || 0));
    group.items.push(item);
  }
  return [...groups.values()].sort((a, b) => b.items.length - a.items.length || b.lastSavedAt - a.lastSavedAt);
}

function renderGroup(group, index) {
  const section = node("article", "mapping-group");
  const head = node("header", "group-head");
  const title = node("div", "mapping-title");
  const play = textNode("button", group.sound, "play-sound");
  play.type = "button";
  play.title = `播放 ${group.sound}`;
  play.addEventListener("click", () => playPhonemes(group.phonemes));
  title.append(
    textNode("span", String(index + 1), "rank"),
    play,
    textNode("span", "→", "arrow"),
    textNode("strong", group.grapheme, "grapheme")
  );
  head.append(title, textNode("span", `${group.items.length} 个单词`, "count"));

  const grid = node("div", "word-grid");
  for (const item of group.items) grid.append(renderWord(item));
  section.append(head, grid);
  return section;
}

function renderWord(item) {
  const card = node("article", "word-card");
  const details = node("div");
  const line = node("div", "word-line");
  line.append(
    textNode("strong", item.word),
    textNode("span", item.accent === "uk" ? "英式" : "美式", "accent")
  );
  details.append(line, textNode("div", item.ipa ? `/${item.ipa}/` : "/暂无音标/", "word-ipa"));

  const actions = node("div", "word-actions");
  const play = textNode("button", "🔊", "play-word");
  play.type = "button";
  play.title = `播放 ${item.word}`;
  play.addEventListener("click", () => playWord(item, play));
  const remove = textNode("button", "×", "remove");
  remove.type = "button";
  remove.title = `取消收藏 ${item.word} 中的 ${item.sound} → ${item.grapheme}`;
  remove.setAttribute("aria-label", remove.title);
  remove.addEventListener("click", () => removeFavorite(item.id));
  actions.append(play, remove);
  card.append(details, actions);
  return card;
}

function playPhonemes(phonemes) {
  const urls = (phonemes || []).flatMap((token) => P.phonemeAudioFiles(token))
    .map((file) => chrome.runtime.getURL(`audio/phonemes/kk/${file}`));
  playSequence(urls);
}

function playSequence(urls) {
  if (activeAudio) {
    activeAudio.pause();
    activeAudio = null;
  }
  const queue = [...(urls || [])];
  const next = () => {
    const url = queue.shift();
    if (!url) return;
    activeAudio = new Audio(url);
    activeAudio.addEventListener("ended", next, { once: true });
    activeAudio.addEventListener("error", next, { once: true });
    activeAudio.play().catch(next);
  };
  next();
}

function playWord(item, button) {
  if (button.disabled) return;
  button.disabled = true;
  chrome.runtime.sendMessage({ type: "GET_COMPARISON_AUDIO", word: item.word, accent: item.accent }, (response) => {
    button.disabled = false;
    if (chrome.runtime.lastError || !response?.audioUrl) return;
    playSequence([response.audioUrl]);
  });
}

function removeFavorite(id) {
  chrome.storage.local.get({ [STORAGE_KEY]: [] }, (state) => {
    const stored = Array.isArray(state[STORAGE_KEY]) ? state[STORAGE_KEY] : [];
    chrome.storage.local.set({ [STORAGE_KEY]: stored.filter((item) => item?.id !== id) });
  });
}

function isValidFavorite(item) {
  return Boolean(
    item &&
    item.id &&
    item.word &&
    item.grapheme &&
    Array.isArray(item.phonemes) &&
    item.phonemes.length
  );
}

function normalize(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
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
