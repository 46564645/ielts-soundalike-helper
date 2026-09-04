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
const extractSpeaking = document.querySelector("#extract-speaking");
const speakingEntryStatus = document.querySelector("#speaking-entry-status");
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
extractSpeaking.addEventListener("click", extractSpeakingMaterial);

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

async function extractSpeakingMaterial() {
  setSpeakingStatus("正在读取当前精听页面…");
  extractSpeaking.disabled = true;
  try {
    if (!deepseekEnabled.checked || !hasDeepseekKey) {
      throw new Error("请先启用 DeepSeek 并保存 API Key");
    }
    const [tab] = await queryActiveTab();
    if (!tab?.id || !isSupportedLearningUrl(tab.url)) {
      throw new Error("请先打开同桌雅思或爱听写的精听页面");
    }
    const page = await sendTabMessage(tab.id, { type: "COLLECT_INTENSIVE_LISTENING_TEXT" });
    if (!page?.ok) throw new Error(page?.error || "未能读取页面，请刷新精听页后再试");
    if (String(page.text || "").length < 120) {
      throw new Error("当前页面文字太少，请先打开文章/字幕内容");
    }
    const job = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: "queued",
      createdAt: Date.now(),
      page: {
        title: String(page.title || tab.title || "精听页面").slice(0, 180),
        url: String(page.url || tab.url || ""),
        text: String(page.text || "").slice(0, 60000),
        originalCharCount: Number(page.originalCharCount || String(page.text || "").length),
        segmentCount: Number(page.segmentCount || 0),
        truncated: Boolean(page.truncated)
      }
    };
    await setLocal({ speakingExtractionJobV1: job });
    setSpeakingStatus(`已读取 ${job.page.originalCharCount.toLocaleString()} 字，正在打开分析页`, "ready");
    chrome.tabs.create({ url: chrome.runtime.getURL(`speaking.html?job=${encodeURIComponent(job.id)}`) });
    window.setTimeout(() => window.close(), 250);
  } catch (error) {
    setSpeakingStatus(error instanceof Error ? error.message : "读取失败，请重试", "error");
    extractSpeaking.disabled = false;
  }
}

function isSupportedLearningUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname === "www.idictation.cn" || hostname === "ielts.itongzhuo.com";
  } catch {
    return false;
  }
}

function queryActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(tabs);
    });
  });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) reject(new Error("插件尚未接入此页面，请刷新精听页后再试"));
      else resolve(response);
    });
  });
}

function setLocal(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve();
    });
  });
}

function setSpeakingStatus(message, state = "") {
  speakingEntryStatus.textContent = message;
  speakingEntryStatus.classList.toggle("error", state === "error");
  speakingEntryStatus.classList.toggle("ready", state === "ready");
}
