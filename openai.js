/**
 * Client for OpenAI-compatible APIs, used by the background worker only (ai.js
 * and provider.js; a trusted extension context: content scripts and pages
 * never import this). Every request the extension makes goes through send()
 * here, to the endpoint the user set up and nowhere else.
 *
 * Endpoints, relative to the base URL ("…/v1"), as OpenAI defines them and
 * Groq, OpenRouter, Gemini, Mistral, DeepSeek, Ollama, LM Studio, vLLM,
 * llama.cpp, LiteLLM and most others copy them:
 *   POST /chat/completions        answers and summaries
 *   POST /audio/transcriptions    dictation (multipart form)
 *   GET  /models                  checks the key when the provider is saved
 *
 * The API key goes only in the Authorization header, only to the configured
 * origin, never in a URL, and never into a log or message. Requests send no
 * cookies, no referrer and refuse redirects, so the key cannot be passed on to
 * another host. Answers are read up to a size limit. Failures come back as
 * results with the HTTP status and the provider's error code (when it looks
 * like a code), never its error text: that text can quote the request,
 * including parts of the key.
 */

import { STORAGE_KEYS, checkEndpoint } from './constants.js';

/** Largest answer read from the chat or transcription endpoints. */
const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
/** Model lists are bigger (OpenRouter lists hundreds of models with descriptions). */
const MAX_MODEL_LIST_BYTES = 16 * 1024 * 1024;
/** Most model IDs kept from a list. */
const MAX_LISTED_MODELS = 5000;
/** Error codes and finish reasons passed on: short identifiers only, never free text. */
const SAFE_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** Low, for short and factual answers. */
const TEMPERATURE = 0.2;
/**
 * Output budget for reasoning models asked with max_completion_tokens: room
 * for their (hidden) reasoning plus the 2-3 sentences the prompt asks for.
 */
const REASONING_MAX_COMPLETION_TOKENS = 2048;
/**
 * Models that think before answering and accept `reasoning_effort` (OpenAI's
 * gpt-oss on Groq, OpenRouter, Ollama…; OpenAI's o-series and GPT-5; Google's
 * Gemini from 2.5 on, also "gemini-flash-latest" and "google/gemini-…" on
 * OpenRouter). "low" keeps their answers fast: Gemini otherwise thinks at its
 * default level, which can take longer than the timeout. Others would reject
 * the parameter; one that does anyway gets the next format (chatProfilesFor()).
 */
const REASONING_MODEL_PATTERN = /gpt-oss|gemini-(?!1\.|2\.0)|(?:^|[/:])(?:o[1-9](?:-|$)|gpt-5)/i;
/**
 * Error codes that mean the input itself was refused (too long, filtered):
 * asking again in another format cannot help.
 */
const INPUT_REFUSED_PATTERN = /context|too_long|too_large|length_exceeded|content_filter|content_policy|moderation/i;

/**
 * Where and how to reach the provider.
 * @typedef {object} Connection
 * @property {string} baseUrl Normalized (checkEndpoint()).
 * @property {string} apiKey '' for none (only local servers).
 */

/**
 * Why a request failed. "http": the provider answered with an error status
 * (`code` is its error code when it is a plain identifier); "invalid": the
 * answer was not what the API defines (or too big); "cancelled": a newer
 * request took over.
 * @typedef {{ kind: 'http', status: number, code: string | null, retryAfter: string | null }
 *   | { kind: 'timeout' }
 *   | { kind: 'network' }
 *   | { kind: 'cancelled' }
 *   | { kind: 'invalid' }} Failure
 */

/**
 * @template T
 * @typedef {{ ok: true, value: T } | { ok: false, failure: Failure }} Outcome
 */

/**
 * @param {Failure} failure
 * @returns {{ ok: false, failure: Failure }}
 */
function fail(failure) {
  return { ok: false, failure };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The full URL of an API path, or null when it would leave the endpoint's
 * origin (it never should: the path is fixed here).
 * @param {Connection} connection
 * @param {string} path e.g. "/chat/completions".
 * @returns {string | null}
 */
function buildUrl(connection, path) {
  const endpoint = checkEndpoint(connection.baseUrl);
  if (!endpoint.ok) {
    return null;
  }
  try {
    const url = new URL(`${endpoint.baseUrl}${path}`);
    return url.origin === endpoint.origin ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Reads a response body as text, up to `maxBytes`.
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<string | null>} null when it is bigger.
 */
async function readLimitedText(response, maxBytes) {
  const declared = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (response.body === null) {
    return '';
  }
  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new Blob(chunks).text();
}

/**
 * The provider's error code from an error body, when it is a plain identifier
 * ("invalid_api_key", "model_not_found", "INVALID_ARGUMENT"…). OpenAI and most
 * others answer { error: { code, type } }; Gemini wraps that in an array.
 * @param {unknown} payload
 * @returns {string | null}
 */
function readErrorCode(payload) {
  const body = Array.isArray(payload) ? payload[0] : payload;
  const error = isRecord(body) && isRecord(body.error) ? body.error : isRecord(body) ? body : {};
  const code = [error.code, error.type, error.status].find(
    (value) => typeof value === 'string' && SAFE_CODE_PATTERN.test(value),
  );
  return typeof code === 'string' ? code : null;
}

/**
 * Sends one request to the provider with a hard timeout. Never rejects.
 * @param {Connection} connection
 * @param {string} path
 * @param {object} options
 * @param {'GET' | 'POST'} [options.method]
 * @param {object | FormData} [options.body] Sent as JSON, or a form as it is.
 * @param {AbortSignal} [options.signal] Aborted when nobody needs the answer any more.
 * @param {number} options.timeoutMs
 * @param {number} [options.maxBytes]
 * @returns {Promise<Outcome<unknown>>} The parsed JSON answer.
 */
async function send(connection, path, { method = 'GET', body, signal, timeoutMs, maxBytes = MAX_JSON_RESPONSE_BYTES }) {
  const url = buildUrl(connection, path);
  if (url === null) {
    return fail({ kind: 'invalid' });
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
  const isForm = body instanceof FormData;
  // Why a request threw. The error itself is never passed on: it can echo the request.
  const thrown = () => {
    if (signal?.aborted) {
      return fail({ kind: 'cancelled' });
    }
    return fail({ kind: timeoutSignal.aborted ? 'timeout' : 'network' });
  };

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(connection.apiKey === '' ? {} : { Authorization: `Bearer ${connection.apiKey}` }),
        // A form sets its own Content-Type (multipart, with the boundary).
        ...(body === undefined || isForm ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      signal: requestSignal,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    return thrown();
  }

  let text;
  try {
    text = await readLimitedText(response, maxBytes);
  } catch {
    return thrown();
  }
  /** @type {unknown} */
  let payload = null;
  try {
    payload = text === null || text === '' ? null : JSON.parse(text);
  } catch {
    // Not JSON: treated like no answer.
  }
  if (!response.ok) {
    return fail({
      kind: 'http',
      status: response.status,
      code: readErrorCode(payload),
      retryAfter: response.headers.get('Retry-After'),
    });
  }
  return payload === null ? fail({ kind: 'invalid' }) : { ok: true, value: payload };
}

// -----------------------------------------------------------------------------
// Chat completions
// -----------------------------------------------------------------------------

/**
 * Request formats for /chat/completions, tried in this order until the
 * provider accepts one (see chatProfilesFor()). OpenAI-compatible servers
 * differ in the optional parameters they take: some reject reasoning_effort,
 * OpenAI's reasoning models reject temperature and max_tokens, and a few
 * strict servers reject anything unknown. `{ model, messages }` alone works
 * everywhere.
 * @type {Readonly<Record<ChatProfile, (model: string, messages: ChatMessage[], maxTokens: number) => object>>}
 */
const CHAT_PROFILES = Object.freeze({
  tuned: (model, messages, maxTokens) => ({
    model,
    messages,
    temperature: TEMPERATURE,
    max_tokens: maxTokens,
    reasoning_effort: 'low',
  }),
  reasoning: (model, messages) => ({
    model,
    messages,
    max_completion_tokens: REASONING_MAX_COMPLETION_TOKENS,
    reasoning_effort: 'low',
  }),
  standard: (model, messages, maxTokens) => ({ model, messages, temperature: TEMPERATURE, max_tokens: maxTokens }),
  minimal: (model, messages) => ({ model, messages }),
});

/** @typedef {'tuned' | 'reasoning' | 'standard' | 'minimal'} ChatProfile */

/** @typedef {{ role: 'system' | 'user', content: string }} ChatMessage */

/**
 * @param {string} model
 * @returns {ChatProfile[]} The formats to try for this model, best first.
 */
function chatProfilesFor(model) {
  return REASONING_MODEL_PATTERN.test(model) ? ['tuned', 'reasoning', 'standard', 'minimal'] : ['standard', 'minimal'];
}

/**
 * The format the provider last accepted for this endpoint and model, so the
 * next request starts there instead of being refused again.
 * @param {Connection} connection
 * @param {string} model
 * @returns {Promise<ChatProfile | null>}
 */
async function readChatProfile(connection, model) {
  try {
    const stored = (await chrome.storage.local.get(STORAGE_KEYS.CHAT_COMPAT))[STORAGE_KEYS.CHAT_COMPAT];
    if (isRecord(stored) && stored.baseUrl === connection.baseUrl && stored.model === model) {
      const { profile } = stored;
      return typeof profile === 'string' && Object.hasOwn(CHAT_PROFILES, profile) ? /** @type {ChatProfile} */ (profile) : null;
    }
  } catch {
    // Unknown: start at the best format.
  }
  return null;
}

/**
 * @param {Connection} connection
 * @param {string} model
 * @param {ChatProfile} profile
 */
async function rememberChatProfile(connection, model, profile) {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.CHAT_COMPAT]: { baseUrl: connection.baseUrl, model, profile } });
  } catch {
    // Only a speed-up: the next request finds the format again.
  }
}

/**
 * @param {Failure} failure
 * @returns {boolean} Whether the provider refused the request's format (and another one may work).
 */
function isFormatRefused(failure) {
  return (
    failure.kind === 'http' &&
    (failure.status === 400 || failure.status === 422) &&
    !(failure.code !== null && INPUT_REFUSED_PATTERN.test(failure.code))
  );
}

/**
 * Text of a message's content: a string, or (some providers) a list of parts,
 * of which the text parts are kept.
 * @param {unknown} content
 * @returns {string | null} null when it is neither.
 */
function readContent(content) {
  if (content === null || content === undefined) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part) => isRecord(part) && (part.type === undefined || part.type === 'text') && typeof part.text === 'string')
      .map((part) => /** @type {{ text: string }} */ (part).text)
      .join('');
  }
  return null;
}

/**
 * @typedef {object} ChatCompletion
 * @property {string} content The answer as the model returned it ('' for none).
 * @property {string | null} finishReason "stop", "length", … or null when unknown.
 */

/**
 * Asks the chat model. Tries the request formats for the model until the
 * provider accepts one, and remembers which one did.
 * @param {Connection} connection
 * @param {{ model: string, messages: ChatMessage[], maxTokens: number }} request
 * @param {AbortSignal} signal
 * @param {number} timeoutMs For each attempt.
 * @returns {Promise<Outcome<ChatCompletion>>}
 */
export async function createChatCompletion(connection, { model, messages, maxTokens }, signal, timeoutMs) {
  const profiles = chatProfilesFor(model);
  const remembered = await readChatProfile(connection, model);
  const start = remembered === null ? 0 : Math.max(0, profiles.indexOf(remembered));

  /** @type {Outcome<unknown>} */
  let result = fail({ kind: 'invalid' });
  for (let index = start; index < profiles.length; index += 1) {
    const profile = profiles[index];
    result = await send(connection, '/chat/completions', {
      method: 'POST',
      body: CHAT_PROFILES[profile](model, messages, maxTokens),
      signal,
      timeoutMs,
    });
    if (result.ok) {
      if (profile !== remembered) {
        await rememberChatProfile(connection, model, profile);
      }
      break;
    }
    if (!isFormatRefused(result.failure)) {
      return result;
    }
  }
  if (!result.ok) {
    return result;
  }

  const payload = result.value;
  const choice = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  const message = isRecord(choice) ? choice.message : undefined;
  const content = isRecord(message) ? readContent(message.content) : null;
  if (!isRecord(choice) || content === null) {
    return fail({ kind: 'invalid' });
  }
  const finishReason =
    typeof choice.finish_reason === 'string' && SAFE_CODE_PATTERN.test(choice.finish_reason) ? choice.finish_reason : null;
  return { ok: true, value: { content, finishReason } };
}

// -----------------------------------------------------------------------------
// Speech to text
// -----------------------------------------------------------------------------

/** The provider reads the audio format from the file name. */
const RECORDING_FILE_NAME = 'dictation.webm';

/**
 * Turns a dictation into text. Only the parameters every OpenAI-compatible
 * speech-to-text endpoint takes: the file, the model, "json" (just the text)
 * and, when one is set, the language (ISO 639-1); without it, the language is
 * detected from the audio.
 * @param {Connection} connection
 * @param {{ model: string, audio: Blob, language: string }} request
 * @param {AbortSignal} signal
 * @param {number} timeoutMs
 * @returns {Promise<Outcome<string>>} The text ('' when nothing was heard).
 */
export async function createTranscription(connection, { model, audio, language }, signal, timeoutMs) {
  const form = new FormData();
  form.append('file', new File([audio], RECORDING_FILE_NAME, { type: audio.type }));
  form.append('model', model);
  form.append('response_format', 'json');
  if (language !== '') {
    form.append('language', language);
  }
  const result = await send(connection, '/audio/transcriptions', { method: 'POST', body: form, signal, timeoutMs });
  if (!result.ok) {
    return result;
  }
  const text = isRecord(result.value) ? result.value.text : undefined;
  return typeof text === 'string' ? { ok: true, value: text } : fail({ kind: 'invalid' });
}

// -----------------------------------------------------------------------------
// Models
// -----------------------------------------------------------------------------

/**
 * Lists the provider's models (GET /models). Used to check the endpoint and
 * the key when the provider is saved; costs no tokens.
 * @param {Connection} connection
 * @param {number} timeoutMs
 * @returns {Promise<Outcome<string[] | null>>} The model IDs, or null when the list has
 *   another shape than OpenAI's ({ data: [{ id }] }).
 */
export async function listModels(connection, timeoutMs) {
  const result = await send(connection, '/models', { timeoutMs, maxBytes: MAX_MODEL_LIST_BYTES });
  if (!result.ok) {
    return result;
  }
  const data = isRecord(result.value) ? result.value.data : undefined;
  if (!Array.isArray(data)) {
    return { ok: true, value: null };
  }
  const ids = data
    .slice(0, MAX_LISTED_MODELS)
    .map((model) => (isRecord(model) ? model.id : undefined))
    .filter((id) => typeof id === 'string');
  return { ok: true, value: /** @type {string[]} */ (ids) };
}
