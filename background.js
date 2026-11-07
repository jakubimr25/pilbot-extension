/**
 * Background service worker: answers questions with the AI provider the user
 * set up (ai.js; the provider and its encrypted API key are handled by
 * provider.js, and the key never leaves this worker except toward that
 * provider). There is no Pilbot server and no sign-in: every page feature
 * (Ask, Summary and Voice) needs a provider; without one, nothing is sent.
 *
 * - The content script sends selected text to answer (ANSWER_SELECTION).
 *   This worker checks the Ask switch, filters the text, rate-limits and asks
 *   the provider.
 * - Every question carries the side panel's Knowledge text (the reference
 *   text) while its switch is on. It is read from storage here, never taken
 *   from a message.
 * - Every question, summary and dictation uses the language set in settings
 *   ('' when none is set). It is read from storage here too and checked
 *   against the fixed list, never taken from a message.
 * - The content script sends a page's readable text to summarize
 *   (SUMMARIZE_PAGE). This worker checks the Summary switch, cleans and
 *   shortens the text and asks the model, without the Knowledge text.
 * - The content script starts and stops dictation (DICTATION_*). This worker
 *   checks the Voice switch and the provider, runs the recorder (an offscreen
 *   document) for the tab, sends its audio to the provider and returns the
 *   text.
 * - The side panel checks, saves or removes the provider (PROVIDER_*);
 *   provider.js checks it with the provider, encrypts the key and stores it.
 *
 * It also opens the side panel from the toolbar icon.
 */

import { PROVIDER_REQUIRED, askAi, checkVoiceReady, summarizeAi, transcribeAi } from './ai.js';
import {
  ASK_COMMAND,
  LEGACY_STORAGE_KEYS,
  MAX_PAGE_TEXT_LENGTH,
  MAX_PAGE_TITLE_LENGTH,
  MAX_SELECTION_LENGTH,
  MESSAGE_TYPES,
  MICROPHONE_PAGE_PATH,
  MIN_PAGE_TEXT_LENGTH,
  RECORDER_MESSAGE_TYPES,
  RECORDER_PATH,
  RECORDING_MIME_TYPE,
  STORAGE_KEYS,
  getLanguage,
  getReferenceText,
  isAnswerableText,
  isReferenceEnabled,
  normalizeReferenceText,
  normalizeSelection,
  trimPageText,
} from './constants.js';
import { checkProvider, readProviderSettings, removeProvider, saveProvider } from './provider.js';

/** @typedef {import('./constants.js').AnswerResult} AnswerResult */
/** @typedef {import('./constants.js').DictationResult} DictationResult */

/**
 * Per minute. There is no server-side limit any more: these keep a runaway
 * page or key repeat from spending the user's quota at their provider.
 */
const RATE_LIMIT_MAX_REQUESTS = 10;
const RATE_LIMIT_MAX_DICTATIONS = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const SIDE_PANEL_URL = chrome.runtime.getURL('sidepanel.html');
const RECORDER_URL = chrome.runtime.getURL(RECORDER_PATH);
const MICROPHONE_PAGE_URL = chrome.runtime.getURL(MICROPHONE_PAGE_PATH);
/**
 * Largest audio accepted from the recorder, as base64 text: at most
 * 1,000,000 bytes, far under the providers' upload limits (OpenAI and Groq
 * take 25 MB). Two minutes at the recorder's 32 kbit/s are about 0.5 MB; this
 * leaves room if Chrome records at a higher rate.
 */
const MAX_AUDIO_BASE64_LENGTH = Math.ceil(1_000_000 / 3) * 4;
/** Badge while the microphone is on: a sign no page can hide. */
const RECORDING_BADGE = Object.freeze({ text: 'rec', color: '#ba1a1a' });

/** @type {Map<number, AbortController>} In-flight request per tab. */
const inFlightByTab = new Map();

/** @type {Map<number, AbortController>} In-flight summary per tab. */
const summaryInFlightByTab = new Map();

/** Tail of the queue that runs recorder steps (start, stop, cancel) one at a time. */
let recorderQueue = Promise.resolve();

/** @type {{ kind: 'ignored' }} */
const IGNORED = Object.freeze({ kind: 'ignored' });

/**
 * Restricts chrome.storage.local (the provider, its encrypted API key, the
 * Knowledge text, the language and what earlier versions saved there) to the
 * side panel and this worker, so content scripts can never read it.
 */
function lockKeyStorage() {
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
}

/**
 * Deletes settings from earlier versions (the Pilbot Worker's sign-in
 * session, the Later questions, old plain-text API keys and endpoint fields),
 * so nothing stale lingers on disk.
 */
async function removeLegacySettings() {
  await Promise.all([
    chrome.storage.local.remove([...LEGACY_STORAGE_KEYS.local]),
    chrome.storage.sync.remove([...LEGACY_STORAGE_KEYS.sync]),
  ]);
}

/**
 * @param {string} key
 * @param {boolean} fallback
 * @returns {Promise<boolean>}
 */
async function readSyncFlag(key, fallback) {
  const stored = await chrome.storage.sync.get(key);
  return typeof stored[key] === 'boolean' ? stored[key] : fallback;
}

/** @returns {Promise<boolean>} Whether the extension is switched on (default: on). */
function isEnabled() {
  return readSyncFlag(STORAGE_KEYS.ENABLED, true);
}

/** @returns {Promise<boolean>} Whether the extension and its Ask switch (default: on) are on. */
async function isAskOn() {
  return (await isEnabled()) && (await readSyncFlag(STORAGE_KEYS.ASK_ENABLED, true));
}

/** @returns {Promise<boolean>} Whether the extension and its Voice switch (default: off) are on. */
async function isDictationOn() {
  return (await isEnabled()) && (await readSyncFlag(STORAGE_KEYS.DICTATION_ENABLED, false));
}

/** @returns {Promise<boolean>} Whether the extension and its Summary switch (default: on) are on. */
async function isSummaryOn() {
  return (await isEnabled()) && (await readSyncFlag(STORAGE_KEYS.SUMMARY_ENABLED, true));
}

/**
 * Shows an "off" badge on the toolbar icon while the extension is paused.
 */
async function updateBadge() {
  const enabled = await isEnabled();
  await chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
  await chrome.action.setBadgeText({ text: enabled ? '' : 'off' });
}

/**
 * @returns {Promise<string>} The Knowledge text to send with a question, or ''
 *   when there is none or its switch is off. Checked again here (normalized,
 *   within the limit), whatever is in storage.
 */
async function readReferenceText() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.REFERENCE_TEXT, STORAGE_KEYS.REFERENCE_ENABLED]);
  return isReferenceEnabled(stored) ? getReferenceText(stored) : '';
}

/**
 * @returns {Promise<string>} The code of the language set in settings, or ''
 *   when none is set. Checked against the fixed list (LANGUAGES), whatever is
 *   in storage.
 */
async function readLanguage() {
  return getLanguage(await chrome.storage.local.get(STORAGE_KEYS.LANGUAGE));
}

/**
 * @returns {Promise<boolean>} Whether a provider is set up. Page features are
 *   refused before anything is counted or sent otherwise; whether its key
 *   still unlocks is checked with each request.
 */
async function hasProvider() {
  return (await readProviderSettings()) !== null;
}

/**
 * Sliding-window limiter, so nothing can flood the provider (and the user's
 * quota there) or storage.
 * @param {number} max Most events per window.
 * @returns {() => boolean} Records an event; false when the window is full.
 */
function createRateLimiter(max) {
  /** @type {number[]} Timestamps of recent events. */
  const recent = [];
  return () => {
    const now = Date.now();
    while (recent.length > 0 && now - recent[0] > RATE_LIMIT_WINDOW_MS) {
      recent.shift();
    }
    if (recent.length >= max) {
      return false;
    }
    recent.push(now);
    return true;
  };
}

/** Shared by questions and summaries. */
const tryConsumeRateLimit = createRateLimiter(RATE_LIMIT_MAX_REQUESTS);
const tryConsumeDictationLimit = createRateLimiter(RATE_LIMIT_MAX_DICTATIONS);

/**
 * Accepts messages only from this extension's content script running in the
 * top frame of a regular http(s) tab.
 * @param {chrome.runtime.MessageSender} sender
 * @returns {sender is chrome.runtime.MessageSender & { tab: chrome.tabs.Tab & { id: number }, url: string }}
 */
function isTrustedContentScript(sender) {
  if (
    sender.id !== chrome.runtime.id ||
    sender.frameId !== 0 ||
    typeof sender.tab?.id !== 'number' ||
    typeof sender.url !== 'string'
  ) {
    return false;
  }
  try {
    const { protocol } = new URL(sender.url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Accepts messages from this extension's side panel page only. Content
 * scripts and web pages can never save or remove the provider.
 * @param {chrome.runtime.MessageSender} sender
 * @returns {boolean}
 */
function isSidePanel(sender) {
  return (
    sender.id === chrome.runtime.id &&
    sender.tab === undefined &&
    typeof sender.url === 'string' &&
    sender.url.split(/[?#]/)[0] === SIDE_PANEL_URL
  );
}

/**
 * Accepts messages from this extension's recorder (offscreen document) only.
 * @param {chrome.runtime.MessageSender} sender
 * @returns {boolean}
 */
function isRecorder(sender) {
  return sender.id === chrome.runtime.id && sender.tab === undefined && sender.url === RECORDER_URL;
}

/**
 * @param {unknown} message
 * @returns {message is { type: string, text?: unknown, title?: unknown, provider?: unknown }}
 */
function isMessage(message) {
  return (
    typeof message === 'object' &&
    message !== null &&
    typeof (/** @type {{ type?: unknown }} */ (message).type) === 'string'
  );
}

/**
 * Normalizes and filters text from a page.
 * @param {unknown} rawText
 * @returns {string | null} The text, or null when it may not be used.
 */
function readSelectedText(rawText) {
  if (typeof rawText !== 'string' || rawText.length > MAX_SELECTION_LENGTH * 2) {
    return null;
  }
  const text = normalizeSelection(rawText);
  return isAnswerableText(text) ? text : null;
}

/**
 * Validates the selected text and asks the model for a brief answer.
 * A newer request from the same tab cancels the older one. With the Ask
 * switch off, nothing is sent, whatever the page script still shows.
 * @param {unknown} rawText
 * @param {number} tabId
 * @returns {Promise<AnswerResult>}
 */
async function handleAnswerSelection(rawText, tabId) {
  const text = readSelectedText(rawText);
  if (text === null || !(await isAskOn())) {
    return IGNORED;
  }
  if (!(await hasProvider())) {
    return PROVIDER_REQUIRED;
  }
  if (!tryConsumeRateLimit()) {
    return { kind: 'error', message: 'Too many requests. Try again in a minute.' };
  }

  // Read before the request is registered, so a newer one can still cancel it.
  const referenceText = await readReferenceText();
  const language = await readLanguage();
  inFlightByTab.get(tabId)?.abort();
  const controller = new AbortController();
  inFlightByTab.set(tabId, controller);
  try {
    return await askAi(text, referenceText, language, controller.signal);
  } finally {
    if (inFlightByTab.get(tabId) === controller) {
      inFlightByTab.delete(tabId);
    }
  }
}

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------

/**
 * Summarizes a page's readable text, cleaned again and shortened to
 * MAX_PAGE_TEXT_LENGTH. A newer summary from the same tab cancels the older
 * one.
 * @param {unknown} rawTitle
 * @param {unknown} rawText
 * @param {number} tabId
 * @returns {Promise<AnswerResult>}
 */
async function handleSummarizePage(rawTitle, rawText, tabId) {
  if (
    typeof rawTitle !== 'string' ||
    typeof rawText !== 'string' ||
    rawTitle.length > MAX_PAGE_TITLE_LENGTH * 2 ||
    rawText.length > MAX_PAGE_TEXT_LENGTH * 2 ||
    !(await isSummaryOn())
  ) {
    return IGNORED;
  }
  const text = trimPageText(normalizeReferenceText(rawText).replace(/[ \t]+/g, ' '), MAX_PAGE_TEXT_LENGTH);
  if (text.length < MIN_PAGE_TEXT_LENGTH) {
    return { kind: 'error', message: 'There is not enough text on this page to summarize.' };
  }
  if (!(await hasProvider())) {
    return PROVIDER_REQUIRED;
  }
  if (!tryConsumeRateLimit()) {
    return { kind: 'error', message: 'Too many requests. Try again in a minute.' };
  }

  // Read before the request is registered, so a newer one can still cancel it.
  const language = await readLanguage();
  summaryInFlightByTab.get(tabId)?.abort();
  const controller = new AbortController();
  summaryInFlightByTab.set(tabId, controller);
  try {
    const title = normalizeSelection(rawTitle).slice(0, MAX_PAGE_TITLE_LENGTH).toWellFormed();
    return await summarizeAi(title, text, language, controller.signal);
  } finally {
    if (summaryInFlightByTab.get(tabId) === controller) {
      summaryInFlightByTab.delete(tabId);
    }
  }
}

// -----------------------------------------------------------------------------
// Dictation
// -----------------------------------------------------------------------------

/** Messages for the reasons the recorder gives when it cannot record. */
const RECORDER_ERRORS = Object.freeze({
  permission: 'Dictation needs the microphone. Allow it in the tab that just opened, then try again.',
  'no-microphone': 'No microphone found. Connect one and try again.',
  'too-short': 'That was too short. Click the microphone, speak, then click it again.',
  failed: 'Could not use the microphone. Try again.',
});

/**
 * @param {Record<string, unknown> | null} response From the recorder.
 * @returns {DictationResult}
 */
function describeRecorderError(response) {
  const reason = response?.reason;
  const known = typeof reason === 'string' && Object.hasOwn(RECORDER_ERRORS, reason);
  return { kind: 'error', message: RECORDER_ERRORS[known ? reason : 'failed'] };
}

/**
 * Runs a recorder step after the ones before it, so starts, stops and
 * cancels from any tab never overlap.
 * @template T
 * @param {() => Promise<T>} step
 * @returns {Promise<T>}
 */
function runRecorderStep(step) {
  const run = recorderQueue.then(step);
  recorderQueue = run.catch(() => {});
  return run;
}

/**
 * Sends a message to the recorder, which accepts messages from this worker only.
 * @param {string} type One of RECORDER_MESSAGE_TYPES.
 * @param {number} tabId The tab dictating.
 * @returns {Promise<Record<string, unknown> | null>} null when it did not answer.
 */
async function sendToRecorder(type, tabId) {
  try {
    const response = await chrome.runtime.sendMessage({ type, tabId });
    return typeof response === 'object' && response !== null ? response : null;
  } catch {
    return null;
  }
}

/** Closes the recorder, which also turns the microphone off for sure. */
async function closeRecorder() {
  if (await chrome.offscreen.hasDocument()) {
    await chrome.offscreen.closeDocument();
  }
  await updateBadge();
}

/**
 * Turns the base64 audio from the recorder back into a file, after checking
 * its type and size.
 * @param {Record<string, unknown>} response
 * @returns {Blob | null}
 */
function readRecordedAudio(response) {
  const { data, mimeType } = response;
  if (
    typeof data !== 'string' ||
    data.length === 0 ||
    data.length > MAX_AUDIO_BASE64_LENGTH ||
    mimeType !== RECORDING_MIME_TYPE
  ) {
    return null;
  }
  try {
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
    return new Blob([bytes], { type: RECORDING_MIME_TYPE });
  } catch {
    return null;
  }
}

/**
 * Starts recording for a tab. Without the microphone permission, opens the
 * page that asks for it. Without a provider that can turn speech into text,
 * the microphone is never turned on: the recording could not be sent. The
 * whole start, checks included, is one recorder step queued on arrival, so a
 * cancel sent right after it (Esc) can never overtake it and leave the
 * microphone on.
 * @param {number} tabId
 * @returns {Promise<DictationResult>}
 */
function handleDictationStart(tabId) {
  return runRecorderStep(async () => {
    if (!(await isDictationOn())) {
      return IGNORED;
    }
    const notReady = await checkVoiceReady();
    if (notReady !== null) {
      return notReady;
    }
    if (!tryConsumeDictationLimit()) {
      return { kind: 'error', message: 'Too many dictations. Try again in a minute.' };
    }

    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({
        url: RECORDER_PATH,
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification: 'Records the microphone while you dictate into a text field.',
      });
    }
    const response = await sendToRecorder(RECORDER_MESSAGE_TYPES.START, tabId);
    if (response?.kind === 'recording') {
      await chrome.action.setBadgeBackgroundColor({ color: RECORDING_BADGE.color });
      await chrome.action.setBadgeText({ text: RECORDING_BADGE.text });
      return { kind: 'recording' };
    }
    await closeRecorder();
    if (response?.reason === 'permission') {
      chrome.tabs.create({ url: MICROPHONE_PAGE_URL }).catch(() => {});
    }
    return describeRecorderError(response);
  });
}

/**
 * Stops a tab's recording and turns the audio into text.
 * @param {number} tabId
 * @returns {Promise<DictationResult>}
 */
async function handleDictationStop(tabId) {
  const response = await runRecorderStep(async () => {
    if (!(await chrome.offscreen.hasDocument())) {
      return null;
    }
    const result = await sendToRecorder(RECORDER_MESSAGE_TYPES.STOP, tabId);
    // "ignored": the recorder belongs to another tab now, which keeps it.
    if (result?.kind !== 'ignored') {
      await closeRecorder();
    }
    return result;
  });

  if (response?.kind === 'error') {
    return describeRecorderError(response);
  }
  const audio = response?.kind === 'audio' ? readRecordedAudio(response) : null;
  if (audio === null) {
    return { kind: 'error', message: 'The recording was lost. Try again.' };
  }
  // Switched off while recording: the audio is dropped, not sent. Provider
  // removed meanwhile: transcribeAi() drops it too.
  if (!(await isDictationOn())) {
    return IGNORED;
  }
  return transcribeAi(audio, await readLanguage(), new AbortController().signal);
}

/**
 * Drops a tab's recording, if it has one.
 * @param {number} tabId
 * @returns {Promise<DictationResult>}
 */
async function handleDictationCancel(tabId) {
  await runRecorderStep(async () => {
    if (!(await chrome.offscreen.hasDocument())) {
      return;
    }
    const result = await sendToRecorder(RECORDER_MESSAGE_TYPES.CANCEL, tabId);
    if (result?.kind !== 'ignored') {
      await closeRecorder();
    }
  });
  return { kind: 'cancelled' };
}

/** Turns the microphone off when the extension or its Voice switch goes off. */
async function closeRecorderUnlessOn() {
  if (!(await isDictationOn())) {
    await runRecorderStep(closeRecorder);
  }
}

// -----------------------------------------------------------------------------
// Messages and events
// -----------------------------------------------------------------------------

/**
 * Picks the handler for a message; each type is accepted from one sender only.
 * @param {{ type: string, text?: unknown, title?: unknown, provider?: unknown }} message
 * @param {chrome.runtime.MessageSender} sender
 * @returns {Promise<object> | null} null for messages that are not handled.
 */
function routeMessage(message, sender) {
  if (isTrustedContentScript(sender)) {
    if (message.type === MESSAGE_TYPES.ANSWER_SELECTION) {
      return handleAnswerSelection(message.text, sender.tab.id);
    }
    if (message.type === MESSAGE_TYPES.SUMMARIZE_PAGE) {
      return handleSummarizePage(message.title, message.text, sender.tab.id);
    }
    if (message.type === MESSAGE_TYPES.DICTATION_START) {
      return handleDictationStart(sender.tab.id);
    }
    if (message.type === MESSAGE_TYPES.DICTATION_STOP) {
      return handleDictationStop(sender.tab.id);
    }
    if (message.type === MESSAGE_TYPES.DICTATION_CANCEL) {
      return handleDictationCancel(sender.tab.id);
    }
  } else if (isSidePanel(sender)) {
    if (message.type === MESSAGE_TYPES.PROVIDER_CHECK) {
      return checkProvider(message.provider);
    }
    if (message.type === MESSAGE_TYPES.PROVIDER_SAVE) {
      return saveProvider(message.provider);
    }
    if (message.type === MESSAGE_TYPES.PROVIDER_REMOVE) {
      return removeProvider();
    }
  } else if (isRecorder(sender)) {
    if (message.type === RECORDER_MESSAGE_TYPES.EXPIRED) {
      // It already stopped the microphone; closing it resets the badge.
      return runRecorderStep(closeRecorder).then(() => IGNORED);
    }
  }
  return null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handled = isMessage(message) ? routeMessage(message, sender) : null;
  if (handled === null) {
    return false;
  }
  handled
    .then(sendResponse)
    .catch(() => sendResponse({ kind: 'error', message: 'Unexpected error. Try again.' }));
  // Keep the message channel open for the asynchronous sendResponse.
  return true;
});

// Keyboard shortcut: ask the content script in the active tab to use its
// current selection. Commands are browser-level, so pages cannot trigger them.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === ASK_COMMAND && typeof tab?.id === 'number') {
    chrome.tabs.sendMessage(tab.id, { type: MESSAGE_TYPES.ASK_SELECTION }, { frameId: 0 }).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  inFlightByTab.get(tabId)?.abort();
  inFlightByTab.delete(tabId);
  summaryInFlightByTab.get(tabId)?.abort();
  summaryInFlightByTab.delete(tabId);
  handleDictationCancel(tabId).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && STORAGE_KEYS.ENABLED in changes) {
    void updateBadge();
  }
  if (areaName === 'sync' && (STORAGE_KEYS.ENABLED in changes || STORAGE_KEYS.DICTATION_ENABLED in changes)) {
    closeRecorderUnlessOn().catch(() => {});
  }
});

// Clicking the toolbar icon opens the side panel (there is no popup). Chrome
// shows it on the left or right as set in Settings → Appearance.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

/**
 * Chrome only puts the content script into pages loaded after an install or
 * update, and leaves the old copy running in tabs that were already open.
 * Injecting the current copy there means a reloaded extension works in every
 * tab at once, without refreshing them; it replaces the old copy (see
 * content.js). Discarded tabs get it when they load again.
 */
async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ['https://*/*', 'http://*/*'], discarded: false });
  await Promise.all(
    tabs.map((tab) =>
      typeof tab.id === 'number'
        ? chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {})
        : undefined,
    ),
  );
}

chrome.runtime.onStartup.addListener(() => void updateBadge());
chrome.runtime.onInstalled.addListener(({ reason }) => {
  removeLegacySettings().catch(() => {});
  void updateBadge();
  if (reason === 'install' || reason === 'update') {
    injectIntoOpenTabs().catch(() => {});
  }
});

lockKeyStorage();
