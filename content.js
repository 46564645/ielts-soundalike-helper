(function () {
  "use strict";

  const P = globalThis.IeltsPhonetics;
  const IS_IDICTATION = location.hostname === "www.idictation.cn";
  const COMPARISONS_KEY = "pronunciationComparisonsV1";
  const DEFAULTS = { enabled: true, accent: "us", overlayReopenNonce: 0 };
  let settings = { ...DEFAULTS };
  let prepared = null;
  let currentWordKey = "";
  let prefetchTimer = 0;
  let attemptSequence = 0;
  let renderSequence = 0;
  let overlayHost = null;
  let overlayUi = null;
  let lastResult = null;
  let closedForSession = false;
  let activeAudio = null;
  let activeAudioRun = 0;
  let audioShortcuts = { target: null, candidates: [] };
  let resizeSaveTimer = 0;
  let idictationClueKey = "";
  let idictationResolveRun = 0;
  let idictationRevealTimer = 0;
  let idictationSpellingTimer = 0;

  chrome.storage.sync.get(DEFAULTS, (saved) => {
    settings = { ...DEFAULTS, ...saved };
    queuePrefetch();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.enabled) {
      settings.enabled = changes.enabled.newValue !== false;
      if (!settings.enabled) hideOverlay(false);
      else queuePrefetch();
    }
    if (changes.accent) {
      settings.accent = changes.accent.newValue === "uk" ? "uk" : "us";
      prepared = null;
      queuePrefetch();
      if (lastResult && !closedForSession) refreshLastResult();
    }
    if (changes.overlayReopenNonce) {
      settings.overlayReopenNonce = changes.overlayReopenNonce.newValue;
      closedForSession = false;
      if (lastResult && settings.enabled) {
        ensureOverlay();
        overlayHost.hidden = false;
        renderResult(lastResult);
      }
    }
  });

  document.addEventListener("click", handlePageClick, true);
  document.addEventListener("keydown", handleKeydown, true);
  window.addEventListener("resize", () => overlayHost && clampHostPosition());

  const observer = new MutationObserver(() => {
    queuePrefetch();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style"]
  });
  queuePrefetch();

  function handlePageClick(event) {
    if (!settings.enabled) return;
    if (IS_IDICTATION) {
      handleIdictationClick(event);
      return;
    }
    const control = event.target instanceof Element
      ? event.target.closest(".word_dictation_main_audio > div, .word_dictation_main_audio button")
      : null;
    if (!control) return;
    const label = textOf(control);
    if (label.includes("核对答案")) {
      if (!readJudgementState()) beginAnswerCheck();
      return;
    }
    if (label.includes("上一个单词") || label.includes("下一个单词")) {
      markAsPrevious();
      queuePrefetch();
    }
  }

  function handleIdictationClick(event) {
    if (!(event.target instanceof Element) || !isLearningMode()) return;
    const control = findIdictationAnswerControl(event.target);
    if (!control) return;
    const choice = textOf(control);
    const clue = readIdictationCurrentClue();
    const completedBefore = readIdictationCompletedDetails();
    const pending = {
      id: ++attemptSequence,
      choice,
      state: inferIdictationChoiceState(choice, clue?.meaning),
      clueKey: idictationClueSignature(clue),
      completedBefore: P.normalizeWord(completedBefore?.word || ""),
      startedAt: Date.now()
    };
    window.clearInterval(idictationRevealTimer);
    idictationRevealTimer = window.setInterval(() => {
      const completed = readIdictationCompletedDetails();
      const completedKey = P.normalizeWord(completed?.word || "");
      if (completed?.word && completedKey && completedKey !== pending.completedBefore) {
        window.clearInterval(idictationRevealTimer);
        idictationRevealTimer = 0;
        const nextClueKey = idictationClueSignature(readIdictationCurrentClue());
        if (nextClueKey && nextClueKey !== pending.clueKey && currentWordKey === completedKey) {
          currentWordKey = "";
        }
        const attempt = {
          id: pending.id,
          details: completed,
          typed: "",
          choice: pending.choice,
          mode: "choice",
          previous: true,
          packet: getPreparedPacket(completed.word, true)
        };
        revealAttempt(attempt, pending.state);
        queuePrefetch();
      } else if (Date.now() - pending.startedAt > 5000) {
        window.clearInterval(idictationRevealTimer);
        idictationRevealTimer = 0;
      }
    }, 70);
  }

  function findIdictationAnswerControl(target) {
    const main = target.closest("main");
    if (!main) return null;
    const button = target.closest("button");
    const buttonLabel = textOf(button);
    if (button && (buttonLabel === "认识" || buttonLabel === "不认识")) return button;
    const card = target.closest("div.cursor-pointer");
    if (!card || card.closest("button") || card.parentElement?.classList.contains("grid-cols-2") !== true) return null;
    const label = textOf(card);
    return label && label.length <= 120 ? card : null;
  }

  function inferIdictationChoiceState(choice, correctMeaning) {
    if (choice === "认识") return "correct";
    if (choice === "不认识" || choice.includes("不知道")) return "incorrect";
    const selected = normalizeMeaning(choice);
    const correct = normalizeMeaning(correctMeaning);
    return selected && correct && (selected.includes(correct) || correct.includes(selected)) ? "correct" : "incorrect";
  }

  function handleKeydown(event) {
    if (handleAudioShortcut(event)) return;
    if (event.key !== "Enter" || event.repeat || !settings.enabled) return;
    if (IS_IDICTATION) {
      const input = event.target instanceof HTMLInputElement && event.target.matches('main input[type="text"]')
        ? event.target
        : null;
      if (!input || !isLearningMode()) return;
      if (isIdictationSpellingJudged()) {
        markAsPrevious();
        queuePrefetch();
        return;
      }
      beginIdictationSpellingCheck(input);
      return;
    }
    const input = event.target instanceof HTMLInputElement && event.target.matches(".input_bg, .word_dictation_main_word input")
      ? event.target
      : null;
    if (!input || !isLearningMode()) return;
    if (readJudgementState()) {
      markAsPrevious();
      queuePrefetch();
      return;
    }
    beginAnswerCheck();
  }

  function beginIdictationSpellingCheck(input) {
    const details = readIdictationSpellingDetails();
    const typed = String(input?.value || "").trim();
    if (!details?.word || !typed) return;
    const targetKey = P.normalizeWord(details.word);
    const completedBefore = P.normalizeWord(readIdictationCompletedDetails()?.word || "");
    const attempt = {
      id: ++attemptSequence,
      details,
      typed,
      mode: "spelling",
      previous: false,
      packet: getPreparedPacket(details.word)
    };
    const startedAt = Date.now();
    window.clearInterval(idictationSpellingTimer);
    idictationSpellingTimer = window.setInterval(() => {
      const current = readIdictationSpellingDetails();
      const currentKey = P.normalizeWord(current?.word || "");
      const completedKey = P.normalizeWord(readIdictationCompletedDetails()?.word || "");
      const currentChanged = Boolean(currentKey && currentKey !== targetKey);
      const completedChanged = Boolean(completedKey && completedKey !== completedBefore && completedKey === targetKey);
      const judgedHere = isIdictationSpellingJudged(details.word);
      if (judgedHere || currentChanged || completedChanged) {
        window.clearInterval(idictationSpellingTimer);
        idictationSpellingTimer = 0;
        if (currentChanged) adoptIdictationSpellingWord(current);
        attempt.previous = currentChanged || completedChanged;
        revealAttempt(attempt, sameWord(typed, details.word) ? "correct" : "incorrect");
        queuePrefetch();
      } else if (Date.now() - startedAt > 5000) {
        window.clearInterval(idictationSpellingTimer);
        idictationSpellingTimer = 0;
      }
    }, 60);
  }

  function handleAudioShortcut(event) {
    if (
      event.repeat || event.altKey || event.ctrlKey || event.metaKey ||
      !settings.enabled || closedForSession || !overlayHost || overlayHost.hidden
    ) return false;
    const isTarget = event.code === "Backquote" || event.key === "`" || event.key === "~" || event.key === "·";
    const digitMatch = String(event.code || "").match(/^(?:Digit|Numpad)([1-5])$/) || String(event.key || "").match(/^([1-5])$/);
    const audio = isTarget
      ? audioShortcuts.target
      : digitMatch
        ? audioShortcuts.candidates[Number(digitMatch[1]) - 1]
        : null;
    if (!audio) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    playAudio(audio.url, audio.word);
    return true;
  }

  function beginAnswerCheck() {
    const details = readCurrentDetails();
    if (!details?.word) return;
    const input = document.querySelector(".word_dictation_main_word .input_bg, .word_dictation_main_word input");
    const attempt = {
      id: ++attemptSequence,
      details,
      typed: String(input?.value || "").trim(),
      packet: getPreparedPacket(details.word)
    };
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const state = readJudgementState();
      const current = readCurrentDetails();
      if (state && (!current?.word || sameWord(current.word, attempt.details.word))) {
        window.clearInterval(timer);
        revealAttempt(attempt, state);
      } else if (Date.now() - startedAt > 4500) {
        window.clearInterval(timer);
      }
    }, 55);
  }

  function queuePrefetch() {
    window.clearTimeout(prefetchTimer);
    prefetchTimer = window.setTimeout(primeCurrentWord, 100);
  }

  function primeCurrentWord() {
    if (!settings.enabled || !isLearningMode()) return;
    if (IS_IDICTATION) {
      primeIdictationCurrentWord();
      return;
    }
    const details = readCurrentDetails();
    if (!details?.word) return;
    const key = P.normalizeWord(details.word);
    const changed = Boolean(currentWordKey && key !== currentWordKey);
    currentWordKey = key;
    if (changed) markAsPrevious();
    if (prepared && prepared.key === key && prepared.accent === settings.accent) {
      return;
    }
    prepared = createPreparedPacket(details.word);
  }

  function primeIdictationCurrentWord() {
    const spelling = readIdictationSpellingDetails();
    if (spelling?.word) {
      const signature = `word:${P.normalizeWord(spelling.word)}|${idictationClueSignature(spelling)}`;
      if (signature !== idictationClueKey) {
        idictationClueKey = signature;
        idictationResolveRun += 1;
        adoptIdictationSpellingWord(spelling, false);
      }
      return;
    }
    const clue = readIdictationCurrentClue();
    if (!clue?.ipa) return;
    const clueKey = idictationClueSignature(clue);
    if (!clueKey || clueKey === idictationClueKey) return;
    idictationClueKey = clueKey;
    const run = ++idictationResolveRun;
    sendMessage({ type: "RESOLVE_CLUE", ipa: clue.ipa, meaning: clue.meaning })
      .then((response) => {
        if (run !== idictationResolveRun || clueKey !== idictationClueKey || !response?.ok || !response.found) return;
        const key = P.normalizeWord(response.word);
        const changed = Boolean(currentWordKey && key && key !== currentWordKey);
        currentWordKey = key;
        if (changed) markAsPrevious();
        if (!prepared || prepared.key !== key || prepared.accent !== settings.accent) {
          prepared = createPreparedPacket(response.word);
        }
        if (lastResult && !closedForSession) renderResult(lastResult);
      })
      .catch(() => {});
  }

  function adoptIdictationSpellingWord(details, updateSignature = true) {
    if (!details?.word) return;
    const key = P.normalizeWord(details.word);
    if (!key) return;
    if (updateSignature) {
      idictationClueKey = `word:${key}|${idictationClueSignature(details)}`;
      idictationResolveRun += 1;
    }
    const changed = Boolean(currentWordKey && key !== currentWordKey);
    currentWordKey = key;
    if (changed) markAsPrevious();
    if (!prepared || prepared.key !== key || prepared.accent !== settings.accent) {
      prepared = createPreparedPacket(details.word);
    }
    if (lastResult && !closedForSession) renderResult(lastResult);
  }

  function idictationClueSignature(clue) {
    return clue?.ipa ? `${P.cleanIpa(clue.ipa)}|${normalizeMeaning(clue.meaning)}` : "";
  }

  function getPreparedPacket(word, preserveCurrentKey = false) {
    const key = P.normalizeWord(word);
    if (prepared && prepared.key === key && prepared.accent === settings.accent) return prepared;
    const packet = createPreparedPacket(word);
    if (!preserveCurrentKey) {
      currentWordKey = key;
      prepared = packet;
    }
    return packet;
  }

  function createPreparedPacket(word) {
    const packet = {
      key: P.normalizeWord(word),
      accent: settings.accent,
      result: null,
      promise: null,
      deepseek: null,
      deepseekPromise: null,
      plural: null,
      pluralPromise: null
    };
    packet.promise = sendMessage({ type: "PREPARE_WORD", word, accent: settings.accent })
      .then((response) => {
        packet.result = response?.ok ? response : { ok: false, found: false, candidates: [] };
        return packet.result;
      })
      .catch(() => {
        packet.result = { ok: false, found: false, candidates: [] };
        return packet.result;
      });
    packet.deepseekPromise = sendMessage({ type: "PREPARE_DEEPSEEK_WORD", word })
      .then((response) => {
        packet.deepseek = response || { ok: false, configured: false, available: false };
        return packet.deepseek;
      })
      .catch(() => {
        packet.deepseek = { ok: false, configured: true, available: false, error: "DeepSeek 暂时无法连接" };
        return packet.deepseek;
      });
    packet.pluralPromise = sendMessage({ type: "PREPARE_PLURAL_USAGE", word, accent: settings.accent })
      .then((response) => {
        packet.plural = response || { ok: false, configured: false, available: false };
        return packet.plural;
      })
      .catch(() => {
        packet.plural = { ok: false, configured: true, available: false, error: "复数用法暂时无法连接" };
        return packet.plural;
      });
    return packet;
  }

  function revealAttempt(attempt, state) {
    if (!settings.enabled) return;
    lastResult = {
      attempt,
      state,
      previous: attempt.previous === true,
      package: attempt.packet.result,
      analysis: null,
      deepseek: attempt.packet.deepseek,
      plural: attempt.packet.plural,
      typedCandidate: null,
      learning: null
    };
    if (closedForSession) return;
    ensureOverlay();
    overlayHost.hidden = false;
    renderResult(lastResult);
    const token = ++renderSequence;
    attempt.packet.promise.then(async (wordPackage) => {
      if (!lastResult || lastResult.attempt.id !== attempt.id) return;
      lastResult.package = wordPackage;
      if (state === "incorrect" && attempt.typed && !sameWord(attempt.typed, attempt.details.word)) {
        lastResult.analysis = await sendMessage({
          type: "ANALYZE_ATTEMPT",
          typed: attempt.typed,
          correct: attempt.details.word,
          accent: settings.accent,
          record: true,
          attemptKey: `${attempt.id}:${attempt.details.word}:${attempt.typed}:${Date.now()}`
        }).catch(() => ({ ok: false }));
      }
      lastResult.learning = lastResult.analysis?.learning || await sendMessage({ type: "GET_LEARNING_STATE" }).catch(() => null);
      if (token !== renderSequence || closedForSession || !settings.enabled) return;
      renderResult(lastResult);
    });
    attachDeepseekResult(attempt.packet, attempt.id, token);
    attachPluralResult(attempt.packet, attempt.id, token);
    attachTypedCandidate(lastResult, token);
  }

  function refreshLastResult() {
    if (!lastResult) return;
    const { attempt, state, previous } = lastResult;
    const packet = createPreparedPacket(attempt.details.word);
    attempt.packet = packet;
    lastResult = { attempt, state, previous, package: null, analysis: null, deepseek: packet.deepseek, plural: packet.plural, typedCandidate: null, learning: null };
    renderResult(lastResult);
    const token = ++renderSequence;
    packet.promise.then(async (wordPackage) => {
      if (token !== renderSequence || !lastResult) return;
      lastResult.package = wordPackage;
      if (state === "incorrect" && attempt.typed && !sameWord(attempt.typed, attempt.details.word)) {
        lastResult.analysis = await sendMessage({ type: "ANALYZE_ATTEMPT", typed: attempt.typed, correct: attempt.details.word, accent: settings.accent, record: false }).catch(() => ({ ok: false }));
      }
      lastResult.learning = lastResult.analysis?.learning || await sendMessage({ type: "GET_LEARNING_STATE" }).catch(() => null);
      if (token === renderSequence && !closedForSession) renderResult(lastResult);
    });
    attachDeepseekResult(packet, attempt.id, token);
    attachPluralResult(packet, attempt.id, token);
    attachTypedCandidate(lastResult, token);
  }

  function attachDeepseekResult(packet, attemptId, token) {
    packet.deepseekPromise?.then((response) => {
      if (
        token !== renderSequence ||
        closedForSession ||
        !lastResult ||
        lastResult.attempt.id !== attemptId
      ) return;
      lastResult.deepseek = response;
      renderResult(lastResult);
    });
  }

  function attachPluralResult(packet, attemptId, token) {
    packet.pluralPromise?.then((response) => {
      if (
        token !== renderSequence ||
        closedForSession ||
        !lastResult ||
        lastResult.attempt.id !== attemptId
      ) return;
      lastResult.plural = response;
      renderResult(lastResult);
    });
  }

  function attachTypedCandidate(result, token) {
    const typed = result?.attempt?.typed;
    const correct = result?.attempt?.details?.word;
    if (result?.state !== "incorrect" || !typed || sameWord(typed, correct)) {
      result.typedCandidate = { ok: true, found: false };
      return;
    }
    const attemptId = result.attempt.id;
    sendMessage({ type: "PREPARE_TYPED_CANDIDATE", typed, correct, accent: settings.accent })
      .then((response) => {
        if (
          token !== renderSequence ||
          closedForSession ||
          !lastResult ||
          lastResult.attempt.id !== attemptId
        ) return;
        lastResult.typedCandidate = response || { ok: false, found: false };
        renderResult(lastResult);
      })
      .catch(() => {
        if (token !== renderSequence || !lastResult || lastResult.attempt.id !== attemptId) return;
        lastResult.typedCandidate = { ok: false, found: false };
        renderResult(lastResult);
      });
  }

  function renderResult(result) {
    const ui = ensureOverlay();
    const packet = result.package;
    const protectedCurrentWord = Boolean(
      result.previous &&
      currentWordKey &&
      P.normalizeWord(result.attempt.details.word) === currentWordKey
    );
    if (protectedCurrentWord) {
      renderProtectedCurrentWord(ui);
      return;
    }
    const target = packet?.target || {
      word: result.attempt.details.word,
      meaning: result.attempt.details.meaning,
      ipa: result.attempt.details.ipa,
      tokens: P.tokenizeIpa(result.attempt.details.ipa).map((token) => ({ token, different: false })),
      audioUrl: "",
      book: ""
    };
    ui.previous.hidden = !result.previous;
    ui.status.className = `status ${result.state}`;
    ui.status.textContent = result.attempt.mode === "choice"
      ? result.state === "correct" ? "选择正确" : "需要再辨一次"
      : result.state === "correct" ? "拼写正确" : "需要再辨一次";
    ui.accent.textContent = settings.accent === "uk" ? "英式发音" : "美式发音";
    ui.word.textContent = target.word || result.attempt.details.word;
    ui.book.textContent = formatSourceLabels(target).join(" · ") || "雅思词";
    ui.meaning.textContent = target.meaning || result.attempt.details.meaning || "暂无中文释义";
    renderIpa(ui.targetIpa, target.tokens?.length ? target.tokens : P.tokenizeIpa(target.ipa).map((token) => ({ token, different: false })), settings.accent);
    audioShortcuts.target = { url: target.audioUrl, word: target.word };
    ui.playTarget.disabled = false;
    decorateAudioButton(ui.playTarget, "·");
    ui.playTarget.onclick = () => playAudio(target.audioUrl, target.word);
    ui.attempt.textContent = result.attempt.mode === "choice"
      ? result.state === "correct"
        ? `你的选择：${result.attempt.choice || "认识"}。本题已完成，面板会保留。`
        : `你的选择：${result.attempt.choice || "不认识"}`
      : result.state === "correct"
        ? "本题已核对，面板会保留到下一题。"
        : `你的拼写：${result.attempt.typed || "（空）"}`;
    renderAnalysis(ui.analysis, result);
    renderCandidates(ui.candidates, ui.candidateCount, packet, result.previous ? currentWordKey : "", result.typedCandidate);
    renderPlural(ui.plural, result.plural, target);
    renderDeepseek(ui.deepseek, result.deepseek);
    renderLearning(ui.learning, result);
  }

  function renderProtectedCurrentWord(ui) {
    ui.previous.hidden = false;
    ui.status.className = "status protected";
    ui.status.textContent = "拼写中保护";
    ui.accent.textContent = settings.accent === "uk" ? "英式发音" : "美式发音";
    ui.word.textContent = "当前词已隐藏";
    ui.book.textContent = "完成判题后恢复";
    ui.targetIpa.replaceChildren();
    audioShortcuts = { target: null, candidates: [] };
    ui.playTarget.disabled = true;
    decorateAudioButton(ui.playTarget, "·");
    ui.playTarget.onclick = null;
    ui.meaning.textContent = "为避免泄露当前答案，这道词对应的释义、音标、发音和相关词暂时不显示。";
    ui.attempt.textContent = "你仍可以拖动或关闭面板。";
    ui.analysis.hidden = true;
    ui.analysis.replaceChildren();
    ui.deepseek.hidden = true;
    ui.deepseek.replaceChildren();
    ui.plural.hidden = true;
    ui.plural.replaceChildren();
    ui.learning.hidden = true;
    ui.learning.replaceChildren();
    ui.candidateCount.textContent = "已隐藏";
    ui.candidates.replaceChildren(element("div", "当前词判题后会自动显示新的辨音结果。", "empty"));
  }

  function renderAnalysis(container, result) {
    container.replaceChildren();
    if (result.state !== "incorrect" || !result.attempt.typed || sameWord(result.attempt.typed, result.attempt.details.word)) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    const title = element("h3", "听音拼写纠错");
    container.append(title);
    const analysis = result.analysis;
    if (!analysis?.ok || !analysis.available) {
      container.append(element("div", "正在建立声音—字母对齐……", "loading"));
      return;
    }
    const spelling = element("div", "", "spelling-compare");
    const typedLine = element("div", "", "compare-line");
    typedLine.append(element("span", "你写的", "compare-label"), renderCharacterLine(analysis.spelling.parts, "typed"));
    const correctLine = element("div", "", "compare-line");
    correctLine.append(element("span", "正确词", "compare-label"), renderCharacterLine(analysis.spelling.parts, "correct"));
    spelling.append(typedLine, correctLine);
    container.append(spelling);

    const soundSpelling = analysis.soundSpelling;
    if (!soundSpelling?.blocks?.length) {
      container.append(element("p", "未取得可靠的正确读音，本题暂时只显示字母差异。", "muted"));
      return;
    }
    const pronunciation = element("div", "", "correct-pronunciation");
    pronunciation.append(element("span", "你听到的声音", "compare-label"));
    const correctIpa = element("div", "", "ipa large");
    renderIpa(correctIpa, P.tokenizeIpa(analysis.correctIpa).map((token) => ({ token, different: false })), settings.accent);
    pronunciation.append(correctIpa, audioButton(analysis.correctAudio, analysis.correct));
    container.append(pronunciation, renderSoundGrid(soundSpelling.blocks));

    const legend = element("div", "", "alignment-legend");
    legend.append(legendItem("正确对应", "correct"), legendItem("错误字母", "error"), legendItem("漏写部分", "missing"));
    container.append(legend);

    const issues = element("div", "", "issue-list");
    for (const issue of soundSpelling.issues || []) {
      const card = element("article", "", `issue-card ${issue.type}`);
      card.append(
        element("strong", `${issue.order}. ${issue.title}`, "issue-title"),
        element("p", issue.explanation, "issue-explanation"),
        element("p", `训练：${issue.training}`, "issue-training")
      );
      issues.append(card);
    }
    if (issues.childElementCount) container.append(issues);
  }

  function renderSoundGrid(blocks) {
    const grid = element("div", "", "sound-grid");
    const header = element("div", "", "sound-row sound-header");
    header.append(element("span", "声音"), element("span", "正确拼写"), element("span", "你的写法"));
    grid.append(header);
    for (const block of blocks || []) {
      const row = element("div", "", `sound-row ${block.status}`);
      const soundButton = element("button", block.sound, "sound-block-button");
      soundButton.type = "button";
      soundButton.title = block.phonemes?.length ? `播放 ${block.sound}` : "静音字母没有独立发音";
      soundButton.disabled = !block.phonemes?.length;
      soundButton.addEventListener("click", () => playPhonemeSequence(block.phonemes));
      row.append(soundButton, renderAlignmentParts(block.correctParts), renderAlignmentParts(block.typedParts));
      grid.append(row);
    }
    return grid;
  }

  function renderAlignmentParts(parts) {
    const cell = element("span", "", "alignment-cell");
    for (const part of parts || []) cell.append(element("b", part.text, `alignment-part ${part.state}`));
    return cell;
  }

  function legendItem(label, state) {
    const item = element("span", "", "legend-item");
    item.append(element("i", "", `legend-dot ${state}`), document.createTextNode(label));
    return item;
  }

  function renderCharacterLine(parts, side) {
    const line = element("strong", "", "character-line");
    for (const part of parts || []) {
      const value = side === "typed" ? part.typed : part.correct;
      if (!value) {
        const gap = element("span", "∅", "char changed gap");
        gap.title = side === "typed" ? "这里漏写了字母" : "这里多写了字母";
        line.append(gap);
      } else {
        line.append(element("span", value, part.type === "equal" ? "char" : `char changed ${part.type}`));
      }
    }
    return line;
  }

  function renderDeepseek(container, response) {
    container.replaceChildren();
    container.hidden = false;
    const heading = element("div", "", "deepseek-heading");
    heading.append(
      element("strong", "DeepSeek 词汇应用"),
      element("span", "快速模型 · 提前加载", "deepseek-badge")
    );
    container.append(heading);

    if (!response) {
      container.append(element("div", "正在准备同义词区别与常用表达……", "deepseek-loading"));
      return;
    }
    if (!response.configured) {
      container.append(element("p", "在扩展设置中保存 DeepSeek API Key 后，这里会自动加载词汇应用说明。", "deepseek-note"));
      return;
    }
    if (!response.ok || !response.available) {
      container.append(element("p", response.error || "DeepSeek 暂时无法提供说明，请稍后再试。", "deepseek-error"));
      return;
    }

    const data = response.data || {};
    const synonymSection = element("div", "", "deepseek-part");
    synonymSection.append(element("h3", "同义词的应用场景区别"));
    const synonyms = element("div", "", "synonym-list");
    for (const item of (data.synonymDifferences || []).slice(0, 5)) {
      const card = element("article", "", "synonym-item");
      const title = element("div", "", "synonym-title");
      title.append(
        element("strong", item.word || "相关词"),
        element("span", (item.scenarios || []).join(" · ") || "常见语境")
      );
      card.append(title);
      if (item.difference) card.append(element("p", item.difference));
      if (item.example) card.append(element("small", item.example));
      synonyms.append(card);
    }
    synonymSection.append(synonyms.childElementCount ? synonyms : element("p", "暂无可靠的同义词场景区别。", "deepseek-note"));

    const expressionSection = element("div", "", "deepseek-part");
    expressionSection.append(element("h3", "常用口语与写作表达"));
    const expressions = element("div", "", "expression-list");
    for (const item of (data.expressions || []).slice(0, 6)) {
      const card = element("article", "", "expression-item");
      const title = element("div", "", "expression-title");
      title.append(element("strong", item.phrase || "常用表达"), element("span", formatRegister(item.register)));
      card.append(title);
      if (item.meaning) card.append(element("p", item.meaning));
      if (item.example) card.append(element("small", item.example));
      expressions.append(card);
    }
    expressionSection.append(expressions.childElementCount ? expressions : element("p", "暂无可用表达。", "deepseek-note"));
    container.append(synonymSection, expressionSection);
  }

  function renderPlural(container, response, target) {
    container.replaceChildren();
    container.hidden = false;
    const heading = element("div", "", "plural-heading");
    heading.append(
      element("strong", "复数与可数用法"),
      element("span", "DeepSeek 快速分析", "plural-badge")
    );
    container.append(heading);

    if (!response) {
      container.append(element("strong", "正在准备复数形式与使用条件……", "plural-state"));
      return;
    }
    if (!response.configured) {
      container.append(element("strong", "保存有效的 DeepSeek API Key 后自动显示复数用法。", "plural-state unavailable"));
      return;
    }
    if (!response.ok || !response.available || !response.data) {
      container.append(element("strong", response.error || "复数用法暂时无法加载。", "plural-state error"));
      return;
    }

    const data = response.data;
    const line = element("div", "", "plural-line");
    line.append(
      element("span", "复数", "plural-label"),
      element("strong", data.plural || "无常用复数", "plural-word"),
      element("span", pluralNounType(data.nounType), `plural-type ${data.nounType || "not_noun"}`)
    );
    if (data.plural) line.append(pluralAudioButton(data.plural));
    container.append(line);
    if (data.plural) {
      const ipa = element("div", "", "ipa plural-ipa");
      if (data.pluralIpa) {
        renderIpa(ipa, P.tokenizeIpa(data.pluralIpa).map((token) => ({ token, different: false })), settings.accent);
      } else {
        ipa.textContent = "复数音标暂缺";
      }
      container.append(ipa);
    }
    container.append(element("strong", data.note || `${target?.word || "该词"} 的复数用法需结合语境判断。`, "plural-note"));
    if (data.plural && target?.word) {
      const actions = element("div", "", "plural-actions");
      const favorite = element("button", "♡ 收藏复数对比", "favorite-button plural-favorite");
      const pluralCandidate = {
        word: data.plural,
        ipa: data.pluralIpa || "",
        meaning: `${target.meaning || target.word}（复数）`
      };
      favorite.type = "button";
      favorite.dataset.favoriteId = comparisonId(target, pluralCandidate, settings.accent);
      favorite.title = `把 ${target.word} 和复数 ${data.plural} 保存到读音对比表`;
      favorite.addEventListener("click", () => savePronunciationComparison(target, pluralCandidate, favorite));
      actions.append(favorite);
      container.append(actions);
      refreshFavoriteButtons(container);
    }
  }

  function pluralNounType(value) {
    if (value === "countable") return "可数";
    if (value === "uncountable") return "不可数";
    if (value === "both") return "可数/不可数";
    return "非名词用法";
  }

  function pluralAudioButton(word) {
    const button = element("button", "🔊", "plural-play");
    button.type = "button";
    button.title = `播放 ${word} 的完整发音`;
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      button.disabled = true;
      const response = await sendMessage({ type: "GET_COMPARISON_AUDIO", word, accent: settings.accent }).catch(() => null);
      button.disabled = false;
      playAudio(response?.ok ? response.audioUrl : "", word);
    });
    return button;
  }

  function formatRegister(value) {
    const register = String(value || "").toLowerCase();
    if (register.includes("spoken") || register.includes("口语")) return "口语";
    if (register.includes("writing") || register.includes("written") || register.includes("写作")) return "写作";
    return value || "通用";
  }

  function renderLearning(container, result) {
    container.replaceChildren();
    const learning = result.learning || result.analysis?.learning;
    if (!learning?.profile) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    const heading = element("div", "", "learning-heading");
    heading.append(
      element("strong", "音标—错误字母映射记录"),
      element("span", `${learning.profile.patternCount || 0} 类 · ${learning.profile.totalIncorrectAttempts || 0} 次错答`, "learning-total")
    );
    container.append(heading);

    const weaknessMatches = result.package?.target?.weaknessMatches || [];
    if (weaknessMatches.length) {
      const alert = element("div", "", "weakness-match");
      alert.append(element("strong", "本词命中你的历史弱项"));
      alert.append(element("span", weaknessMatches.map((match) => `${match.sound}：应写 ${match.correctGrapheme}（${match.count}次）`).join(" · ")));
      container.append(alert);
    }

    const patterns = element("div", "", "pattern-list");
    const topPatterns = learning.profile.topPatterns || [];
    if (!topPatterns.length) {
      patterns.append(element("p", "完成一次错题后，这里会记录“哪个声音被写成了哪个错误字母”。", "muted compact"));
    } else {
      for (const pattern of topPatterns.slice(0, 5)) {
        const item = element("article", "", "pattern-item");
        const mapping = element("div", "", "pattern-mapping");
        mapping.append(
          element("strong", pattern.sound || "声音", "pattern-sound"),
          element("span", `正确：${pattern.correctGrapheme || "—"}`, "pattern-correct"),
          element("span", `你写成：${pattern.userGrapheme || "漏写"}`, "pattern-wrong")
        );
        const meta = element("div", "", "pattern-meta");
        meta.append(element("b", `${pattern.count || 0} 次`, "pattern-count"));
        const exampleWords = (pattern.words || pattern.examples || [])
          .map((entry) => typeof entry === "string" ? entry : entry?.correct)
          .filter(Boolean)
          .slice(0, 3);
        if (exampleWords.length) meta.append(element("small", exampleWords.join(" · ")));
        item.append(mapping, meta);
        patterns.append(item);
      }
    }
    container.append(patterns);
  }

  function renderCandidates(container, countNode, packet, excludedCurrentKey, typedCandidateResponse) {
    container.replaceChildren();
    audioShortcuts.candidates = [];
    if (!packet) {
      countNode.textContent = "准备中";
      container.append(element("div", "正在从扩展雅思词库中筛选……", "loading"));
      return;
    }
    const regularItems = (packet.candidates || [])
      .filter((item) => P.normalizeWord(item.word) !== excludedCurrentKey)
      .slice(0, 4);
    const typedItem = typedCandidateResponse?.ok && typedCandidateResponse?.found
      ? typedCandidateResponse.candidate
      : null;
    const typedKey = P.normalizeWord(typedItem?.word || "");
    const items = [
      ...(typedItem && typedKey !== excludedCurrentKey ? [typedItem] : []),
      ...regularItems.filter((item) => P.normalizeWord(item.word) !== typedKey)
    ].slice(0, 5);
    audioShortcuts.candidates = items.map((item) => ({ url: item.audioUrl, word: item.word }));
    countNode.textContent = `${items.length}/5`;
    if (!items.length) {
      container.append(element("div", "本题没有符合门槛的近音词或形近词。", "empty"));
      return;
    }
    const target = packet.target || null;
    for (const [index, item] of items.entries()) {
      const card = element("article", "", `candidate-card${item.userInputCandidate ? " typed-candidate" : ""}`);
      const top = element("div", "", "candidate-top");
      const identity = element("div", "", "candidate-identity");
      identity.append(element("strong", item.word, "candidate-word"));
      identity.append(element("span", item.label, "match-badge"));
      if (item.priority) identity.append(element("span", "重点词", "priority-badge"));
      for (const label of formatSourceLabels(item).slice(0, 3)) {
        identity.append(element("span", label, "book-badge"));
      }
      const controls = element("div", "", "candidate-controls");
      const play = audioButton(item.audioUrl, item.word, String(index + 1));
      const favorite = element("button", "♡ 收藏", "favorite-button candidate-favorite");
      favorite.type = "button";
      favorite.dataset.favoriteId = comparisonId(target, item, settings.accent);
      favorite.disabled = !target?.word || !item?.word;
      favorite.title = "把本题原词和这个相似词保存到读音对比表";
      favorite.setAttribute("aria-label", `收藏 ${item.word} 的读音对比`);
      favorite.addEventListener("click", () => savePronunciationComparison(target, item, favorite));
      controls.append(play, favorite);
      top.append(identity, controls);
      const ipa = element("div", "", "ipa candidate-ipa");
      renderIpa(ipa, item.tokens || P.tokenizeIpa(item.ipa).map((token) => ({ token, different: false })), settings.accent);
      card.append(top, ipa, element("p", item.meaning || "暂无中文释义", "candidate-meaning"));
      container.append(card);
    }
    refreshFavoriteButtons(container);
  }

  function comparisonId(target, candidate, accent) {
    const left = P.normalizeWord(target?.word || "");
    const right = P.normalizeWord(candidate?.word || "");
    return `${accent === "uk" ? "uk" : "us"}:${left}:${right}`;
  }

  function comparisonWord(item) {
    return {
      word: String(item?.word || "").trim().slice(0, 120),
      ipa: P.cleanIpa(item?.ipa || "").slice(0, 180),
      meaning: String(item?.meaning || "暂无中文释义").replace(/\s+/g, " ").trim().slice(0, 500)
    };
  }

  function refreshFavoriteButtons(container) {
    chrome.storage.local.get({ [COMPARISONS_KEY]: [] }, (state) => {
      const ids = new Set((Array.isArray(state[COMPARISONS_KEY]) ? state[COMPARISONS_KEY] : []).map((item) => item?.id));
      for (const button of container.querySelectorAll(".favorite-button")) {
        if (!ids.has(button.dataset.favoriteId)) continue;
        button.textContent = button.classList.contains("candidate-favorite") ? "✓ 已藏" : "✓ 已收藏";
        button.classList.add("saved");
        button.disabled = true;
      }
    });
  }

  function savePronunciationComparison(target, candidate, button) {
    if (!target?.word || !candidate?.word || button.disabled) return;
    button.disabled = true;
    button.textContent = button.classList.contains("candidate-favorite") ? "…" : "保存中…";
    const id = comparisonId(target, candidate, settings.accent);
    chrome.storage.local.get({ [COMPARISONS_KEY]: [] }, (state) => {
      const stored = Array.isArray(state[COMPARISONS_KEY]) ? state[COMPARISONS_KEY] : [];
      const record = {
        id,
        accent: settings.accent === "uk" ? "uk" : "us",
        target: comparisonWord(target),
        candidate: comparisonWord(candidate),
        createdAt: Date.now()
      };
      const next = [record, ...stored.filter((item) => item?.id !== id)].slice(0, 300);
      chrome.storage.local.set({ [COMPARISONS_KEY]: next }, () => {
        if (chrome.runtime.lastError) {
          button.disabled = false;
          button.textContent = "保存失败，重试";
          return;
        }
        button.textContent = button.classList.contains("candidate-favorite") ? "✓ 已藏" : "✓ 已收藏";
        button.classList.add("saved");
        button.disabled = true;
      });
    });
  }

  function renderIpa(container, tokens, accent) {
    container.replaceChildren();
    container.append(document.createTextNode("/"));
    for (const entry of tokens || []) {
      const token = typeof entry === "string" ? entry : entry.token;
      const button = element("button", token, `ipa-token${entry?.different ? " different" : ""}`);
      button.type = "button";
      button.title = `点击播放 /${token}/ 的 KK 音素示范音`;
      button.addEventListener("click", () => playPhoneme(token, accent));
      container.append(button);
    }
    container.append(document.createTextNode("/"));
  }

  function formatSourceLabels(item) {
    const labels = Array.isArray(item?.tags) && item.tags.length
      ? item.tags
      : [item?.book].filter(Boolean);
    return [...new Set(labels.map((value) => String(value || "").trim()).filter(Boolean))];
  }

  function audioButton(url, word, shortcut) {
    const button = element("button", "", "audio-button");
    button.type = "button";
    button.title = `播放 ${word || "单词"} 的完整发音`;
    decorateAudioButton(button, shortcut);
    button.addEventListener("click", () => playAudio(url, word));
    return button;
  }

  function decorateAudioButton(button, shortcut) {
    button.replaceChildren(document.createTextNode("🔊"));
    if (shortcut) button.append(element("kbd", shortcut, "shortcut-key"));
  }

  function playPhoneme(token) {
    const urls = P.phonemeAudioFiles(token)
      .map((file) => chrome.runtime.getURL(`audio/phonemes/kk/${file}`));
    playAudioSequence(urls);
  }

  function playPhonemeSequence(tokens) {
    const urls = (tokens || []).flatMap((token) => P.phonemeAudioFiles(token))
      .map((file) => chrome.runtime.getURL(`audio/phonemes/kk/${file}`));
    playAudioSequence(urls);
  }

  function stopActiveAudio() {
    activeAudioRun += 1;
    if (activeAudio) {
      activeAudio.pause();
      activeAudio.currentTime = 0;
      activeAudio = null;
    }
    return activeAudioRun;
  }

  function playAudioSequence(urls) {
    const queue = (urls || []).filter(Boolean);
    if (!queue.length) return;
    const runId = stopActiveAudio();
    let index = 0;
    const playNext = () => {
      if (runId !== activeAudioRun || index >= queue.length) return;
      const audio = new Audio(queue[index++]);
      activeAudio = audio;
      let advanced = false;
      const advance = () => {
        if (advanced || runId !== activeAudioRun) return;
        advanced = true;
        playNext();
      };
      audio.addEventListener("ended", advance, { once: true });
      audio.addEventListener("error", advance, { once: true });
      audio.play().catch(advance);
    };
    playNext();
  }

  function playAudio(url, word) {
    stopActiveAudio();
    if (!url) {
      if (word && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(word);
        utterance.lang = settings.accent === "uk" ? "en-GB" : "en-US";
        window.speechSynthesis.speak(utterance);
      }
      return;
    }
    activeAudio = new Audio(url);
    activeAudio.play().catch(() => {
      if (word && !String(word).startsWith("/")) {
        const utterance = new SpeechSynthesisUtterance(word);
        utterance.lang = settings.accent === "uk" ? "en-GB" : "en-US";
        window.speechSynthesis.speak(utterance);
      }
    });
  }

  function markAsPrevious() {
    if (!lastResult) return;
    lastResult.previous = true;
    if (overlayUi && !closedForSession) renderResult(lastResult);
  }

  function ensureOverlay() {
    if (overlayHost && overlayUi) return overlayUi;
    overlayHost = document.createElement("div");
    overlayHost.id = "ielts-soundalike-helper-v2";
    overlayHost.hidden = true;
    overlayHost.style.position = "fixed";
    overlayHost.style.zIndex = "2147483647";
    const shadow = overlayHost.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<style>${overlayStyles()}</style>
      <section class="panel" role="dialog" aria-label="听写辨音助手">
        <header class="drag-handle">
          <div><strong>听写辨音助手</strong><span class="previous" hidden>上一题</span></div>
          <button class="close" type="button" title="本页关闭">×</button>
        </header>
        <div class="body normal-body">
          <div class="result-line"><span class="status"></span><span class="accent"></span></div>
          <section class="target-card">
            <div class="target-top"><div><div class="word-line"><strong class="word"></strong><span class="book"></span></div><div class="ipa target-ipa"></div></div><button class="play-target audio-button" type="button" title="播放完整单词">🔊<kbd class="shortcut-key">·</kbd></button></div>
            <p class="meaning"></p><p class="attempt"></p>
          </section>
          <section class="analysis" hidden></section>
          <section class="candidate-section">
            <div class="section-title"><div><strong>近音词与形近词</strong><small>答案词 + 核心词 + 10 类场景词</small></div><span class="candidate-count">准备中</span></div>
            <div class="candidates"></div>
          </section>
          <section class="plural" hidden></section>
          <section class="deepseek" hidden></section>
          <section class="learning" hidden></section>
        </div>
      </section>`;
    document.documentElement.appendChild(overlayHost);
    overlayUi = {
      panel: shadow.querySelector(".panel"),
      handle: shadow.querySelector(".drag-handle"),
      close: shadow.querySelector(".close"),
      previous: shadow.querySelector(".previous"),
      status: shadow.querySelector(".status"),
      accent: shadow.querySelector(".accent"),
      word: shadow.querySelector(".word"),
      book: shadow.querySelector(".book"),
      targetIpa: shadow.querySelector(".target-ipa"),
      playTarget: shadow.querySelector(".play-target"),
      meaning: shadow.querySelector(".meaning"),
      attempt: shadow.querySelector(".attempt"),
      analysis: shadow.querySelector(".analysis"),
      plural: shadow.querySelector(".plural"),
      deepseek: shadow.querySelector(".deepseek"),
      learning: shadow.querySelector(".learning"),
      normalBody: shadow.querySelector(".normal-body"),
      candidates: shadow.querySelector(".candidates"),
      candidateCount: shadow.querySelector(".candidate-count")
    };
    overlayUi.close.addEventListener("click", () => hideOverlay(true));
    installDragging(overlayUi.handle);
    installResizing(overlayUi.panel);
    chrome.storage.local.get({ overlayPosition: null, overlaySize: null }, ({ overlayPosition, overlaySize }) => {
      if (overlaySize && Number.isFinite(overlaySize.width) && Number.isFinite(overlaySize.height)) {
        overlayUi.panel.style.width = `${Math.min(overlaySize.width, window.innerWidth - 16)}px`;
        overlayUi.panel.style.height = `${Math.min(overlaySize.height, window.innerHeight - 16)}px`;
      }
      if (overlayPosition && Number.isFinite(overlayPosition.x) && Number.isFinite(overlayPosition.y)) {
        overlayHost.style.left = `${overlayPosition.x}px`;
        overlayHost.style.top = `${overlayPosition.y}px`;
      } else {
        overlayHost.style.left = `${Math.max(12, window.innerWidth - 544)}px`;
        overlayHost.style.top = "92px";
      }
      clampHostPosition();
    });
    return overlayUi;
  }

  function installResizing(panel) {
    if (!("ResizeObserver" in window)) return;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(resizeSaveTimer);
      resizeSaveTimer = window.setTimeout(() => {
        const rect = panel.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return;
        chrome.storage.local.set({
          overlaySize: { width: Math.round(rect.width), height: Math.round(rect.height) }
        });
        clampHostPosition();
      }, 180);
    });
    observer.observe(panel);
  }

  function installDragging(handle) {
    handle.addEventListener("pointerdown", (event) => {
      if (event.target instanceof Element && event.target.closest("button")) return;
      const rect = overlayHost.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const originX = rect.left;
      const originY = rect.top;
      handle.setPointerCapture(event.pointerId);
      const move = (moveEvent) => {
        overlayHost.style.left = `${originX + moveEvent.clientX - startX}px`;
        overlayHost.style.top = `${originY + moveEvent.clientY - startY}px`;
        clampHostPosition();
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        const finalRect = overlayHost.getBoundingClientRect();
        chrome.storage.local.set({ overlayPosition: { x: Math.round(finalRect.left), y: Math.round(finalRect.top) } });
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up, { once: true });
    });
  }

  function clampHostPosition() {
    if (!overlayHost) return;
    const rect = overlayHost.getBoundingClientRect();
    const maxX = Math.max(8, window.innerWidth - Math.min(rect.width || 520, window.innerWidth - 16));
    const maxY = Math.max(8, window.innerHeight - Math.min(rect.height || 720, window.innerHeight - 16));
    const x = Math.min(Math.max(8, Number.parseFloat(overlayHost.style.left) || rect.left || 8), maxX);
    const y = Math.min(Math.max(8, Number.parseFloat(overlayHost.style.top) || rect.top || 8), maxY);
    overlayHost.style.left = `${x}px`;
    overlayHost.style.top = `${y}px`;
  }

  function hideOverlay(byUser) {
    if (overlayHost) overlayHost.hidden = true;
    if (byUser) closedForSession = true;
  }

  function isLearningMode() {
    if (IS_IDICTATION) {
      if (location.pathname !== "/home") return false;
      const main = document.querySelector("main");
      return Boolean(
        main && (
          readIdictationSpellingDetails() ||
          readIdictationCurrentClue() ||
          main.querySelector('button[aria-label="隐藏选项，直接选是否认识"]') ||
          Array.from(main.querySelectorAll("button")).some((button) => ["认识", "不认识"].includes(textOf(button)))
        )
      );
    }
    const area = document.querySelector(".word_dictation_main_audio");
    return Boolean(area && textOf(area).includes("核对答案"));
  }

  function readIdictationCurrentClue() {
    const main = document.querySelector("main");
    if (!main) return null;
    const candidates = main.querySelectorAll("div.opacity-0");
    for (const ipaNode of candidates) {
      if (ipaNode.closest("button")) continue;
      const rawIpa = textOf(ipaNode);
      if (!/^\/[^/]+\/$/.test(rawIpa)) continue;
      const container = ipaNode.parentElement;
      const combined = textOf(container);
      const meaning = combined.replace(rawIpa, "").trim();
      if (!meaning) continue;
      return { ipa: rawIpa.slice(1, -1).trim(), meaning };
    }
    return null;
  }

  function readIdictationSpellingDetails() {
    const main = document.querySelector("main");
    const wordContainer = main?.querySelector(".error-word-study");
    const word = textOf(wordContainer);
    if (!word || !/^[A-Za-z][A-Za-z'’\- ]*$/.test(word)) return null;
    const clue = readIdictationCurrentClue();
    return {
      word,
      ipa: clue?.ipa || "",
      meaning: clue?.meaning || ""
    };
  }

  function isIdictationSpellingJudged(expectedWord = "") {
    const wordContainer = document.querySelector("main .error-word-study");
    if (!wordContainer || wordContainer.classList.contains("opacity-0") || wordContainer.classList.contains("invisible")) return false;
    return !expectedWord || sameWord(textOf(wordContainer), expectedWord);
  }

  function readIdictationCompletedDetails() {
    const main = document.querySelector("main");
    if (!main) return null;
    for (const button of main.querySelectorAll("button")) {
      const parsed = parseDetails(textOf(button));
      if (parsed) return parsed;
      const leaves = Array.from(button.querySelectorAll("p, div, span"))
        .filter((node) => node.childElementCount === 0)
        .map((node) => textOf(node))
        .filter(Boolean);
      const word = leaves.find((value) => /^[A-Za-z][A-Za-z'’\- ]*$/.test(value));
      const ipaText = leaves.find((value) => /^\/[^/]+\/$/.test(value));
      const meaning = leaves.find((value) => value !== word && value !== ipaText && !/^[A-Za-z][A-Za-z'’\- ]*$/.test(value));
      if (word && ipaText && meaning) {
        return { word, ipa: ipaText.slice(1, -1).trim(), meaning };
      }
    }
    return null;
  }

  function normalizeMeaning(value) {
    return String(value || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\b(?:n|v|adj|adv|prep|pron|conj|num|art|aux|modal)\.?\b/gu, "")
      .replace(/[^\p{L}\p{N}]+/gu, "");
  }

  function readCurrentDetails() {
    const references = document.querySelectorAll(".word_dictation_main_word .word_dictation_content01 .el-popover__reference, .word_dictation_content01 .el-popover__reference");
    for (const reference of references) {
      const direct = Array.from(reference.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const full = textOf(reference);
      const parsed = parseDetails(direct) || parseDetails(full);
      if (parsed) return parsed;
    }
    return null;
  }

  function parseDetails(raw) {
    const text = String(raw || "").replace(/\s+/g, " ").trim();
    const match = text.match(/^([A-Za-z][A-Za-z'’\- ]*?)\s+(?:英|美)?\s*[\/]([^/]+)[\/]\s*(.*)$/u);
    if (!match) return null;
    return { word: match[1].trim(), ipa: match[2].trim(), meaning: match[3].trim() };
  }

  function readJudgementState() {
    const main = document.querySelector(".word_dictation_main_word");
    const top = document.querySelector(".word_dictation_content01");
    if (main?.classList.contains("word_dictation_bg_green") || top?.classList.contains("word_dictation_bg_top_green")) return "correct";
    if (main?.classList.contains("word_dictation_bg_red") || top?.classList.contains("word_dictation_bg_top_red")) return "incorrect";
    return "";
  }

  function sameWord(a, b) {
    return P.normalizeWord(a) === P.normalizeWord(b);
  }

  function textOf(node) {
    return String(node?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(response);
      });
    });
  }

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function overlayStyles() {
    return `
      :host{all:initial;color:#172033;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
      *{box-sizing:border-box}button{font:inherit}.panel{position:relative;z-index:2;display:flex;flex-direction:column;width:min(520px,calc(100vw - 24px));height:min(720px,calc(100vh - 24px));min-width:min(360px,calc(100vw - 16px));min-height:300px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);resize:both;background:#fff;border:1px solid #e5eaf2;border-radius:18px;box-shadow:0 20px 70px rgba(22,35,58,.25);overflow:hidden}
      .drag-handle{height:52px;padding:0 12px 0 18px;background:linear-gradient(135deg,#ff6b61,#ff4d48);color:#fff;display:flex;align-items:center;justify-content:space-between;cursor:grab;touch-action:none;user-select:none}.drag-handle:active{cursor:grabbing}.drag-handle>div{display:flex;align-items:center;gap:10px}.drag-handle strong{font-size:16px}.previous{font-size:12px;padding:3px 8px;border-radius:99px;background:rgba(255,255,255,.22)}
      .close{width:32px;height:32px;border:0;border-radius:9px;background:rgba(255,255,255,.18);color:#fff;font-size:24px;line-height:1;cursor:pointer}.close:hover{background:rgba(255,255,255,.3)}
      .body{flex:1;min-height:0;overflow:auto;padding:14px;background:#f6f8fc}.result-line{display:flex;justify-content:space-between;align-items:center;margin-bottom:9px}.status,.accent,.candidate-count,.book-badge,.book,.match-badge,.priority-badge{display:inline-flex;align-items:center;border-radius:99px;font-weight:700}.status{font-size:13px;padding:5px 10px}.status.correct{color:#087f5b;background:#dff7ed}.status.incorrect{color:#c92a2a;background:#ffe3e3}.status.protected{color:#5f3dc4;background:#eee9ff}.accent{font-size:12px;color:#57657b;background:#e9eef6;padding:4px 9px}
      .target-card,.analysis,.plural,.deepseek,.learning,.candidate-card{background:#fff;border:1px solid #e7ebf2;border-radius:14px}.target-card{padding:14px}.target-top,.candidate-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}.word-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.word{font-size:28px;line-height:1.15;color:#131b2d}.book{font-size:11px;padding:3px 7px;color:#52627a;background:#edf1f7}.meaning{margin:8px 0 0;font-size:14px;color:#33415c;line-height:1.55}.attempt{margin:8px 0 0;padding-top:8px;border-top:1px dashed #e6eaf0;font-size:12px;color:#68768d}
      .audio-button{min-width:42px;height:34px;flex:0 0 auto;padding:0 6px;border:1px solid #ffd1ce;border-radius:10px;background:#fff2f1;display:inline-flex;align-items:center;justify-content:center;gap:3px;cursor:pointer}.audio-button:hover{background:#ffe2df}.audio-button:disabled{opacity:.45;cursor:not-allowed}.shortcut-key{min-width:15px;height:16px;padding:0 3px;border:1px solid #e4aaa6;border-bottom-width:2px;border-radius:4px;background:#fff;color:#a43a35;font:700 10px/14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center}.ipa{display:flex;align-items:baseline;flex-wrap:wrap;color:#172033;font-family:"Segoe UI",Arial,sans-serif;font-size:27px;line-height:1.3;margin-top:3px}.ipa-token{padding:0 1px;border:0;background:transparent;color:inherit;font:inherit;line-height:inherit;cursor:pointer;border-radius:4px}.ipa-token:hover{background:#fff0ef;color:#ff4f48}.ipa-token.different{color:#e03131;font-weight:900;text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:3px}.ipa.large{font-size:22px;margin:0;flex:1}.target-ipa{font-size:28px}
      .analysis{margin-top:12px;padding:13px}.analysis h3{font-size:14px;margin:0 0 9px}.spelling-compare{display:grid;gap:6px}.compare-line,.correct-pronunciation{display:flex;align-items:center;gap:8px;min-height:30px}.correct-pronunciation{margin-top:10px;padding-top:10px;border-top:1px dashed #e1e6ee}.compare-label{width:68px;flex:0 0 68px;font-size:11px;color:#738198}.character-line{display:flex;font-size:20px;letter-spacing:1px}.char{min-width:14px;text-align:center}.char.changed{color:#e03131;font-weight:900;background:#fff0ef;border-radius:4px}.char.gap{font-size:13px;align-self:center}.muted{font-size:12px;color:#7b879a}.muted.compact{margin:5px 0}.loading,.empty{padding:18px;text-align:center;color:#7b8799;font-size:13px;background:#fff;border:1px dashed #d9e0eb;border-radius:12px}
      .sound-grid{margin-top:11px;border:1px solid #e1e6ee;border-radius:11px;overflow:hidden}.sound-row{display:grid;grid-template-columns:minmax(72px,.85fr) 1fr 1fr;align-items:stretch}.sound-row+ .sound-row{border-top:1px solid #edf0f5}.sound-header{background:#f3f6fa;color:#65738a;font-size:10px;font-weight:800}.sound-row>span,.sound-row>.sound-block-button{min-width:0;padding:8px 7px;border:0;border-right:1px solid #edf0f5;background:transparent;text-align:center}.sound-row>*:last-child{border-right:0}.sound-block-button{color:#3356a8;font-weight:900;cursor:pointer}.sound-block-button:hover{background:#edf2ff}.sound-block-button:disabled{color:#8b95a5;cursor:default}.alignment-cell{display:flex!important;align-items:center;justify-content:center;gap:1px;font-size:17px}.alignment-part{min-width:12px;padding:2px 1px;border-radius:4px}.alignment-part.correct{color:#087f5b;background:#e6fcf5}.alignment-part.error,.alignment-part.extra{color:#c92a2a;background:#fff0f0}.alignment-part.missing{color:#9a6700;background:#fff3bf}.alignment-legend{display:flex;gap:12px;flex-wrap:wrap;margin-top:7px;color:#6b778d;font-size:10px}.legend-item{display:inline-flex;align-items:center;gap:4px}.legend-dot{width:9px;height:9px;border-radius:3px}.legend-dot.correct{background:#63d5ad}.legend-dot.error{background:#ff8787}.legend-dot.missing{background:#ffd43b}
      .issue-list{display:grid;gap:7px;margin-top:10px}.issue-card{padding:9px 10px;border:1px solid #f1d5d2;border-left:3px solid #ff6259;border-radius:9px;background:#fff9f8}.issue-title{font-size:12px;color:#772f37}.issue-explanation,.issue-training{margin:4px 0 0;font-size:11px;line-height:1.5}.issue-explanation{color:#5a4650}.issue-training{color:#3e5c9a}.issue-card.missing_letter{border-left-color:#f4b400;background:#fffdf5}
      .deepseek{margin-top:12px;padding:12px;background:linear-gradient(180deg,#fff 0%,#fbfcff 100%)}.deepseek-heading,.learning-heading{display:flex;align-items:center;justify-content:space-between;gap:10px}.deepseek-heading>strong,.learning-heading>strong{font-size:13px}.deepseek-badge{padding:3px 7px;border-radius:99px;background:#e9edff;color:#4058a9;font-size:9px;font-weight:800}.deepseek-loading,.deepseek-note,.deepseek-error{margin:9px 0 0;padding:10px;border-radius:9px;font-size:11px;line-height:1.55}.deepseek-loading{color:#59677d;background:#f3f6fa}.deepseek-note{color:#5e6d84;background:#f5f7fb}.deepseek-error{color:#a43a35;background:#fff0ef}.deepseek-part{margin-top:11px}.deepseek-part h3{margin:0 0 7px;font-size:11px;color:#526078}.synonym-list,.expression-list{display:grid;gap:7px}.synonym-item,.expression-item{padding:8px 9px;border:1px solid #e7ebf2;border-radius:9px;background:#fff}.synonym-title,.expression-title{display:flex;align-items:center;justify-content:space-between;gap:8px}.synonym-title strong,.expression-title strong{font-size:12px;color:#23304a}.synonym-title span,.expression-title span{flex:0 0 auto;padding:2px 6px;border-radius:99px;background:#eef2ff;color:#4960ac;font-size:9px}.synonym-item p,.expression-item p{margin:4px 0 0;color:#4b5a72;font-size:10px;line-height:1.5}.synonym-item small,.expression-item small{display:block;margin-top:4px;color:#718096;font-size:9px;line-height:1.5}
      .plural{margin-top:10px;padding:9px 10px;background:linear-gradient(180deg,#fff 0%,#fbfcff 100%)}.plural-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.plural-heading>strong{font-size:12px}.plural-badge{padding:3px 7px;border-radius:99px;background:#e9edff;color:#4058a9;font-size:9px;font-weight:800}.plural-state{display:block;margin-top:7px;padding:7px 8px;border-radius:8px;background:#f3f6fa;color:#59677d;font-size:10px;line-height:1.4}.plural-state.unavailable{color:#6d788b;background:#f7f8fa}.plural-state.error{color:#a43a35;background:#fff0ef}.plural-line{display:flex;align-items:center;gap:6px;margin-top:7px;min-width:0}.plural-label{padding:2px 6px;border-radius:6px;background:#e9edff;color:#4058a9;font-size:9px;font-weight:900}.plural-word{min-width:0;overflow:hidden;color:#243552;font-size:16px;text-overflow:ellipsis;white-space:nowrap}.plural-type{padding:2px 6px;border-radius:99px;background:#e7f6ef;color:#087f5b;font-size:9px;font-weight:800}.plural-type.uncountable,.plural-type.not_noun{background:#f1f3f6;color:#667085}.plural-type.both{background:#fff1cc;color:#9a5b00}.plural-play{width:30px;height:27px;margin-left:auto;border:1px solid #ccd6ee;border-radius:8px;background:#fff;color:#4058a9;cursor:pointer}.plural-play:hover{background:#edf1ff}.plural-play:disabled{cursor:wait;opacity:.55}.plural-ipa{margin-top:2px;font-size:16px;color:#526a9a}.plural-note{display:block;margin-top:4px;color:#2f3b51;font-size:10px;line-height:1.45}.plural-actions{display:flex;justify-content:flex-end;margin-top:6px;padding-top:6px;border-top:1px dashed #e6eaf0}.plural-favorite{height:27px!important}
      .learning{margin-top:12px;padding:12px}.learning-total{font-size:10px;color:#78859a}.weakness-match{display:grid;gap:3px;margin-top:8px;padding:8px;border-radius:9px;background:#fff5e6;border:1px solid #ffe0ad}.weakness-match strong{font-size:10px;color:#9a5b00}.weakness-match span{font-size:10px;color:#6b5738}.pattern-list{display:grid;gap:7px;margin-top:8px}.pattern-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 9px;border-radius:9px;background:#f5f7fb}.pattern-mapping{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}.pattern-sound{font-size:15px;color:#2f4b90}.pattern-correct,.pattern-wrong{padding:2px 6px;border-radius:6px;font-size:10px}.pattern-correct{color:#087f5b;background:#e6fcf5}.pattern-wrong{color:#c92a2a;background:#fff0f0}.pattern-meta{display:grid;justify-items:end;gap:2px;flex:0 0 auto}.pattern-count{white-space:nowrap;font-size:10px;color:#b54b44}.pattern-meta small{max-width:130px;color:#7b8799;font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .candidate-section{margin-top:10px}.section-title{display:flex;align-items:center;justify-content:space-between;margin:0 2px 7px}.section-title>div{display:flex;flex-direction:column;gap:1px}.section-title strong{font-size:13px}.section-title small{font-size:9px;color:#7a8698}.candidate-count{padding:3px 7px;color:#ff514c;background:#ffe9e7;font-size:10px}.candidates{display:grid;gap:6px}.candidate-card{padding:9px 10px}.candidate-card.typed-candidate{border-color:#8fa1e6;background:linear-gradient(135deg,#f6f8ff,#fff)}.candidate-top{gap:8px}.candidate-identity{display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0}.candidate-word{font-size:20px;line-height:1.15;color:#172033}.match-badge{font-size:9px;padding:2px 5px;color:#4058a9;background:#e9edff}.priority-badge{font-size:9px;padding:2px 5px;color:#9b5200;background:#fff0c7}.book-badge{font-size:9px;padding:2px 5px;color:#506076;background:#eef2f7}.candidate-controls{display:grid;flex:0 0 52px;gap:4px;width:52px}.candidate-controls .audio-button,.candidate-controls .favorite-button{width:52px;min-width:52px}.candidate-controls .audio-button{height:30px;border-radius:8px}.candidate-ipa{font-size:20px;margin-top:1px}.candidate-meaning{margin:3px 0 0;color:#45536b;font-size:11px;line-height:1.4}.favorite-button{height:27px;padding:0 8px;border:1px solid #ffaaa5;border-radius:8px;background:#fff5f4;color:#d94841;font-size:9px;font-weight:800;white-space:nowrap;cursor:pointer}.favorite-button:hover{background:#ffe7e5}.favorite-button.saved{border-color:#b8decf;background:#e9f8f2;color:#087f5b}.favorite-button:disabled{cursor:default;opacity:.8}.candidate-favorite{padding:0 3px}
      @media(max-width:600px){.panel{width:calc(100vw - 16px);min-width:calc(100vw - 16px)}.body{padding:10px}.word{font-size:24px}.target-ipa{font-size:24px}}
    `;
  }
})();
