/**
 * The AI provider the user set up: its endpoint, models and API key. Used by
 * the background worker only (a trusted extension context: content scripts
 * and pages never import this). It is the only writer of the provider in
 * storage; the side panel sends what the user typed (PROVIDER_CHECK while
 * setting up, PROVIDER_SAVE at the end) and reads back only what is not
 * secret.
 *
 * Storage (chrome.storage.local, locked to trusted contexts, never synced):
 * - STORAGE_KEYS.PROVIDER: endpoint, models, how long to wait for answers,
 *   whether a key is saved and its last 4 characters (StoredProvider). Not
 *   secret.
 * - STORAGE_KEYS.PROVIDER_SECRET: the API key, encrypted (secret-store.js)
 *   and bound to the endpoint's origin.
 *
 * Checking and saving check everything again (the side panel's checks are
 * only for convenience), then call GET /models with the key: a wrong endpoint
 * or a refused key is reported before anything is stored. A key is only ever
 * sent to the origin it was saved for: an endpoint on another origin needs
 * the key typed again. Every save and removal goes through one queue, so they
 * never interleave.
 */

import {
  DEFAULT_ANSWER_TIMEOUT_SECONDS,
  STORAGE_KEYS,
  checkEndpoint,
  isValidAnswerTimeout,
  isValidApiKey,
  isValidModel,
  MAX_ANSWER_TIMEOUT_SECONDS,
  MAX_API_KEY_LENGTH,
  MAX_ENDPOINT_LENGTH,
  MAX_MODEL_LENGTH,
  MIN_ANSWER_TIMEOUT_SECONDS,
  parseProviderSettings,
} from './constants.js';
import { listModels } from './openai.js';
import { decryptSecret, encryptSecret, forgetEncryptionKey } from './secret-store.js';

/** @typedef {import('./constants.js').EndpointCheck} EndpointCheck */
/** @typedef {import('./constants.js').ProviderSettings} ProviderSettings */
/** @typedef {import('./constants.js').ProviderResult} ProviderResult */
/** @typedef {import('./constants.js').StoredProvider} StoredProvider */
/** @typedef {import('./openai.js').Connection} Connection */
/** @typedef {'endpoint' | 'key' | 'timeout' | 'chatModel' | 'transcriptionModel'} ProviderField */
/** @typedef {{ ok: true, baseUrl: string, origin: string, local: boolean }} ValidEndpoint */

/** How long the check of a new provider may take. */
const CONNECTION_TEST_TIMEOUT_MS = 15_000;
/** Keys shorter than this show no hint: 4 characters would be too much of them. */
const MIN_KEY_LENGTH_FOR_HINT = 16;

/** Tail of the queue that serializes changes to the stored provider. */
let providerQueue = Promise.resolve();

/**
 * Runs a change after the ones before it.
 * @template T
 * @param {() => Promise<T>} change
 * @returns {Promise<T>}
 */
function enqueue(change) {
  const run = providerQueue.then(change);
  providerQueue = run.catch(() => {});
  return run;
}

/**
 * What an encrypted key is bound to: decrypting it for any other origin fails.
 * @param {string} origin
 * @returns {string}
 */
function keyContext(origin) {
  return `pilbot/provider-api-key/v1 ${origin}`;
}

/**
 * @param {string} message
 * @param {ProviderField} [field] The form field the message is about.
 * @returns {ProviderResult}
 */
function error(message, field) {
  return field === undefined ? { kind: 'error', message } : { kind: 'error', message, field };
}

/** @returns {Promise<ProviderSettings | null>} The provider set up, or null when there is none. */
export async function readProviderSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.PROVIDER);
  return parseProviderSettings(stored[STORAGE_KEYS.PROVIDER]);
}

/**
 * The provider with its decrypted key, for one request. The key lives only in
 * this worker's memory for as long as the request needs it.
 * @returns {Promise<{ kind: 'ready', settings: ProviderSettings, connection: Connection }
 *   | { kind: 'missing' }
 *   | { kind: 'locked', settings: ProviderSettings }>} "locked": a key is saved but cannot
 *   be decrypted (its encryption key is gone, or it was tampered with).
 */
export async function getProviderConnection() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.PROVIDER, STORAGE_KEYS.PROVIDER_SECRET]);
  const settings = parseProviderSettings(stored[STORAGE_KEYS.PROVIDER]);
  if (settings === null) {
    return { kind: 'missing' };
  }
  if (!settings.hasKey) {
    return { kind: 'ready', settings, connection: { baseUrl: settings.baseUrl, apiKey: '' } };
  }
  const apiKey = await decryptSecret(stored[STORAGE_KEYS.PROVIDER_SECRET], keyContext(settings.origin));
  if (apiKey === null || !isValidApiKey(apiKey)) {
    return { kind: 'locked', settings };
  }
  return { kind: 'ready', settings, connection: { baseUrl: settings.baseUrl, apiKey } };
}

/**
 * What the side panel sent: exactly these fields, strings within bounds and
 * the timeout a number (checked with the other fields when saving). The
 * models and the timeout are left out of a check (PROVIDER_CHECK): the models
 * are read as '', the timeout as the default.
 * @param {unknown} raw
 * @returns {{ baseUrl: string, apiKey: string, chatModel: string, transcriptionModel: string, timeoutSeconds: number } | null}
 */
function readInput(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const {
    baseUrl,
    apiKey,
    chatModel = '',
    transcriptionModel = '',
    timeoutSeconds = DEFAULT_ANSWER_TIMEOUT_SECONDS,
  } = /** @type {Record<string, unknown>} */ (raw);
  if (
    typeof baseUrl !== 'string' ||
    typeof apiKey !== 'string' ||
    typeof chatModel !== 'string' ||
    typeof transcriptionModel !== 'string' ||
    typeof timeoutSeconds !== 'number' ||
    baseUrl.length > MAX_ENDPOINT_LENGTH * 2 ||
    apiKey.length > MAX_API_KEY_LENGTH * 2 ||
    chatModel.length > MAX_MODEL_LENGTH * 2 ||
    transcriptionModel.length > MAX_MODEL_LENGTH * 2
  ) {
    return null;
  }
  return {
    baseUrl,
    apiKey: apiKey.trim(),
    chatModel: chatModel.trim(),
    transcriptionModel: transcriptionModel.trim(),
    timeoutSeconds,
  };
}

/**
 * The endpoint and the key to use: the key typed, else the saved one when the
 * origin stays the same, else none (allowed only on this computer).
 * @param {string} baseUrl
 * @param {string} typedKey Trimmed.
 * @returns {Promise<{ ok: true, endpoint: ValidEndpoint, apiKey: string } | { ok: false, result: ProviderResult }>}
 */
async function resolveConnection(baseUrl, typedKey) {
  const endpoint = checkEndpoint(baseUrl);
  if (!endpoint.ok) {
    return { ok: false, result: error(endpoint.message, 'endpoint') };
  }
  if (typedKey !== '') {
    return isValidApiKey(typedKey)
      ? { ok: true, endpoint, apiKey: typedKey }
      : { ok: false, result: error('This key has characters an API key cannot have (spaces, line breaks…). Paste it again.', 'key') };
  }
  const current = await getProviderConnection();
  const sameOrigin = current.kind !== 'missing' && current.settings.origin === endpoint.origin;
  if (current.kind === 'ready' && sameOrigin && current.settings.hasKey) {
    return { ok: true, endpoint, apiKey: current.connection.apiKey };
  }
  if (current.kind === 'locked' && sameOrigin) {
    return { ok: false, result: error('Your saved key could not be unlocked. Paste it again.', 'key') };
  }
  if (endpoint.local) {
    return { ok: true, endpoint, apiKey: '' };
  }
  return {
    ok: false,
    result: error(
      current.kind !== 'missing' && current.settings.hasKey && !sameOrigin
        ? 'Paste the API key for this endpoint: a saved key is only ever sent where it was saved for.'
        : 'Enter your API key.',
      'key',
    ),
  };
}

/**
 * @param {string} id
 * @returns {string} A model ID as listed and as typed compare equal: Gemini lists
 *   "models/gemini-2.5-flash", Ollama "llama3.2:latest".
 */
export function normalizeModelId(id) {
  return id.replace(/^models\//, '').replace(/:latest$/, '').toLowerCase();
}

/**
 * Checks the endpoint and the key: GET /models.
 * @param {Connection} connection
 * @param {ValidEndpoint} endpoint
 * @returns {Promise<{ ok: true, models: string[] | null, notice: string } | { ok: false, result: ProviderResult }>}
 *   `notice` when the endpoint answers but could not confirm the key right now.
 */
async function testConnection(connection, endpoint) {
  const result = await listModels(connection, CONNECTION_TEST_TIMEOUT_MS);
  if (result.ok) {
    return { ok: true, models: result.value === null || result.value.length === 0 ? null : result.value, notice: '' };
  }
  // The endpoint field is shown only for Custom and local servers; the key field always.
  const { failure } = result;
  switch (failure.kind) {
    case 'timeout':
      return { ok: false, result: error(`${endpoint.origin} did not answer within ${CONNECTION_TEST_TIMEOUT_MS / 1000} seconds. Try again.`) };
    case 'network':
      return {
        ok: false,
        result: error(
          endpoint.local
            ? `Could not reach ${endpoint.origin}. Check that the server is running.`
            : `Could not reach ${endpoint.origin}. Check the endpoint and your connection.`,
          'endpoint',
        ),
      };
    case 'invalid':
    case 'cancelled':
      return {
        ok: false,
        result: error('This address does not answer like an OpenAI-compatible API. It usually ends in /v1.', 'endpoint'),
      };
    case 'http':
      if (failure.status === 401) {
        return { ok: false, result: error('The provider rejected this API key. Check it and try again.', 'key') };
      }
      if (failure.status === 403) {
        return endpoint.local
          ? {
              ok: false,
              result: error('The server refused Pilbot (HTTP 403). For Ollama, set OLLAMA_ORIGINS=chrome-extension://* and restart it.', 'endpoint'),
            }
          : { ok: false, result: error('The provider refused this API key (HTTP 403). Check its permissions.', 'key') };
      }
      if (failure.status === 404) {
        return { ok: false, result: error('Nothing found at this address. It usually ends in /v1.', 'endpoint') };
      }
      // Busy, out of credit or down right now: the endpoint answers, so it may be saved.
      return { ok: true, models: null, notice: `The provider could not confirm the key right now (HTTP ${failure.status}).` };
    default:
      return { ok: false, result: error('Could not check the provider. Try again.') };
  }
}

/**
 * Checks an endpoint and key while the provider is being set up, without
 * saving anything, and returns the models the provider lists.
 * @param {unknown} raw
 * @returns {Promise<ProviderResult>}
 */
async function runCheck(raw) {
  const input = readInput(raw);
  if (input === null) {
    return error('Unexpected request. Reopen the side panel.');
  }
  const resolved = await resolveConnection(input.baseUrl, input.apiKey);
  if (!resolved.ok) {
    return resolved.result;
  }
  const test = await testConnection({ baseUrl: resolved.endpoint.baseUrl, apiKey: resolved.apiKey }, resolved.endpoint);
  return test.ok ? { kind: 'checked', models: test.models } : test.result;
}

/**
 * @param {unknown} raw What the side panel sent.
 * @returns {Promise<ProviderResult>}
 */
async function runSave(raw) {
  const input = readInput(raw);
  if (input === null) {
    return error('Unexpected request. Reopen the side panel.');
  }
  if (input.chatModel === '' || !isValidModel(input.chatModel)) {
    return error('Enter the model ID, without spaces.', 'chatModel');
  }
  if (input.transcriptionModel !== '' && !isValidModel(input.transcriptionModel)) {
    return error('Enter the model ID without spaces, or leave it empty.', 'transcriptionModel');
  }
  if (!isValidAnswerTimeout(input.timeoutSeconds)) {
    return error(`Enter whole seconds, from ${MIN_ANSWER_TIMEOUT_SECONDS} to ${MAX_ANSWER_TIMEOUT_SECONDS}.`, 'timeout');
  }
  const resolved = await resolveConnection(input.baseUrl, input.apiKey);
  if (!resolved.ok) {
    return resolved.result;
  }
  const { endpoint, apiKey } = resolved;
  const test = await testConnection({ baseUrl: endpoint.baseUrl, apiKey }, endpoint);
  if (!test.ok) {
    return test.result;
  }
  const listed =
    test.models === null || test.models.some((id) => normalizeModelId(id) === normalizeModelId(input.chatModel));
  const notice = test.notice !== '' ? test.notice : listed ? '' : `The provider does not list "${input.chatModel}". If questions fail, check the model.`;

  /** @type {StoredProvider} */
  const provider = {
    v: 1,
    baseUrl: endpoint.baseUrl,
    chatModel: input.chatModel,
    transcriptionModel: input.transcriptionModel,
    hasKey: apiKey !== '',
    keyHint: apiKey.length >= MIN_KEY_LENGTH_FOR_HINT ? apiKey.slice(-4) : '',
    timeoutSeconds: input.timeoutSeconds,
  };
  if (apiKey === '') {
    await chrome.storage.local.set({ [STORAGE_KEYS.PROVIDER]: provider });
    await chrome.storage.local.remove([STORAGE_KEYS.PROVIDER_SECRET, STORAGE_KEYS.CHAT_COMPAT]);
  } else {
    // A fresh IV every time, also when the same key is saved again.
    const secret = await encryptSecret(apiKey, keyContext(endpoint.origin));
    await chrome.storage.local.set({ [STORAGE_KEYS.PROVIDER]: provider, [STORAGE_KEYS.PROVIDER_SECRET]: secret });
    await chrome.storage.local.remove(STORAGE_KEYS.CHAT_COMPAT);
  }
  return { kind: 'saved', notice };
}

/**
 * Checks an endpoint and key without saving (step 2 of the setup): the
 * answer lists the provider's models for step 3.
 * @param {unknown} raw
 * @returns {Promise<ProviderResult>}
 */
export function checkProvider(raw) {
  return runCheck(raw).catch(() => error('Could not check the provider. Try again.'));
}

/**
 * Checks and saves a provider (the end of the setup). An empty API key keeps
 * the saved one, as long as the endpoint's origin stays the same.
 * @param {unknown} raw
 * @returns {Promise<ProviderResult>}
 */
export function saveProvider(raw) {
  return enqueue(() => runSave(raw).catch(() => error('Could not save the provider. Try again.')));
}

/**
 * Forgets the provider and its key, and deletes the encryption key itself, so
 * no copy of the ciphertext can ever be decrypted again. The side panel then
 * shows the setup.
 * @returns {Promise<ProviderResult>}
 */
export function removeProvider() {
  return enqueue(async () => {
    await chrome.storage.local.remove([STORAGE_KEYS.PROVIDER, STORAGE_KEYS.PROVIDER_SECRET, STORAGE_KEYS.CHAT_COMPAT]);
    await forgetEncryptionKey().catch(() => {});
    return /** @type {ProviderResult} */ ({ kind: 'removed' });
  });
}
