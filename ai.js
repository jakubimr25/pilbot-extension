/**
 * The AI features: brief answers, page summaries and dictation, asked directly
 * from the AI provider the user set up (provider.js), in the OpenAI-compatible
 * format (openai.js). Used by the background worker only (a trusted extension
 * context: content scripts and pages never import this).
 *
 * Only the user's text or recording, the fixed prompts (prompts.js) and the
 * language set in settings are sent, to the user's provider and nowhere else.
 * Without a provider nothing is sent. Errors are fixed messages chosen by the
 * HTTP status and the provider's error code (the provider's own text is never
 * shown), and what comes back is cleaned before it reaches a page.
 */

import { MAX_ANSWER_LENGTH, MAX_TRANSCRIPT_LENGTH, normalizeReferenceText, normalizeSelection } from './constants.js';
import { createChatCompletion, createTranscription } from './openai.js';
import { buildAnswerMessages, buildSummaryMessages } from './prompts.js';
import { getProviderConnection } from './provider.js';

/** @typedef {import('./constants.js').AnswerResult} AnswerResult */
/** @typedef {import('./constants.js').DictationResult} DictationResult */
/** @typedef {import('./constants.js').ErrorResult} ErrorResult */
/** @typedef {import('./openai.js').Connection} Connection */
/** @typedef {import('./openai.js').Failure} Failure */

/**
 * Dictation's wait, per attempt. Answers and summaries wait as long as the
 * user set with the provider (ProviderSettings.timeoutSeconds): local models
 * on a laptop and thinking models can be slow, others answer in seconds.
 */
const TRANSCRIPTION_TIMEOUT_MS = 60_000;
/** Most tokens the model may write: room for a short reasoning plus the 2-3 sentences asked for. */
const ANSWER_MAX_TOKENS = 1024;
const SUMMARY_MAX_TOKENS = 1024;
/** Longest wait shown from the provider's Retry-After, in seconds. */
const MAX_RETRY_AFTER_SECONDS = 3600;

/** @type {{ kind: 'ignored' }} */
const IGNORED = Object.freeze({ kind: 'ignored' });

/** No provider is set up: shown on the page instead of sending anything. */
export const PROVIDER_REQUIRED = Object.freeze({
  kind: 'error',
  message: 'Connect an AI provider first: click the Pilbot icon in the toolbar.',
});

/** @type {ErrorResult} */
const KEY_LOCKED = Object.freeze({
  kind: 'error',
  message: 'Pilbot could not unlock your saved API key. Enter it again: Pilbot icon → Settings → Edit provider.',
});

/** The provider has no speech-to-text model set. */
export const VOICE_NOT_SET_UP = Object.freeze({
  kind: 'error',
  message: 'Voice needs a speech-to-text model. Set one in the Pilbot side panel: Settings → Edit provider → Models.',
});

/**
 * The provider with its key, or the message to show instead.
 * @returns {Promise<{ kind: 'ready', connection: Connection, chatModel: string, transcriptionModel: string,
 *   chatTimeoutMs: number } | ErrorResult>}
 */
async function connect() {
  const provider = await getProviderConnection();
  if (provider.kind === 'missing') {
    return PROVIDER_REQUIRED;
  }
  if (provider.kind === 'locked') {
    return KEY_LOCKED;
  }
  return {
    kind: 'ready',
    connection: provider.connection,
    chatModel: provider.settings.chatModel,
    transcriptionModel: provider.settings.transcriptionModel,
    chatTimeoutMs: provider.settings.timeoutSeconds * 1000,
  };
}

/**
 * Whether dictation can be sent: a provider whose key unlocks and which has a
 * speech-to-text model. Checked before the microphone turns on.
 * @returns {Promise<ErrorResult | null>} The message when it cannot, else null.
 */
export async function checkVoiceReady() {
  const provider = await connect();
  if (provider.kind !== 'ready') {
    return provider;
  }
  return provider.transcriptionModel === '' ? VOICE_NOT_SET_UP : null;
}

/**
 * @param {string | null} retryAfter The Retry-After header, in seconds.
 * @returns {string} e.g. "in 20 s", "in 2 min", or "later" when it is missing or odd.
 */
function describeWait(retryAfter) {
  const seconds = Number(retryAfter);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_RETRY_AFTER_SECONDS) {
    return 'later';
  }
  return seconds <= 90 ? `in ${seconds} s` : `in ${Math.ceil(seconds / 60)} min`;
}

/**
 * The message for a failed request. The provider's error code, a plain
 * identifier such as "model_not_found", is added to help find the cause.
 * @param {Failure} failure
 * @param {'chat' | 'voice'} feature
 * @param {number} timeoutMs
 * @returns {ErrorResult}
 */
function describeFailure(failure, feature, timeoutMs) {
  const settings = feature === 'voice' ? 'the speech-to-text model' : 'the model';
  switch (failure.kind) {
    case 'timeout':
      return {
        kind: 'error',
        message:
          feature === 'voice'
            ? `No answer from your AI provider within ${timeoutMs / 1000} seconds. Try again.`
            : `No answer from your AI provider within ${timeoutMs / 1000} seconds. Try again, or allow more time: Settings → Edit provider.`,
      };
    case 'network':
      return { kind: 'error', message: 'Could not reach your AI provider. Check your connection and try again.' };
    case 'invalid':
      return {
        kind: 'error',
        message: 'Unexpected answer from your AI provider. Check that the endpoint in Settings is OpenAI-compatible.',
      };
    case 'cancelled':
      return { kind: 'error', message: 'Cancelled.' };
    default:
      break;
  }
  const code = failure.code === null ? '' : ` (${failure.code})`;
  const { status } = failure;
  if (status === 401) {
    return { kind: 'error', message: `Your AI provider rejected the API key${code}. Update it: Pilbot side panel → Settings.` };
  }
  if (status === 402) {
    return { kind: 'error', message: `Your AI provider account is out of credit${code}.` };
  }
  if (status === 403) {
    return { kind: 'error', message: `Your API key may not use ${settings}${code}. Check it in Settings → Edit provider.` };
  }
  if (status === 404) {
    return {
      kind: 'error',
      message: `Your AI provider does not know ${settings}${code}. Check the endpoint and ${settings} in Settings → Edit provider.`,
    };
  }
  if (status === 413) {
    return {
      kind: 'error',
      message: feature === 'voice' ? 'The recording is too large for your AI provider.' : 'Too much text for the AI. Shorten the Knowledge text.',
    };
  }
  if (status === 400 || status === 422) {
    return feature === 'voice'
      ? { kind: 'error', message: `Your AI provider could not read the recording${code}. Try again.` }
      : { kind: 'error', message: `Your AI provider refused the request${code}. Check ${settings} in Settings → Edit provider.` };
  }
  if (status === 429) {
    return { kind: 'error', message: `Your AI provider's rate limit or quota is reached${code}. Try again ${describeWait(failure.retryAfter)}.` };
  }
  if (status === 408 || status === 504) {
    return { kind: 'error', message: 'Your AI provider did not answer in time. Try again.' };
  }
  if (status >= 500) {
    return { kind: 'error', message: `Your AI provider is not available right now (HTTP ${status}). Try again later.` };
  }
  return { kind: 'error', message: `The request failed (HTTP ${status})${code}. Try again.` };
}

/**
 * Removes reasoning that a model returns inline (<think>…</think>), including
 * an unfinished block cut off by the token limit.
 * @param {string} text
 * @returns {string}
 */
function stripReasoning(text) {
  return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '');
}

/**
 * Strips the most common Markdown markers in case the model ignores the
 * plain-text rule.
 * @param {string} text
 * @returns {string}
 */
function toPlainText(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '');
}

/**
 * @param {string} text
 * @param {number} max
 * @returns {string} At most `max` code units, without half a surrogate pair.
 */
function truncate(text, max) {
  return text.length <= max ? text : text.slice(0, max).toWellFormed().trimEnd();
}

/**
 * An answer or summary as shown: no reasoning, no Markdown markers, no
 * control or invisible characters, line breaks kept, capped. Pages render it
 * as text only anyway.
 * @param {string} raw
 * @returns {string}
 */
function cleanAnswer(raw) {
  return truncate(normalizeReferenceText(toPlainText(stripReasoning(raw))).replace(/[ \t]{2,}/g, ' '), MAX_ANSWER_LENGTH);
}

/**
 * Asks the chat model and returns its cleaned answer.
 * @param {import('./openai.js').ChatMessage[]} messages
 * @param {number} maxTokens
 * @param {AbortSignal} cancelSignal Aborted when a newer request supersedes this one.
 * @returns {Promise<AnswerResult>}
 */
async function complete(messages, maxTokens, cancelSignal) {
  const provider = await connect();
  if (provider.kind !== 'ready') {
    return provider;
  }
  const result = await createChatCompletion(
    provider.connection,
    { model: provider.chatModel, messages, maxTokens },
    cancelSignal,
    provider.chatTimeoutMs,
  );
  if (cancelSignal.aborted) {
    return IGNORED;
  }
  if (!result.ok) {
    return describeFailure(result.failure, 'chat', provider.chatTimeoutMs);
  }
  const text = cleanAnswer(result.value.content);
  if (text === '') {
    return {
      kind: 'error',
      message:
        result.value.finishReason === 'length'
          ? 'The model ran out of tokens before answering. Try again, or pick a faster model in Settings.'
          : 'The AI returned no answer. Try again.',
    };
  }
  return { kind: 'answer', text };
}

/**
 * A brief answer to text selected on a page.
 * @param {string} text The selected text, normalized and filtered (isAnswerableText()).
 * @param {string} reference The Knowledge text, or '' when there is none or its switch is off.
 * @param {string} language The code of the language set in settings, or '' for the language of the text.
 * @param {AbortSignal} cancelSignal
 * @returns {Promise<AnswerResult>}
 */
export function askAi(text, reference, language, cancelSignal) {
  return complete(buildAnswerMessages(text, reference, language), ANSWER_MAX_TOKENS, cancelSignal);
}

/**
 * A summary of a page.
 * @param {string} title The page title; '' for none.
 * @param {string} text The page's readable text, cleaned and shortened to MAX_PAGE_TEXT_LENGTH.
 * @param {string} language The code of the language set in settings, or '' for the page's language.
 * @param {AbortSignal} cancelSignal
 * @returns {Promise<AnswerResult>}
 */
export function summarizeAi(title, text, language, cancelSignal) {
  return complete(buildSummaryMessages(title, text, language), SUMMARY_MAX_TOKENS, cancelSignal);
}

/** Every WebM file starts with the EBML header ID. */
const WEBM_SIGNATURE = Object.freeze([0x1a, 0x45, 0xdf, 0xa3]);

/**
 * @param {Blob} audio
 * @returns {Promise<boolean>} Whether it starts like a WebM file.
 */
async function isWebm(audio) {
  const head = new Uint8Array(await audio.slice(0, WEBM_SIGNATURE.length).arrayBuffer());
  return audio.size > WEBM_SIGNATURE.length && WEBM_SIGNATURE.every((byte, index) => head[index] === byte);
}

/**
 * Turns a dictation into text, in the language set in settings, else in the
 * language detected from the audio. The text is typed into a page: one line,
 * no control or invisible characters, capped.
 * @param {Blob} audio Recorded as RECORDING_MIME_TYPE.
 * @param {string} language The code of the language set in settings, or '' to detect it.
 * @param {AbortSignal} cancelSignal
 * @returns {Promise<DictationResult>}
 */
export async function transcribeAi(audio, language, cancelSignal) {
  const provider = await connect();
  if (provider.kind !== 'ready') {
    return provider;
  }
  if (provider.transcriptionModel === '') {
    return VOICE_NOT_SET_UP;
  }
  if (!(await isWebm(audio))) {
    return { kind: 'error', message: 'The recording could not be read. Try again.' };
  }
  const result = await createTranscription(
    provider.connection,
    { model: provider.transcriptionModel, audio, language },
    cancelSignal,
    TRANSCRIPTION_TIMEOUT_MS,
  );
  if (cancelSignal.aborted) {
    return IGNORED;
  }
  if (!result.ok) {
    return describeFailure(result.failure, 'voice', TRANSCRIPTION_TIMEOUT_MS);
  }
  const text = truncate(normalizeSelection(result.value), MAX_TRANSCRIPT_LENGTH);
  return text === '' ? { kind: 'error', message: 'Nothing was heard. Try again.' } : { kind: 'transcript', text };
}
