"use strict";

importScripts("data/vocabulary.js", "data/priority-words.js", "lib/phonetics.js", "lib/correction.js");

const P = globalThis.IeltsPhonetics;
const C = globalThis.IeltsCorrection;
const VOCABULARY = globalThis.IELTS_VOCABULARY || [];
const CORPUS_SUMMARY = globalThis.IELTS_CORPUS_SUMMARY || { total: VOCABULARY.length };
const BY_WORD = new Map(VOCABULARY.map((item) => [P.normalizeWord(item.word), item]));
const ipaCache = new Map();
const audioCache = new Map();
const MAX_AUDIO_CACHE = 120;
const PROFILE_KEY = "soundErrorProfileV1";
const DEEPSEEK_CACHE_KEY = "deepseekWordCacheV1";
const DEEPSEEK_CACHE_MAX = 120;
const DEEPSEEK_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const PLURAL_CACHE_KEY = "deepseekPluralCacheV1";
const PLURAL_CACHE_MAX = 400;
const PLURAL_CACHE_TTL = 90 * 24 * 60 * 60 * 1000;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "PREPARE_WORD") {
    prepareWord(message.word, message.accent)
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }
  if (message?.type === "PREPARE_TYPED_CANDIDATE") {
    prepareTypedCandidate(message.typed, message.correct, message.accent)
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => sendResponse({ ok: false, found: false, error: readableError(error) }));
    return true;
  }
  if (message?.type === "RESOLVE_CLUE") {
    try {
      sendResponse({ ok: true, ...resolveWordFromClue(message.ipa, message.meaning) });
    } catch (error) {
      sendResponse({ ok: false, error: readableError(error) });
    }
    return false;
  }
  if (message?.type === "PREPARE_DEEPSEEK_WORD") {
    prepareDeepseekWord(message.word)
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => sendResponse({ ok: false, configured: true, error: readableError(error) }));
    return true;
  }
  if (message?.type === "ANALYZE_ATTEMPT") {
    analyzeAttemptMessage(message)
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }
  if (message?.type === "GET_LEARNING_STATE") {
    getLearningState()
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }
  if (message?.type === "GET_COMPARISON_AUDIO") {
    getComparisonAudio(message.word, message.accent)
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }
  if (message?.type === "PREPARE_PLURAL_USAGE") {
    preparePluralUsage(message.word, message.accent)
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => sendResponse({ ok: false, configured: true, available: false, error: readableError(error) }));
    return true;
  }
  if (message?.type === "CORPUS_STATUS") {
    sendResponse({ ok: true, ...CORPUS_SUMMARY });
  }
  return false;
});

async function getComparisonAudio(rawWord, rawAccent) {
  const word = String(rawWord || "").trim();
  const key = P.normalizeWord(word);
  if (!key) return { available: false, audioUrl: "" };
  const accent = normalizeAccent(rawAccent);
  const item = BY_WORD.get(key) || { word, key, ukSpeech: "" };
  const audioUrl = await fetchAudio(item, accent).catch(() => fallbackAudioUrl(item, accent));
  return { available: Boolean(audioUrl), audioUrl, word: item.word || word, accent };
}

async function preparePluralUsage(rawWord, rawAccent) {
  const key = P.normalizeWord(rawWord);
  const accent = normalizeAccent(rawAccent);
  if (!key) return { configured: false, available: false };
  const state = await storageGet({
    deepseekEnabled: true,
    deepseekApiKey: "",
    [PLURAL_CACHE_KEY]: {}
  });
  const apiKey = String(state.deepseekApiKey || "").trim();
  if (state.deepseekEnabled === false || !apiKey) {
    return { configured: false, available: false };
  }
  const cache = state[PLURAL_CACHE_KEY] && typeof state[PLURAL_CACHE_KEY] === "object"
    ? state[PLURAL_CACHE_KEY]
    : {};
  const cached = cache[key];
  if (cached?.data && Date.now() - Number(cached.savedAt || 0) < PLURAL_CACHE_TTL) {
    return {
      configured: true,
      available: true,
      cached: true,
      data: await enrichPluralPronunciation(cached.data, accent)
    };
  }

  const item = BY_WORD.get(key);
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [
        {
          role: "system",
          content: "你是英语语法与雅思词汇教师。只输出合法 JSON，不使用 Markdown。回答必须简洁准确。"
        },
        {
          role: "user",
          content: `分析词条 ${item?.word || key}${item?.meaning ? `（${item.meaning}）` : ""} 的名词复数用法。输出 JSON：{"plural":"一个最常用的标准复数拼写；不可数或不是名词则为空字符串","nounType":"countable|uncountable|both|not_noun","note":"不超过55个中文字符，明确说明是否可数、通常是否使用复数、何时加复数"}。若一个词兼有多种词性，请以给出的中文释义和雅思常见用法为准。`
        }
      ],
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
      max_tokens: 320,
      stream: false
    }),
    signal: AbortSignal.timeout(18000)
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("DeepSeek API Key 无效或无权限");
    if (response.status === 402) throw new Error("DeepSeek 账户余额不足");
    if (response.status === 429) throw new Error("DeepSeek 请求过于频繁，请稍后再试");
    throw new Error(`DeepSeek API 返回 ${response.status}`);
  }
  const payload = await response.json();
  const content = String(payload?.choices?.[0]?.message?.content || "").trim();
  if (!content) throw new Error("DeepSeek 没有返回复数说明");
  let parsed;
  try {
    parsed = JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""));
  } catch {
    throw new Error("DeepSeek 返回的复数 JSON 无法解析");
  }
  const data = normalizePluralUsage(parsed);
  if (!data.note) throw new Error("DeepSeek 返回的复数说明为空");
  cache[key] = { savedAt: Date.now(), data };
  const trimmed = Object.fromEntries(
    Object.entries(cache)
      .sort((a, b) => Number(b[1]?.savedAt || 0) - Number(a[1]?.savedAt || 0))
      .slice(0, PLURAL_CACHE_MAX)
  );
  await storageSet({ [PLURAL_CACHE_KEY]: trimmed });
  return {
    configured: true,
    available: true,
    cached: false,
    data: await enrichPluralPronunciation(data, accent)
  };
}

function normalizePluralUsage(value) {
  const nounTypes = new Set(["countable", "uncountable", "both", "not_noun"]);
  const rawPlural = String(value?.plural || "").replace(/\s+/g, " ").trim();
  const plural = /^[A-Za-z][A-Za-z'’\- ]{0,118}$/.test(rawPlural) ? rawPlural : "";
  const nounType = nounTypes.has(value?.nounType) ? value.nounType : "not_noun";
  return {
    plural: nounType === "uncountable" || nounType === "not_noun" ? "" : plural,
    nounType,
    note: String(value?.note || "").replace(/\s+/g, " ").trim().slice(0, 100)
  };
}

async function enrichPluralPronunciation(data, accent) {
  if (!data?.plural) return { ...data, pluralIpa: "" };
  const pluralKey = P.normalizeWord(data.plural);
  const pluralItem = BY_WORD.get(pluralKey) || { word: data.plural, key: pluralKey, ukIpa: "", ukSpeech: "" };
  const resolved = await resolveIpa(pluralItem, accent).catch(() => ({ ipa: "" }));
  return { ...data, pluralIpa: P.cleanIpa(resolved.ipa) };
}

function resolveWordFromClue(rawIpa, rawMeaning) {
  const clueTokens = P.tokenizeIpa(rawIpa).join(" ");
  if (!clueTokens) return { found: false };
  const clueMeaning = normalizeClueMeaning(rawMeaning);
  const matches = VOCABULARY
    .filter((item) => P.tokenizeIpa(item.ukIpa).join(" ") === clueTokens)
    .map((item) => ({ item, score: meaningMatchScore(clueMeaning, normalizeClueMeaning(item.meaning)) }))
    .sort((a, b) => b.score - a.score || a.item.word.localeCompare(b.item.word));
  if (!matches.length) return { found: false };
  const best = matches[0];
  return {
    found: true,
    word: best.item.word,
    ipa: best.item.ukIpa,
    meaning: best.item.meaning,
    confidence: best.score >= 1 ? "ipa+meaning" : "ipa"
  };
}

function normalizeClueMeaning(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\b(?:n|v|adj|adv|prep|pron|conj|num|art|aux|modal)\.?\b/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function meaningMatchScore(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 10;
  if (left.includes(right) || right.includes(left)) return 6;
  const leftChars = new Set(Array.from(left));
  const rightChars = new Set(Array.from(right));
  let overlap = 0;
  for (const char of leftChars) if (rightChars.has(char)) overlap += 1;
  return overlap / Math.max(1, Math.min(leftChars.size, rightChars.size));
}

async function prepareDeepseekWord(rawWord) {
  const key = P.normalizeWord(rawWord);
  if (!key) return { configured: false, available: false };
  const state = await storageGet({
    deepseekEnabled: true,
    deepseekApiKey: "",
    deepseekModel: "deepseek-v4-flash",
    [DEEPSEEK_CACHE_KEY]: {}
  });
  const apiKey = String(state.deepseekApiKey || "").trim();
  if (state.deepseekEnabled === false || !apiKey) {
    return { configured: false, available: false };
  }
  const cache = state[DEEPSEEK_CACHE_KEY] && typeof state[DEEPSEEK_CACHE_KEY] === "object"
    ? state[DEEPSEEK_CACHE_KEY]
    : {};
  const cached = cache[key];
  if (cached?.data && Date.now() - Number(cached.savedAt || 0) < DEEPSEEK_CACHE_TTL) {
    return { configured: true, available: true, cached: true, data: cached.data };
  }

  const item = BY_WORD.get(key);
  const model = "deepseek-v4-flash";
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "你是雅思英语词汇教师。只输出合法 JSON，不使用 Markdown。解释必须准确、简洁、面向中国学习者。"
        },
        {
          role: "user",
          content: `分析单词 ${item?.word || key}${item?.meaning ? `（${item.meaning}）` : ""}。输出 JSON：{"synonymDifferences":[{"word":"同义词","difference":"与目标词的核心差别","scenarios":["适用场景"],"example":"英文例句及简短中文说明"}],"expressions":[{"phrase":"常用表达或词组","register":"口语|写作|通用","meaning":"中文含义和使用说明","example":"英文例句"}]}。同义词区给 3 至 5 项，重点解释应用场景区别；表达区给 4 至 6 个常用口语或雅思写作表达。`
        }
      ],
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
      max_tokens: 1100,
      stream: false
    }),
    signal: AbortSignal.timeout(22000)
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("DeepSeek API Key 无效或无权限");
    if (response.status === 402) throw new Error("DeepSeek 账户余额不足");
    if (response.status === 429) throw new Error("DeepSeek 请求过于频繁，请稍后再试");
    throw new Error(`DeepSeek API 返回 ${response.status}`);
  }
  const payload = await response.json();
  const content = String(payload?.choices?.[0]?.message?.content || "").trim();
  if (!content) throw new Error("DeepSeek 没有返回内容");
  let parsed;
  try {
    parsed = JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""));
  } catch {
    throw new Error("DeepSeek 返回的 JSON 无法解析");
  }
  const data = normalizeDeepseekData(parsed);
  if (!data.synonymDifferences.length && !data.expressions.length) throw new Error("DeepSeek 返回内容为空");
  cache[key] = { savedAt: Date.now(), model, data };
  const trimmed = Object.fromEntries(
    Object.entries(cache)
      .sort((a, b) => Number(b[1]?.savedAt || 0) - Number(a[1]?.savedAt || 0))
      .slice(0, DEEPSEEK_CACHE_MAX)
  );
  await storageSet({ [DEEPSEEK_CACHE_KEY]: trimmed });
  return { configured: true, available: true, cached: false, data };
}

function normalizeDeepseekData(value) {
  const clean = (input, limit = 500) => String(input || "").replace(/\s+/g, " ").trim().slice(0, limit);
  const synonyms = Array.isArray(value?.synonymDifferences) ? value.synonymDifferences : [];
  const expressions = Array.isArray(value?.expressions) ? value.expressions : [];
  return {
    synonymDifferences: synonyms.slice(0, 5).map((item) => ({
      word: clean(item?.word, 80),
      difference: clean(item?.difference),
      scenarios: (Array.isArray(item?.scenarios) ? item.scenarios : [item?.scenarios]).filter(Boolean).slice(0, 4).map((entry) => clean(entry, 120)),
      example: clean(item?.example)
    })).filter((item) => item.word && item.difference),
    expressions: expressions.slice(0, 6).map((item) => ({
      phrase: clean(item?.phrase, 140),
      register: clean(item?.register, 20),
      meaning: clean(item?.meaning),
      example: clean(item?.example)
    })).filter((item) => item.phrase && item.meaning)
  };
}

async function prepareWord(rawWord, rawAccent) {
  const accent = normalizeAccent(rawAccent);
  const key = P.normalizeWord(rawWord);
  const target = BY_WORD.get(key);
  if (!target) {
    return { found: false, word: String(rawWord || "").trim(), accent, candidates: [] };
  }

  const targetWord = await enrichWord(target, accent, true);
  targetWord.weaknessMatches = await findWeaknessMatches(targetWord).catch(() => []);
  const matchingTarget = P.tokenizeIpa(target.ukIpa).length ? target : { ...target, ukIpa: targetWord.ipa };
  const localCandidates = P.findCandidates(matchingTarget, VOCABULARY, 4);
  const candidateWords = await Promise.all(
    localCandidates.map((item) => enrichCandidate(item, accent, targetWord.ipa))
  );

  return {
    found: true,
    accent,
    target: targetWord,
    candidates: candidateWords,
    corpus: CORPUS_SUMMARY
  };
}

async function prepareTypedCandidate(rawTyped, rawCorrect, rawAccent) {
  const typed = P.normalizeWord(rawTyped);
  const correctKey = P.normalizeWord(rawCorrect);
  const accent = normalizeAccent(rawAccent);
  if (!typed || !correctKey || typed === correctKey) return { found: false };

  let item = BY_WORD.get(typed) || null;
  let match = "exact";
  if (!item) {
    match = "distance1";
    item = VOCABULARY
      .filter((entry) => {
        const key = P.normalizeWord(entry.word);
        return key !== correctKey && Math.abs(key.length - typed.length) <= 1 && P.damerauLevenshtein(typed, key) === 1;
      })
      .sort((left, right) => {
        const correctGap = P.damerauLevenshtein(left.word, correctKey) - P.damerauLevenshtein(right.word, correctKey);
        if (correctGap) return correctGap;
        const priorityGap = Number(Boolean(right.priority)) - Number(Boolean(left.priority));
        if (priorityGap) return priorityGap;
        return String(left.word).localeCompare(String(right.word));
      })[0] || null;
  }
  if (!item || P.normalizeWord(item.word) === correctKey) return { found: false };

  const correctItem = BY_WORD.get(correctKey);
  const correctIpa = correctItem ? (await resolveIpa(correctItem, accent).catch(() => ({ ipa: correctItem.ukIpa }))).ipa : "";
  const candidate = await enrichCandidate({
    ...item,
    channels: ["用户拼写"],
    label: match === "exact" ? "你的拼写（词库词）" : "与你的拼写差1字母"
  }, accent, correctIpa);
  return {
    found: true,
    typed,
    match,
    candidate: { ...candidate, userInputCandidate: true }
  };
}

async function enrichCandidate(item, accent, targetIpa) {
  const base = await enrichWord(item, accent, false);
  const marked = P.markPhonemeDifferences(P.tokenizeIpa(targetIpa), P.tokenizeIpa(base.ipa));
  return {
    ...base,
    channels: item.channels,
    label: item.label,
    tokens: marked.candidate.length ? marked.candidate : item.tokens,
    priority: Boolean(item.priority),
    phonemeDistance: item.phonemeDistance,
    spellingDistance: item.spellingDistance,
    spellingSimilarity: item.spellingSimilarity
  };
}

async function enrichWord(item, accent, includeTargetTokens) {
  let ipa = P.cleanIpa(item.ukIpa);
  let ipaFallback = false;
  if (accent === "us" || !ipa) {
    const onlineIpa = await fetchExactIpa(item.word).catch(() => "");
    if (onlineIpa) {
      ipa = onlineIpa;
      ipaFallback = accent === "uk";
    } else if (accent === "us") {
      ipaFallback = true;
    }
  }
  const tokens = P.tokenizeIpa(ipa).map((token) => ({ token, different: false }));
  const audioUrl = await fetchAudio(item, accent).catch(() => fallbackAudioUrl(item, accent));
  return {
    word: item.word,
    key: item.key,
    meaning: item.meaning,
    book: item.book,
    category: item.category,
    tags: item.tags || [item.book].filter(Boolean),
    collections: item.collections || [],
    scenarios: item.scenarios || [],
    scenarioNames: item.scenarioNames || [],
    priority: Boolean(item.priority),
    ipa,
    tokens: includeTargetTokens ? tokens : undefined,
    ipaFallback,
    audioUrl
  };
}

async function analyzeAttemptMessage(message) {
  const typed = P.normalizeWord(message.typed);
  const correctKey = P.normalizeWord(message.correct);
  const accent = normalizeAccent(message.accent);
  const correctItem = BY_WORD.get(correctKey);
  if (!correctItem) return { available: false, reason: "未在本地雅思词库中找到正确词。" };

  const [correctIpaResult, correctAudio] = await Promise.all([
    resolveIpa(correctItem, accent),
    fetchAudio(correctItem, accent).catch(() => fallbackAudioUrl(correctItem, accent))
  ]);

  const soundSpelling = C.analyzeSoundSpelling(typed, correctItem.word, correctIpaResult.ipa);
  const spelling = P.alignCharacters(typed, correctItem.word);
  const shouldRecord = message.record !== false && soundSpelling.issues.length > 0;
  const learning = shouldRecord
    ? await recordLearningAttempt({
        attemptKey: String(message.attemptKey || ""),
        typed,
        correctItem,
        correctIpa: correctIpaResult.ipa,
        issues: soundSpelling.issues
      })
    : await getLearningState();
  return {
    available: true,
    accent,
    typed,
    correct: P.normalizeWord(correctItem.word),
    spelling,
    soundSpelling,
    issues: soundSpelling.issues,
    explanation: soundSpelling.issues.length
      ? `本题识别出 ${soundSpelling.issues.length} 个声音—字母映射问题。`
      : "本题字母差异未形成可复用的声音错误模式。",
    correctIpa: correctIpaResult.ipa,
    correctAudio,
    learning
  };
}

async function resolveIpa(item, accent) {
  const localIpa = P.cleanIpa(item.ukIpa);
  if (accent === "uk" && localIpa) return { ipa: localIpa, inferred: false };
  return { ipa: await fetchExactIpa(item.word).catch(() => "") || P.cleanIpa(item.ukIpa), inferred: false };
}

async function fetchExactIpa(word) {
  const key = P.normalizeWord(word);
  if (!key) return "";
  if (ipaCache.has(key)) return ipaCache.get(key);
  const url = new URL("https://api.datamuse.com/words");
  url.searchParams.set("sp", key);
  url.searchParams.set("max", "3");
  url.searchParams.set("md", "r");
  const response = await fetch(url, { cache: "force-cache", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`发音词典返回 ${response.status}`);
  const rows = await response.json();
  const exact = rows.find((row) => P.normalizeWord(row.word) === key);
  const ipa = exact ? P.pronunciationFromDatamuse(exact) : "";
  ipaCache.set(key, ipa);
  return ipa;
}

async function fetchAudio(item, accent) {
  const key = `${accent}:${P.normalizeWord(item.word)}`;
  if (!P.normalizeWord(item.word)) return "";
  if (audioCache.has(key)) return audioCache.get(key);
  const remoteUrl = fallbackAudioUrl(item, accent);
  const response = await fetch(remoteUrl, { cache: "force-cache", signal: AbortSignal.timeout(6500) });
  if (!response.ok) throw new Error(`音频服务返回 ${response.status}`);
  const blob = await response.blob();
  if (!blob.size) throw new Error("音频为空");
  const dataUrl = await blobToDataUrl(blob);
  audioCache.set(key, dataUrl);
  while (audioCache.size > MAX_AUDIO_CACHE) audioCache.delete(audioCache.keys().next().value);
  return dataUrl;
}

function fallbackAudioUrl(item, accent) {
  if (accent === "uk" && item?.ukSpeech) {
    return `https://ai-oss3.oss-cn-shenzhen.aliyuncs.com/ielts_word/${encodeURIComponent(item.ukSpeech)}`;
  }
  const type = accent === "uk" ? 1 : 2;
  return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(item?.word || "")}&type=${type}`;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取音频失败"));
    reader.readAsDataURL(blob);
  });
}

async function recordLearningAttempt({ attemptKey, typed, correctItem, correctIpa, issues }) {
  const now = Date.now();
  const profileState = await storageGet({ [PROFILE_KEY]: emptyProfile() });
  const profile = normalizeProfile(profileState[PROFILE_KEY]);
  const stableAttemptKey = attemptKey || `${correctItem.key || correctItem.word}|${typed}|${now}`;
  if (profile.recentAttemptKeys.includes(stableAttemptKey)) {
    return getLearningState({ profile });
  }

  profile.totalIncorrectAttempts += 1;
  profile.lastUpdated = now;
  profile.recentAttemptKeys = [...profile.recentAttemptKeys, stableAttemptKey].slice(-80);
  for (const issue of issues) {
    const existing = profile.patterns[issue.id] || {
      id: issue.id,
      type: issue.type,
      sound: issue.sound,
      phonemes: issue.phonemes,
      correctGrapheme: issue.correctGrapheme,
      userGrapheme: issue.userGrapheme,
      title: issue.title,
      training: issue.training,
      count: 0,
      words: [],
      examples: []
    };
    existing.count += 1;
    existing.lastSeen = now;
    existing.title = issue.title;
    existing.training = issue.training;
    existing.words = [...new Set([correctItem.word, ...(existing.words || [])])].slice(0, 8);
    existing.examples = [
      { word: correctItem.word, typed, at: now },
      ...(existing.examples || []).filter((example) => example.word !== correctItem.word || example.typed !== typed)
    ].slice(0, 5);
    profile.patterns[issue.id] = existing;
  }

  await storageSet({ [PROFILE_KEY]: profile });
  return getLearningState({ profile });
}

async function getLearningState(existing) {
  let profile = existing?.profile;
  if (!profile) {
    const state = await storageGet({ [PROFILE_KEY]: emptyProfile() });
    profile = normalizeProfile(state[PROFILE_KEY]);
  }
  const topPatterns = Object.values(profile.patterns || {})
    .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen)
    .slice(0, 5)
    .map((pattern) => ({
      id: pattern.id,
      type: pattern.type,
      sound: pattern.sound,
      correctGrapheme: pattern.correctGrapheme,
      userGrapheme: pattern.userGrapheme,
      title: pattern.title,
      training: pattern.training,
      count: pattern.count,
      words: pattern.words || []
    }));
  return {
    profile: {
      totalIncorrectAttempts: Number(profile.totalIncorrectAttempts || 0),
      patternCount: Object.keys(profile.patterns || {}).length,
      topPatterns
    }
  };
}

async function findWeaknessMatches(wordItem) {
  const state = await storageGet({ [PROFILE_KEY]: emptyProfile() });
  const profile = normalizeProfile(state[PROFILE_KEY]);
  const patterns = Object.values(profile.patterns || {});
  if (!patterns.length) return [];
  const keys = new Set(
    C.segmentSoundSpelling(wordItem.word, wordItem.ipa || wordItem.ukIpa)
      .map((segment) => `${segment.phonemes.join("")}\u0000${segment.grapheme}`)
  );
  return patterns
    .filter((pattern) => keys.has(`${(pattern.phonemes || []).join("")}\u0000${pattern.correctGrapheme}`))
    .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen)
    .slice(0, 3)
    .map((pattern) => ({
      id: pattern.id,
      title: pattern.title,
      sound: pattern.sound,
      correctGrapheme: pattern.correctGrapheme,
      count: pattern.count
    }));
}

function emptyProfile() {
  return { version: 1, totalIncorrectAttempts: 0, lastUpdated: 0, recentAttemptKeys: [], patterns: {} };
}

function normalizeProfile(value) {
  const profile = value && typeof value === "object" ? value : emptyProfile();
  return {
    version: 1,
    totalIncorrectAttempts: Number(profile.totalIncorrectAttempts || 0),
    lastUpdated: Number(profile.lastUpdated || 0),
    recentAttemptKeys: Array.isArray(profile.recentAttemptKeys) ? profile.recentAttemptKeys : [],
    patterns: profile.patterns && typeof profile.patterns === "object" ? profile.patterns : {}
  };
}

function storageGet(defaults) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(defaults, (value) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(value);
    });
  });
}

function storageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve();
    });
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeAccent(value) {
  return value === "uk" ? "uk" : "us";
}

function readableError(error) {
  return error instanceof Error ? error.message : "处理失败";
}
