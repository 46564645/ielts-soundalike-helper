(function (root) {
  "use strict";

  const MULTI_TOKENS = [
    "tʃ", "dʒ", "eɪ", "aɪ", "ɔɪ", "aʊ", "əʊ", "oʊ", "ɪə", "eə", "ʊə",
    "iː", "ɑː", "ɔː", "uː", "ɜː", "ɝː"
  ].sort((a, b) => b.length - a.length);
  const VOWELS = new Set([
    "i", "iː", "ɪ", "e", "ɛ", "ɛː", "æ", "ə", "ɜ", "ɜː", "ɚ", "ɝ", "ɝː",
    "a", "aː", "ʌ", "ɑ", "ɑː", "ɒ", "ɔ", "ɔː", "ʊ", "u", "uː", "eɪ", "aɪ", "ɔɪ",
    "aʊ", "əʊ", "oʊ", "ɪə", "eə", "ʊə"
  ]);
  const CONFUSABLE_GROUPS = [
    ["ɪ", "i", "iː"], ["e", "ɛ", "ɛː", "æ"], ["æ", "ʌ"], ["a", "aː", "ʌ", "ɑ", "ɑː"],
    ["ɒ", "ɔ", "ɔː"], ["ʊ", "u", "uː"], ["ə", "ɜ", "ɜː", "ɚ", "ɝ", "ɝː"],
    ["eɪ", "aɪ"], ["aɪ", "ɔɪ"], ["aʊ", "əʊ", "oʊ"], ["ɪə", "eə", "ʊə"],
    ["p", "b"], ["t", "d"], ["k", "g", "ɡ"], ["f", "v"], ["θ", "ð"],
    ["s", "z"], ["ʃ", "ʒ"], ["tʃ", "dʒ"], ["m", "n"], ["n", "ŋ"],
    ["l", "r", "ɹ"], ["w", "v"]
  ];
  const CONFUSABLE = new Set();
  for (const group of CONFUSABLE_GROUPS) {
    for (const a of group) for (const b of group) if (a !== b) CONFUSABLE.add(`${a}\u0000${b}`);
  }

  const ARPA_TO_IPA = {
    AA: "ɑ", AE: "æ", AH: "ʌ", AO: "ɔ", AW: "aʊ", AY: "aɪ", EH: "e",
    ER: "ɝ", EY: "eɪ", IH: "ɪ", IY: "iː", OW: "oʊ", OY: "ɔɪ", UH: "ʊ",
    UW: "uː", B: "b", CH: "tʃ", D: "d", DH: "ð", F: "f", G: "g", HH: "h",
    JH: "dʒ", K: "k", L: "l", M: "m", N: "n", NG: "ŋ", P: "p", R: "r",
    S: "s", SH: "ʃ", T: "t", TH: "θ", V: "v", W: "w", Y: "j", Z: "z", ZH: "ʒ"
  };

  // zhen-ke/phonetic-Symbols uses KK notation. Several KK vowel labels describe
  // the same sound that this extension writes with a different IPA symbol:
  // KK [e] = IPA /eɪ/, KK [o] = IPA /oʊ/, and tense vowels omit /ː/.
  const PHONEME_AUDIO_FILES = Object.freeze({
    "i": ["kk01.mp3"], "iː": ["kk01.mp3"], "ɪ": ["kk02.mp3"],
    "eɪ": ["kk03.mp3"], "e": ["kk04.mp3"], "ɛ": ["kk04.mp3"], "ɛː": ["kk04.mp3"],
    "æ": ["kk05.mp3"], "a": ["kk05.mp3"],
    "aː": ["kk06.mp3"], "ɑ": ["kk06.mp3"], "ɑː": ["kk06.mp3"], "ɒ": ["kk06.mp3"],
    "əʊ": ["kk07.mp3"], "oʊ": ["kk07.mp3"],
    "ɔ": ["kk08.mp3"], "ɔː": ["kk08.mp3"],
    "u": ["kk09.mp3"], "uː": ["kk09.mp3"], "ʊ": ["kk10.mp3"],
    "ʌ": ["kk11.mp3"], "ə": ["kk12.mp3"], "ɚ": ["kk13.mp3"],
    "ɜ": ["kk14.mp3"], "ɜː": ["kk14.mp3"], "ɝ": ["kk14.mp3"], "ɝː": ["kk14.mp3"],
    "aɪ": ["kk15.mp3"], "aʊ": ["kk16.mp3"], "ɔɪ": ["kk17.mp3"],
    "p": ["kk18.mp3"], "b": ["kk19.mp3"], "t": ["kk22.mp3"], "d": ["kk23.mp3"],
    "k": ["kk24.mp3"], "g": ["kk25.mp3"], "ɡ": ["kk25.mp3"],
    "f": ["kk26.mp3"], "v": ["kk27.mp3"], "s": ["kk28.mp3"], "z": ["kk29.mp3"],
    "θ": ["kk30.mp3"], "ð": ["kk31.mp3"], "ʃ": ["kk32.mp3"], "ʒ": ["kk33.mp3"],
    "tʃ": ["kk34.mp3"], "dʒ": ["kk36.mp3"], "l": ["kk38.mp3"],
    "r": ["kk40.mp3"], "ɹ": ["kk40.mp3"], "m": ["kk42.mp3"],
    "n": ["kk44.mp3"], "ŋ": ["kk46.mp3"], "j": ["kk47.mp3"],
    "w": ["kk48.mp3"], "h": ["kk49.mp3"],
    "ɪə": ["kk02.mp3", "kk12.mp3"],
    "eə": ["kk04.mp3", "kk12.mp3"],
    "ʊə": ["kk10.mp3", "kk12.mp3"]
  });

  function normalizeWord(value) {
    return String(value || "")
      .normalize("NFKC")
      .trim()
      .toLowerCase()
      .replace(/[’‘`]/g, "'")
      .replace(/\s+/g, " ");
  }

  function cleanIpa(value) {
    let text = String(value || "").trim();
    text = text.replace(/^(英|美)\s*/u, "").replace(/^[/\[]|[/\]]$/g, "");
    text = text.split(";")[0].trim();
    return text.replace(/\(r\)/g, "").replace(/\(([əɪ])\)/g, "$1");
  }

  function tokenizeIpa(value) {
    const text = cleanIpa(value)
      .replace(/ɡ/g, "g")
      .replace(/ɹ/g, "r")
      .replace(/[\/\[\]ˈˌ.()‿\-\s]/g, "");
    const output = [];
    for (let i = 0; i < text.length;) {
      const multi = MULTI_TOKENS.find((token) => text.startsWith(token, i));
      if (multi) {
        output.push(multi);
        i += multi.length;
        continue;
      }
      const point = String.fromCodePoint(text.codePointAt(i));
      i += point.length;
      if (point === "ː" && output.length) output[output.length - 1] += point;
      else if (/\p{L}/u.test(point) || "θðʃʒŋæəɜɚɝʌɑɒɔʊ".includes(point)) output.push(point);
    }
    return output;
  }

  function isVowel(token) {
    return VOWELS.has(token);
  }

  function syllableCount(tokensOrIpa) {
    const tokens = Array.isArray(tokensOrIpa) ? tokensOrIpa : tokenizeIpa(tokensOrIpa);
    return tokens.reduce((count, token) => count + (isVowel(token) ? 1 : 0), 0);
  }

  function isConfusable(a, b) {
    return a === b || CONFUSABLE.has(`${a}\u0000${b}`);
  }

  function commonPrefixLength(left, right) {
    const a = Array.isArray(left) ? left : [...String(left || "")];
    const b = Array.isArray(right) ? right : [...String(right || "")];
    const limit = Math.min(a.length, b.length);
    let index = 0;
    while (index < limit && a[index] === b[index]) index += 1;
    return index;
  }

  function alignSequences(left, right) {
    const m = left.length;
    const n = right.length;
    const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(null));
    dp[0][0] = { cost: 0, ops: [] };
    for (let i = 1; i <= m; i++) dp[i][0] = { cost: i, ops: [...dp[i - 1][0].ops, { type: "delete", left: left[i - 1], li: i - 1, ri: -1 }] };
    for (let j = 1; j <= n; j++) dp[0][j] = { cost: j, ops: [...dp[0][j - 1].ops, { type: "insert", right: right[j - 1], li: -1, ri: j - 1 }] };
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const equal = left[i - 1] === right[j - 1];
        const candidates = [
          { cost: dp[i - 1][j - 1].cost + (equal ? 0 : 1), ops: [...dp[i - 1][j - 1].ops, { type: equal ? "equal" : "substitute", left: left[i - 1], right: right[j - 1], li: i - 1, ri: j - 1 }] },
          { cost: dp[i - 1][j].cost + 1, ops: [...dp[i - 1][j].ops, { type: "delete", left: left[i - 1], li: i - 1, ri: -1 }] },
          { cost: dp[i][j - 1].cost + 1, ops: [...dp[i][j - 1].ops, { type: "insert", right: right[j - 1], li: -1, ri: j - 1 }] }
        ];
        candidates.sort((a, b) => a.cost - b.cost || countIndels(a.ops) - countIndels(b.ops));
        dp[i][j] = candidates[0];
      }
    }
    const result = dp[m][n];
    return {
      distance: result.cost,
      operations: result.ops,
      substitutions: result.ops.filter((op) => op.type === "substitute"),
      indels: countIndels(result.ops)
    };
  }

  function countIndels(ops) {
    return ops.reduce((sum, op) => sum + (op.type === "insert" || op.type === "delete" ? 1 : 0), 0);
  }

  function damerauLevenshtein(aValue, bValue) {
    const a = normalizeWord(aValue);
    const b = normalizeWord(bValue);
    const matrix = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
    for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
    for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost
        );
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + 1);
        }
      }
    }
    return matrix[a.length][b.length];
  }

  function spellingSimilarity(a, b) {
    const length = Math.max(normalizeWord(a).length, normalizeWord(b).length, 1);
    return 1 - damerauLevenshtein(a, b) / length;
  }

  function findClosestSpelling(typedValue, vocabulary, excludedValue = "") {
    const typed = normalizeWord(typedValue);
    const excluded = normalizeWord(excludedValue);
    if (!typed) return null;

    const candidates = [];
    for (const item of vocabulary || []) {
      const key = normalizeWord(item?.word || item?.key);
      if (!key || key === excluded) continue;
      const spellingDistance = damerauLevenshtein(typed, key);
      candidates.push({
        item,
        key,
        spellingDistance,
        spellingSimilarity: 1 - spellingDistance / Math.max(typed.length, key.length, 1),
        spellingLengthGap: Math.abs(typed.length - key.length),
        spellingPrefixLength: commonPrefixLength([...typed], [...key]),
        priority: Boolean(item.priority),
        word: item.word
      });
    }

    candidates.sort((left, right) =>
      left.spellingDistance - right.spellingDistance ||
      left.spellingLengthGap - right.spellingLengthGap ||
      right.spellingPrefixLength - left.spellingPrefixLength ||
      Number(Boolean(right.priority)) - Number(Boolean(left.priority)) ||
      String(left.word).localeCompare(String(right.word))
    );
    const best = candidates[0];
    return best ? {
      ...best.item,
      key: best.key,
      spellingDistance: best.spellingDistance,
      spellingSimilarity: best.spellingSimilarity,
      spellingLengthGap: best.spellingLengthGap,
      spellingPrefixLength: best.spellingPrefixLength
    } : null;
  }

  function markPhonemeDifferences(targetTokens, candidateTokens) {
    const alignment = alignSequences(targetTokens, candidateTokens);
    const targetDifferent = new Set();
    const candidateDifferent = new Set();
    for (const op of alignment.operations) {
      if (op.type === "equal") continue;
      if (op.li >= 0) targetDifferent.add(op.li);
      if (op.ri >= 0) candidateDifferent.add(op.ri);
    }
    return {
      ...alignment,
      target: targetTokens.map((token, index) => ({ token, different: targetDifferent.has(index) })),
      candidate: candidateTokens.map((token, index) => ({ token, different: candidateDifferent.has(index) }))
    };
  }

  function findCandidates(target, vocabulary, max = 5) {
    if (!target) return [];
    const targetKey = normalizeWord(target.word || target.key);
    const targetTokens = tokenizeIpa(target.ukIpa);
    const targetSyllables = syllableCount(targetTokens);
    if (!targetKey || !targetTokens.length || !targetSyllables) return [];
    const eligible = [];
    for (const item of vocabulary || []) {
      const key = normalizeWord(item.word || item.key);
      if (!key || key === targetKey) continue;
      const tokens = tokenizeIpa(item.ukIpa);
      if (!tokens.length) continue;
      const candidateSyllables = syllableCount(tokens);
      const syllableGap = Math.abs(candidateSyllables - targetSyllables);
      const alignment = alignSequences(targetTokens, tokens);
      const allSimilarSubs = alignment.substitutions.every((op) => isConfusable(op.left, op.right));
      const spellingDistance = damerauLevenshtein(targetKey, key);
      const spellingScore = spellingSimilarity(targetKey, key);
      const targetLetters = [...targetKey.replace(/[^a-z]/g, "")];
      const candidateLetters = [...key.replace(/[^a-z]/g, "")];
      const shorterLetterCount = Math.min(targetLetters.length, candidateLetters.length);
      const shorterPhonemeCount = Math.min(targetTokens.length, tokens.length);
      const longerPhonemeCount = Math.max(targetTokens.length, tokens.length);
      const commonLetterPrefix = commonPrefixLength(targetLetters, candidateLetters);
      const commonPhonemePrefix = commonPrefixLength(targetTokens, tokens);
      const phonemeSimilarity = longerPhonemeCount
        ? 1 - alignment.distance / longerPhonemeCount
        : 0;
      const longTarget = targetLetters.length >= 7;
      const longPair = longTarget && candidateLetters.length >= 5;
      const longDistanceLimit = targetLetters.length >= 10 ? 5 : 4;
      const strongSpellingSoundPrefix = longPair && syllableGap <= 2 &&
        commonLetterPrefix >= 5 && commonLetterPrefix / shorterLetterCount >= 0.45 &&
        commonPhonemePrefix >= 3 && commonPhonemePrefix / shorterPhonemeCount >= 0.4;
      const strongPhonemePrefix = longPair && syllableGap <= 2 &&
        commonPhonemePrefix >= 5 && commonPhonemePrefix / shorterPhonemeCount >= 0.45;
      const strongPrefixSound = strongSpellingSoundPrefix || strongPhonemePrefix;
      const strictNearSound = syllableGap === 0 && alignment.distance <= 3 &&
        alignment.indels <= 1 && allSimilarSubs;
      const relaxedLongNearSound = longPair && syllableGap <= 1 &&
        alignment.distance <= longDistanceLimit && alignment.indels <= 2 &&
        (allSimilarSubs || phonemeSimilarity >= 0.72);
      const nearSound = strictNearSound || relaxedLongNearSound || strongPrefixSound;
      const strictLookalike = syllableGap === 0 && alignment.distance <= 3 &&
        (spellingDistance <= 2 || spellingScore >= 0.7);
      const relaxedLongLookalike = longPair && syllableGap <= 1 &&
        (alignment.distance <= longDistanceLimit + 1 || phonemeSimilarity >= 0.6) &&
        (spellingDistance <= (Math.max(targetLetters.length, candidateLetters.length) >= 10 ? 4 : 3) ||
          spellingScore >= 0.62 ||
          (commonLetterPrefix >= 5 && commonLetterPrefix / shorterLetterCount >= 0.5));
      const lookalike = strictLookalike || relaxedLongLookalike;
      if (!nearSound && !lookalike) continue;
      const marked = markPhonemeDifferences(targetTokens, tokens);
      const channels = nearSound && lookalike ? ["近音", "形近"] : nearSound ? ["近音"] : ["形近"];
      const nearSoundRule = strictNearSound ? "strict" : strongPrefixSound ? "long-prefix" : relaxedLongNearSound ? "long-relaxed" : "";
      const lookalikeRule = strictLookalike ? "strict" : relaxedLongLookalike ? "long-relaxed" : "";
      const priorityBoost = item.priority ? 0.32 : 0;
      const bookBoost = item.category === 400 ? 0.12 : item.category === 300 ? 0.06 : 0;
      const channelBoost = channels.length === 2 ? 0.45 : nearSound ? 0.25 : 0.12;
      const prefixBoost = strongPrefixSound ? 0.38 : relaxedLongNearSound ? 0.12 : 0;
      const score = 3 - alignment.distance * 0.5 + spellingScore + priorityBoost + bookBoost + channelBoost + prefixBoost;
      eligible.push({
        ...item,
        key,
        tokens: marked.candidate,
        targetTokens: marked.target,
        phonemeDistance: alignment.distance,
        phonemeIndels: alignment.indels,
        spellingDistance,
        spellingSimilarity: spellingScore,
        phonemeSimilarity,
        commonLetterPrefix,
        commonPhonemePrefix,
        syllableGap,
        nearSoundRule,
        lookalikeRule,
        channels,
        label: channels.join("+") ,
        score
      });
    }
    return eligible
      .sort((a, b) => b.score - a.score || a.phonemeDistance - b.phonemeDistance || a.word.localeCompare(b.word))
      .slice(0, Math.max(0, Math.min(Number(max) || 5, 5)));
  }

  function alignCharacters(typedValue, correctValue) {
    const typed = normalizeWord(typedValue);
    const correct = normalizeWord(correctValue);
    const left = [...typed];
    const right = [...correct];
    const alignment = alignSequences(left, right);
    const parts = [];
    for (const op of alignment.operations) {
      if (op.type === "equal") parts.push({ type: "equal", typed: op.left, correct: op.right });
      else if (op.type === "substitute") parts.push({ type: "substitute", typed: op.left, correct: op.right });
      else if (op.type === "delete") parts.push({ type: "extra", typed: op.left, correct: "" });
      else parts.push({ type: "missing", typed: "", correct: op.right });
    }
    for (let i = 0; i < parts.length - 1; i++) {
      const first = parts[i];
      const second = parts[i + 1];
      if (first.type === "substitute" && second.type === "substitute" && first.typed === second.correct && second.typed === first.correct) {
        first.type = "transpose";
        second.type = "transpose";
      }
    }
    return { distance: damerauLevenshtein(typed, correct), parts };
  }

  function arpabetToIpa(pronunciation) {
    return String(pronunciation || "")
      .trim()
      .split(/\s+/)
      .map((part) => ARPA_TO_IPA[part.replace(/[012]/g, "").toUpperCase()] || "")
      .join("");
  }

  function pronunciationFromDatamuse(item) {
    const tag = (item?.tags || []).find((value) => String(value).startsWith("pron:"));
    return tag ? arpabetToIpa(String(tag).slice(5)) : "";
  }

  function phonemeAudioKey(token) {
    return [...String(token || "")].map((char) => char.codePointAt(0).toString(16)).join("-");
  }

  function phonemeAudioFiles(token) {
    return [...(PHONEME_AUDIO_FILES[String(token || "")] || [])];
  }

  root.IeltsPhonetics = Object.freeze({
    normalizeWord,
    cleanIpa,
    tokenizeIpa,
    syllableCount,
    isConfusable,
    commonPrefixLength,
    alignSequences,
    damerauLevenshtein,
    spellingSimilarity,
    findClosestSpelling,
    markPhonemeDifferences,
    findCandidates,
    alignCharacters,
    arpabetToIpa,
    pronunciationFromDatamuse,
    phonemeAudioKey,
    phonemeAudioFiles
  });
})(globalThis);
