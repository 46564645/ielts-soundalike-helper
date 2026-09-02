"use strict";

const DEFAULTS = { enabled: true, accent: "us" };
const LOCAL_DEFAULTS = {
  soundErrorProfileV1: null,
  deepseekEnabled: true,
  deepseekApiKey: "",
  deepseekModel: "deepseek-v4-flash"
};
const enabled = document.querySelector("#enabled");
const accents = [...document.querySelectorAll('input[name="accent"]')];
const reopen = document.querySelector("#reopen");
const saved = document.querySelector("#saved");
const learningStats = document.querySelector("#learning-stats");
const deepseekEnabled = document.querySelector("#deepseek-enabled");
const deepseekApiKey = document.querySelector("#deepseek-api-key");
const saveDeepseek = document.querySelector("#save-deepseek");
const clearDeepseek = document.querySelector("#clear-deepseek");
const deepseekStatus = document.querySelector("#deepseek-status");
let savedTimer = 0;
let hasDeepseekKey = false;

chrome.storage.sync.get(DEFAULTS, (settings) => {
  enabled.checked = settings.enabled !== false;
  const selected = accents.find((input) => input.value === settings.accent) || accents[0];
  selected.checked = true;
});

chrome.storage.local.get(LOCAL_DEFAULTS, (state) => {
  const profile = state.soundErrorProfileV1;
  const patterns = profile?.patterns ? Object.keys(profile.patterns).length : 0;
  const attempts = Number(profile?.totalIncorrectAttempts || 0);
  learningStats.textContent = attempts ? `${patterns} 类映射 · ${attempts} 次错答` : "尚无错题记录";
  deepseekEnabled.checked = state.deepseekEnabled !== false;
  hasDeepseekKey = Boolean(String(state.deepseekApiKey || "").trim());
  updateDeepseekStatus();
});

enabled.addEventListener("change", persist);
for (const input of accents) input.addEventListener("change", persist);
deepseekEnabled.addEventListener("change", () => {
  chrome.storage.local.set({
    deepseekEnabled: deepseekEnabled.checked,
    deepseekModel: "deepseek-v4-flash"
  }, () => {
    updateDeepseekStatus();
    showSaved("DeepSeek 设置已保存");
  });
});
saveDeepseek.addEventListener("click", () => {
  const apiKey = String(deepseekApiKey.value || "").trim();
  if (!apiKey) {
    showSaved(hasDeepseekKey ? "已有 Key，无需重复输入" : "请先输入 API Key");
    deepseekApiKey.focus();
    return;
  }
  chrome.storage.local.set({
    deepseekApiKey: apiKey,
    deepseekEnabled: deepseekEnabled.checked,
    deepseekModel: "deepseek-v4-flash"
  }, () => {
    hasDeepseekKey = true;
    deepseekApiKey.value = "";
    updateDeepseekStatus();
    showSaved("API Key 已保存到本机");
  });
});
clearDeepseek.addEventListener("click", () => {
  chrome.storage.local.set({ deepseekApiKey: "", deepseekWordCacheV1: {} }, () => {
    hasDeepseekKey = false;
    deepseekApiKey.value = "";
    updateDeepseekStatus();
    showSaved("API Key 与解释缓存已清除");
  });
});
reopen.addEventListener("click", () => {
  chrome.storage.sync.set({ overlayReopenNonce: Date.now() }, () => showSaved("已请求重新显示"));
});

function persist() {
  const accent = accents.find((input) => input.checked)?.value === "uk" ? "uk" : "us";
  chrome.storage.sync.set({ enabled: enabled.checked, accent }, () => showSaved("设置已保存"));
}

function updateDeepseekStatus() {
  deepseekStatus.classList.toggle("ready", hasDeepseekKey && deepseekEnabled.checked);
  if (!hasDeepseekKey) {
    deepseekStatus.textContent = "尚未保存 API Key";
    deepseekApiKey.placeholder = "输入 DeepSeek API Key";
  } else if (!deepseekEnabled.checked) {
    deepseekStatus.textContent = "API Key 已保存；DeepSeek 当前关闭";
    deepseekApiKey.placeholder = "已保存（输入新 Key 可替换）";
  } else {
    deepseekStatus.textContent = "已配置：快速模型将在词载入时预取";
    deepseekApiKey.placeholder = "已保存（输入新 Key 可替换）";
  }
}

function showSaved(message) {
  window.clearTimeout(savedTimer);
  saved.textContent = message;
  saved.classList.add("show");
  savedTimer = window.setTimeout(() => saved.classList.remove("show"), 1500);
}
