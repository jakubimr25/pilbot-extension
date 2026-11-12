/**
 * Shared constants, types and validators for the side panel, the background
 * service worker and the other extension pages (ES module).
 *
 * content.js cannot import ES modules without exposing files to web pages,
 * so it keeps its own copy of the few values it needs. Keep them in sync.
 */

/**
 * Message types. ANSWER_SELECTION, SUMMARIZE_PAGE and DICTATION_* come from
 * the content script, PROVIDER_* from the side panel; the background worker
 * accepts each only from its own sender.
 */
export const MESSAGE_TYPES = Object.freeze({
  ANSWER_SELECTION: 'ANSWER_SELECTION',
  ASK_SELECTION: 'ASK_SELECTION',
  PING: 'PING',
  SUMMARIZE_PAGE: 'SUMMARIZE_PAGE',
  DICTATION_START: 'DICTATION_START',
  DICTATION_STOP: 'DICTATION_STOP',
  DICTATION_CANCEL: 'DICTATION_CANCEL',
  PROVIDER_CHECK: 'PROVIDER_CHECK',
  PROVIDER_SAVE: 'PROVIDER_SAVE',
  PROVIDER_REMOVE: 'PROVIDER_REMOVE',
});

/**
 * Messages between the background worker and the recorder (the offscreen
 * document). START, STOP and CANCEL go to the recorder, which accepts them
 * from the worker only; EXPIRED goes back when it stopped a recording that
 * ran too long, and the worker accepts it from the recorder only.
 */
export const RECORDER_MESSAGE_TYPES = Object.freeze({
  START: 'RECORDER_START',
  STOP: 'RECORDER_STOP',
  CANCEL: 'RECORDER_CANCEL',
  EXPIRED: 'RECORDER_EXPIRED',
});

/** The offscreen document that records the microphone for dictation. */
export const RECORDER_PATH = 'offscreen.html';

/** The page that asks for the microphone permission (the recorder cannot). */
export const MICROPHONE_PAGE_PATH = 'microphone.html';

/** Keyboard command name declared in manifest.json. */
export const ASK_COMMAND = 'ask-selection';

/**
 * Longest dictation, in milliseconds: the page stops it then (content.js
 * keeps a copy). The recorder has its own, slightly later, safety stop.
 */
export const MAX_DICTATION_MS = 120_000;

/** Audio format of dictations (Opus in WebM), as recorded and as sent to the AI provider. */
export const RECORDING_MIME_TYPE = 'audio/webm';

/** Longest dictated text put into a page, in characters (content.js keeps a copy). */
export const MAX_TRANSCRIPT_LENGTH = 5000;

/** Longest answer or summary shown, in characters (content.js shows summaries up to this). */
export const MAX_ANSWER_LENGTH = 12_000;

/**
 * Themes, picked in the side panel's settings popup (values in
 * sidepanel.html; content.js keeps a copy). "light" and "dark" force a mode;
 * "system" follows Chrome in the side panel and the page on pages.
 */
export const THEMES = Object.freeze(['light', 'dark', 'system']);

export const DEFAULT_THEME = 'system';

/**
 * Most page text sent for a summary, in characters (content.js keeps a
 * copy). Longer pages are cut in the middle by trimPageText().
 */
export const MAX_PAGE_TEXT_LENGTH = 4000;

/** Pages with less readable text than this are not summarized. */
export const MIN_PAGE_TEXT_LENGTH = 200;

/** Longest page title sent with a summary. */
export const MAX_PAGE_TITLE_LENGTH = 300;

/**
 * A language the AI can answer in, set in the side panel's settings.
 * @typedef {object} Language
 * @property {string} code ISO 639-1, also the lang of its name (sent to speech-to-text as is).
 * @property {string} name In the language itself.
 * @property {string} englishName Also the name used in the prompts.
 */

/**
 * @type {readonly Language[]} The languages in settings, among the most used,
 * most used first (the order of the suggestions). Only the code is stored;
 * the background worker turns it into the prompt's language rule itself
 * (prompts.js), so no text the user typed ever reaches a prompt as an
 * instruction. The side panel stays in English.
 */
export const LANGUAGES = Object.freeze(
  [
    { code: 'en', name: 'English', englishName: 'English' },
    { code: 'zh', name: '中文', englishName: 'Chinese' },
    { code: 'hi', name: 'हिन्दी', englishName: 'Hindi' },
    { code: 'es', name: 'Español', englishName: 'Spanish' },
    { code: 'ar', name: 'العربية', englishName: 'Arabic' },
    { code: 'fr', name: 'Français', englishName: 'French' },
    { code: 'pt', name: 'Português', englishName: 'Portuguese' },
    { code: 'ru', name: 'Русский', englishName: 'Russian' },
    { code: 'id', name: 'Bahasa Indonesia', englishName: 'Indonesian' },
    { code: 'de', name: 'Deutsch', englishName: 'German' },
    { code: 'ja', name: '日本語', englishName: 'Japanese' },
    { code: 'tr', name: 'Türkçe', englishName: 'Turkish' },
    { code: 'ko', name: '한국어', englishName: 'Korean' },
    { code: 'vi', name: 'Tiếng Việt', englishName: 'Vietnamese' },
    { code: 'it', name: 'Italiano', englishName: 'Italian' },
    { code: 'pl', name: 'Polski', englishName: 'Polish' },
    { code: 'uk', name: 'Українська', englishName: 'Ukrainian' },
    { code: 'nl', name: 'Nederlands', englishName: 'Dutch' },
    { code: 'cs', name: 'Čeština', englishName: 'Czech' },
    { code: 'sk', name: 'Slovenčina', englishName: 'Slovak' },
    { code: 'hu', name: 'Magyar', englishName: 'Hungarian' },
  ].map((language) => Object.freeze(language)),
);

/**
 * Storage keys.
 * - REFERENCE_TEXT, REFERENCE_ENABLED, LANGUAGE, PROVIDER, PROVIDER_SECRET and
 *   CHAT_COMPAT live in chrome.storage.local, locked to trusted contexts (side
 *   panel and service worker; never content scripts). They are not synced:
 *   they stay on this device.
 *   - REFERENCE_TEXT and REFERENCE_ENABLED are the side panel's Knowledge text
 *     and its switch; the panel writes them, the service worker sends the text.
 *   - LANGUAGE is the code of the language set in settings (one of LANGUAGES;
 *     absent when none is set); the panel writes it, the service worker uses it.
 *   - PROVIDER is the AI provider (see StoredProvider): endpoint, models and
 *     whether a key is saved, never the key itself. Only the service worker
 *     (provider.js) writes it; the side panel reads it to show the provider.
 *   - PROVIDER_SECRET is the API key, encrypted (see secret-store.js). Only the
 *     service worker writes and reads it.
 *   - CHAT_COMPAT remembers which request format the provider accepted for the
 *     chat model (see openai.js). Only the service worker uses it.
 * - ENABLED, THEME, ASK_ENABLED (the Ask switch, on by default),
 *   DICTATION_ENABLED (the Voice switch, off by default) and SUMMARY_ENABLED
 *   (the Summary switch, on by default) are preferences in
 *   chrome.storage.sync (content.js reads them too). Nothing secret is ever
 *   put in chrome.storage.sync: it is uploaded to the user's Google account.
 */
export const STORAGE_KEYS = Object.freeze({
  ENABLED: 'enabled',
  THEME: 'theme',
  ASK_ENABLED: 'askEnabled',
  DICTATION_ENABLED: 'dictationEnabled',
  SUMMARY_ENABLED: 'summaryEnabled',
  REFERENCE_TEXT: 'referenceText',
  REFERENCE_ENABLED: 'referenceEnabled',
  LANGUAGE: 'language',
  PROVIDER: 'provider',
  PROVIDER_SECRET: 'providerSecret',
  CHAT_COMPAT: 'chatCompat',
});

/**
 * Settings written by earlier versions, deleted on update: the Google sign-in
 * session of the Pilbot Worker (v8–v9; there is no server any more), the
 * questions saved with the Later button (up to v9.0), the random placeholder
 * account name (v7), the summary length (test builds of v7.8), the Pro / Lite
 * model choice (v7.6), the color palette (v7.4), the Hugging Face token and
 * model (v5), the Mistral key and web search switch (v4) and the configurable
 * endpoint fields of v3.3, which held the API key in plain text. None of them
 * is ever read.
 */
export const LEGACY_STORAGE_KEYS = Object.freeze({
  local: Object.freeze([
    'authSession',
    'laterItems',
    'profileName',
    'hfToken',
    'apiKey',
    'apiKeyOrigin',
    'endpoint',
    'model',
  ]),
  sync: Object.freeze(['groqModel', 'hfModel', 'webSearch', 'palette', 'summaryLevel']),
});

// -----------------------------------------------------------------------------
// AI provider
// -----------------------------------------------------------------------------

/**
 * An OpenAI-compatible provider the side panel can fill in with one click.
 * Every value can still be changed; only the endpoint decides where requests
 * and the API key go.
 * @typedef {object} ProviderPreset
 * @property {string} id
 * @property {string} name
 * @property {string} description One short line for the provider list (Voice support is added there).
 * @property {string} baseUrl The OpenAI-compatible base URL ('' for Custom): requests go to
 *   `${baseUrl}/chat/completions`, `${baseUrl}/audio/transcriptions` and `${baseUrl}/models`.
 * @property {string} chatModel Suggested model for answers and summaries ('' when it depends on the setup).
 *   The setup fills it in for the default provider (Groq) only; for the others the user types it.
 * @property {string} transcriptionModel Suggested speech-to-text model ('' when the provider has
 *   no OpenAI-compatible speech-to-text: Voice is then off, and the setup says so). Filled in for
 *   Groq only, like chatModel; for the others it only tells whether Voice can work.
 * @property {string} keysUrl Where to create an API key ('' for none). A fixed address, never one
 *   typed by the user, so the side panel can link to it.
 * @property {boolean} local Runs on this computer: no API key needed.
 */

/** @type {readonly ProviderPreset[]} Groq first: it is the default. Custom last. */
export const PROVIDER_PRESETS = Object.freeze(
  [
    {
      id: 'groq',
      name: 'Groq',
      description: 'Very fast answers',
      baseUrl: 'https://api.groq.com/openai/v1',
      chatModel: 'openai/gpt-oss-120b',
      transcriptionModel: 'whisper-large-v3-turbo',
      keysUrl: 'https://console.groq.com/keys',
      local: false,
    },
    {
      id: 'openai',
      name: 'OpenAI',
      description: 'GPT models',
      baseUrl: 'https://api.openai.com/v1',
      chatModel: 'gpt-4.1-mini',
      transcriptionModel: 'gpt-4o-mini-transcribe',
      keysUrl: 'https://platform.openai.com/api-keys',
      local: false,
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      description: 'Hundreds of models with one key',
      baseUrl: 'https://openrouter.ai/api/v1',
      chatModel: 'openai/gpt-oss-120b',
      transcriptionModel: '',
      keysUrl: 'https://openrouter.ai/keys',
      local: false,
    },
    {
      id: 'gemini',
      name: 'Google Gemini',
      description: 'Gemini models from Google AI Studio',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      chatModel: 'gemini-2.5-flash',
      transcriptionModel: '',
      keysUrl: 'https://aistudio.google.com/apikey',
      local: false,
    },
    {
      id: 'mistral',
      name: 'Mistral',
      description: 'Mistral models',
      baseUrl: 'https://api.mistral.ai/v1',
      chatModel: 'mistral-small-latest',
      transcriptionModel: 'voxtral-mini-latest',
      keysUrl: 'https://console.mistral.ai/api-keys',
      local: false,
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      description: 'DeepSeek chat models',
      baseUrl: 'https://api.deepseek.com/v1',
      chatModel: 'deepseek-chat',
      transcriptionModel: '',
      keysUrl: 'https://platform.deepseek.com/api_keys',
      local: false,
    },
    {
      id: 'ollama',
      name: 'Ollama',
      description: 'Models on this computer, no key needed',
      baseUrl: 'http://localhost:11434/v1',
      chatModel: 'llama3.2',
      transcriptionModel: '',
      keysUrl: '',
      local: true,
    },
    {
      id: 'lmstudio',
      name: 'LM Studio',
      description: 'Models on this computer, no key needed',
      baseUrl: 'http://localhost:1234/v1',
      chatModel: '',
      transcriptionModel: '',
      keysUrl: '',
      local: true,
    },
    {
      id: 'custom',
      name: 'Custom',
      description: 'Any OpenAI-compatible endpoint',
      baseUrl: '',
      chatModel: '',
      transcriptionModel: '',
      keysUrl: '',
      local: false,
    },
  ].map((preset) => Object.freeze(preset)),
);

export const DEFAULT_PRESET_ID = 'groq';

/** @returns {ProviderPreset} */
export function getDefaultPreset() {
  return /** @type {ProviderPreset} */ (PROVIDER_PRESETS.find((preset) => preset.id === DEFAULT_PRESET_ID));
}

/** @returns {ProviderPreset} */
function getCustomPreset() {
  return /** @type {ProviderPreset} */ (PROVIDER_PRESETS.find((preset) => preset.id === 'custom'));
}

/**
 * @param {string} id
 * @returns {ProviderPreset | undefined}
 */
export function findPresetById(id) {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

/**
 * The preset an endpoint belongs to: the one with exactly this base URL, else
 * Custom. Derived from the endpoint every time, so the name shown always
 * matches where requests go.
 * @param {string} baseUrl A normalized base URL (checkEndpoint()).
 * @returns {ProviderPreset}
 */
export function findPresetByBaseUrl(baseUrl) {
  return PROVIDER_PRESETS.find((preset) => preset.baseUrl !== '' && preset.baseUrl === baseUrl) ?? getCustomPreset();
}

/**
 * Hosts that are this computer. Plain http and a missing API key are allowed
 * only for them, and only these two are in connect-src of the CSP
 * (manifest.json). Anything else must be https, so the key never crosses a
 * network in plain text.
 */
const LOOPBACK_HOSTS = Object.freeze(['localhost', '127.0.0.1']);

export const MAX_ENDPOINT_LENGTH = 2048;
export const MAX_API_KEY_LENGTH = 1024;
export const MAX_MODEL_LENGTH = 200;
/** Characters 0x21–0x7E: no spaces, line breaks or anything else that could break an HTTP header. */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

/**
 * @typedef {{ ok: true, baseUrl: string, origin: string, local: boolean }
 *   | { ok: false, message: string }} EndpointCheck
 */

/**
 * Checks and normalizes an endpoint (an OpenAI-compatible base URL): https
 * (http only on this computer), no user name or password, no query or
 * fragment; trailing slashes are dropped.
 * @param {unknown} raw
 * @returns {EndpointCheck}
 */
export function checkEndpoint(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') {
    return { ok: false, message: 'Enter the endpoint of your AI provider.' };
  }
  if (text.length > MAX_ENDPOINT_LENGTH) {
    return { ok: false, message: 'The endpoint is too long.' };
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, message: 'Enter the endpoint as a full address, e.g. https://api.groq.com/openai/v1.' };
  }
  const local = LOOPBACK_HOSTS.includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    return { ok: false, message: 'The endpoint must start with https:// (plain http:// only for localhost).' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, message: 'Leave the user name and password out of the endpoint; put the key in the API key field.' };
  }
  if (url.search !== '' || url.hash !== '' || text.includes('?') || text.includes('#')) {
    return { ok: false, message: 'The endpoint cannot contain ? or #.' };
  }
  return { ok: true, baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, origin: url.origin, local };
}

/**
 * @param {string} key Already trimmed.
 * @returns {boolean} Whether it can be an API key: 1–1024 printable ASCII characters.
 */
export function isValidApiKey(key) {
  return key.length <= MAX_API_KEY_LENGTH && PRINTABLE_ASCII.test(key);
}

/**
 * @param {string} model Already trimmed.
 * @returns {boolean} Whether it can be a model ID: 1–200 printable ASCII characters
 *   (IDs such as "openai/gpt-oss-120b" or "llama3.2:latest").
 */
export function isValidModel(model) {
  return model.length <= MAX_MODEL_LENGTH && PRINTABLE_ASCII.test(model);
}

/** How long Pilbot waits for an answer or a summary, in whole seconds, unless the setup sets another time. */
export const DEFAULT_ANSWER_TIMEOUT_SECONDS = 45;
export const MIN_ANSWER_TIMEOUT_SECONDS = 10;
/** Well under the 5 minutes Chrome gives the background worker for one message. */
export const MAX_ANSWER_TIMEOUT_SECONDS = 240;

/**
 * @param {unknown} value
 * @returns {value is number} Whether it is a time to wait for answers: whole seconds, 10–240.
 */
export function isValidAnswerTimeout(value) {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_ANSWER_TIMEOUT_SECONDS &&
    value <= MAX_ANSWER_TIMEOUT_SECONDS
  );
}

/**
 * The provider as stored under STORAGE_KEYS.PROVIDER. Nothing in it is secret.
 * @typedef {object} StoredProvider
 * @property {1} v
 * @property {string} baseUrl Normalized (checkEndpoint()).
 * @property {string} chatModel
 * @property {string} transcriptionModel '' when Voice has no model.
 * @property {boolean} hasKey Whether an encrypted API key is stored (PROVIDER_SECRET).
 * @property {string} keyHint The key's last 4 characters, to recognize it ('' for short keys or none).
 * @property {number} timeoutSeconds How long to wait for an answer or a summary (isValidAnswerTimeout()).
 *   Providers saved before it existed have none: they are read with the default.
 */

/**
 * The provider as read, with what follows from its endpoint.
 * @typedef {StoredProvider & { origin: string, local: boolean, preset: ProviderPreset }} ProviderSettings
 */

const KEY_HINT_PATTERN = /^[\x21-\x7e]{0,4}$/;

/**
 * Checks the stored provider and returns it with its origin and preset, or
 * null when there is none or it is malformed.
 * @param {unknown} value
 * @returns {ProviderSettings | null}
 */
export function parseProviderSettings(value) {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { v, baseUrl, chatModel, transcriptionModel, hasKey, keyHint, timeoutSeconds } =
    /** @type {Record<string, unknown>} */ (value);
  const endpoint = checkEndpoint(baseUrl);
  if (
    v !== 1 ||
    !endpoint.ok ||
    endpoint.baseUrl !== baseUrl ||
    typeof chatModel !== 'string' ||
    !isValidModel(chatModel) ||
    typeof transcriptionModel !== 'string' ||
    (transcriptionModel !== '' && !isValidModel(transcriptionModel)) ||
    typeof hasKey !== 'boolean' ||
    typeof keyHint !== 'string' ||
    !KEY_HINT_PATTERN.test(keyHint) ||
    (!hasKey && !endpoint.local)
  ) {
    return null;
  }
  return {
    v: 1,
    baseUrl: endpoint.baseUrl,
    chatModel,
    transcriptionModel,
    hasKey,
    keyHint: hasKey ? keyHint : '',
    timeoutSeconds: isValidAnswerTimeout(timeoutSeconds) ? timeoutSeconds : DEFAULT_ANSWER_TIMEOUT_SECONDS,
    origin: endpoint.origin,
    local: endpoint.local,
    preset: findPresetByBaseUrl(endpoint.baseUrl),
  };
}

/**
 * Result of PROVIDER_CHECK, PROVIDER_SAVE and PROVIDER_REMOVE, returned to the
 * side panel. "checked": the endpoint and key work; `models` are the model IDs
 * the provider lists (null when it lists none in OpenAI's shape). `notice` is
 * something worth knowing about a saved provider ('' for nothing). An error's
 * `field` is the form field it is about, when there is one.
 * @typedef {{ kind: 'checked', models: string[] | null }
 *   | { kind: 'saved', notice: string }
 *   | { kind: 'removed' }
 *   | { kind: 'error', message: string, field?: 'endpoint' | 'key' | 'timeout' | 'chatModel' | 'transcriptionModel' }} ProviderResult
 */

// -----------------------------------------------------------------------------
// Text
// -----------------------------------------------------------------------------

/** Selected text shorter or longer than this is ignored. */
export const MIN_SELECTION_LENGTH = 3;
export const MAX_SELECTION_LENGTH = 2000;

/**
 * Longest reference (Knowledge) text, in characters. It is sent with every
 * question, so it counts against the provider's token limits each time.
 */
export const MAX_REFERENCE_LENGTH = 5000;

/** C0 control characters except tab and line breaks, plus DEL and the C1 controls. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * Characters the user cannot see but the model reads: Unicode tag characters
 * (used to hide instructions in copied text) and bidirectional overrides.
 */
const INVISIBLE_CHARS = /[\u{E0000}-\u{E007F}‪-‮⁦-⁩]/gu;

/** @typedef {{ kind: 'error', message: string }} ErrorResult */

/**
 * Result of a question, returned to the content script or the side panel.
 * @typedef {{ kind: 'answer', text: string }
 *   | ErrorResult
 *   | { kind: 'ignored' }} AnswerResult
 */

/**
 * Result of a dictation step, returned to the content script.
 * @typedef {{ kind: 'recording' }
 *   | { kind: 'transcript', text: string }
 *   | { kind: 'cancelled' }
 *   | ErrorResult
 *   | { kind: 'ignored' }} DictationResult
 */

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isSupportedTheme(value) {
  return typeof value === 'string' && THEMES.includes(value);
}

/**
 * Returns the chosen theme, or DEFAULT_THEME when none (or an unknown one) is stored.
 * @param {Record<string, unknown>} stored Result of chrome.storage.sync.get().
 * @returns {string}
 */
export function getTheme(stored) {
  const theme = stored[STORAGE_KEYS.THEME];
  return isSupportedTheme(theme) ? theme : DEFAULT_THEME;
}

/**
 * Shortens page text to at most `max` characters by keeping its start (70%)
 * and its end (the rest), so both the introduction and the conclusion reach
 * the model. Cuts at line breaks where it can (content.js keeps a copy).
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function trimPageText(text, max) {
  if (text.length <= max) {
    return text;
  }
  const headLength = Math.floor(max * 0.7);
  const head = text.slice(0, headLength);
  const tail = text.slice(text.length - (max - headLength - 3));
  const headEnd = head.lastIndexOf('\n');
  return `${headEnd > 0 ? head.slice(0, headEnd) : head}\n…\n${tail.slice(tail.indexOf('\n') + 1)}`;
}

/**
 * Removes control and invisible characters and collapses whitespace. Lone
 * surrogates (half an emoji) become U+FFFD, so the text is valid UTF-8 for
 * the AI provider.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeSelection(raw) {
  return raw
    .toWellFormed()
    .replace(CONTROL_CHARS, '')
    .replace(INVISIBLE_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Removes control and invisible characters and trailing spaces, but keeps
 * line breaks (at most one empty line in a row), so notes keep their layout.
 * Lone surrogates become U+FFFD (see normalizeSelection()). Lines are trimmed
 * one by one instead of with a regex, which stays linear on long runs of
 * spaces.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeReferenceText(raw) {
  return raw
    .toWellFormed()
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(INVISIBLE_CHARS, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Returns the saved reference text, or '' when there is none. The side panel
 * only saves normalized text within the limit; it is checked again here.
 * @param {Record<string, unknown>} stored Result of chrome.storage.local.get().
 * @returns {string}
 */
export function getReferenceText(stored) {
  const value = stored[STORAGE_KEYS.REFERENCE_TEXT];
  return typeof value === 'string' ? normalizeReferenceText(value).slice(0, MAX_REFERENCE_LENGTH) : '';
}

/**
 * Whether the reference text is switched on (default: on). Switching it off
 * keeps the text but stops sending it.
 * @param {Record<string, unknown>} stored Result of chrome.storage.local.get().
 * @returns {boolean}
 */
export function isReferenceEnabled(stored) {
  return stored[STORAGE_KEYS.REFERENCE_ENABLED] !== false;
}

/**
 * @param {unknown} value
 * @returns {value is string} Whether it is exactly the code of one of LANGUAGES.
 */
export function isSupportedLanguage(value) {
  return typeof value === 'string' && LANGUAGES.some((language) => language.code === value);
}

/**
 * Returns the code of the language set in settings, or '' when none is set
 * (or an unknown one is stored): the AI then answers in the language of the
 * text, and dictation detects the language it hears.
 * @param {Record<string, unknown>} stored Result of chrome.storage.local.get().
 * @returns {string}
 */
export function getLanguage(stored) {
  const code = stored[STORAGE_KEYS.LANGUAGE];
  return isSupportedLanguage(code) ? code : '';
}

/**
 * Privacy filter: decides whether selected text may be sent to the AI.
 * Single tokens (URLs, e-mails, passwords, API keys, codes) and mostly
 * numeric text (card numbers, IBANs, phone numbers) are never sent.
 * @param {string} text Normalized text.
 * @returns {boolean}
 */
export function isAnswerableText(text) {
  if (text.length < MIN_SELECTION_LENGTH || text.length > MAX_SELECTION_LENGTH) {
    return false;
  }
  if (!/\s/.test(text)) {
    return false;
  }
  if (!/\p{L}{2}/u.test(text)) {
    return false;
  }
  const digitCount = text.match(/\d/g)?.length ?? 0;
  return digitCount / text.length <= 0.5;
}
