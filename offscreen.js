/**
 * Recorder: an offscreen document that records the microphone for dictation.
 *
 * Pages never get the microphone: the permission belongs to the extension
 * (granted once on microphone.html, since this hidden page cannot show
 * Chrome's prompt). The background worker creates this document for one
 * dictation and closes it afterwards, which also releases the microphone.
 * It records only between START and STOP (or CANCEL) from the worker and
 * hands the audio back to it; it never sees the API key or talks to pages.
 */

import { MAX_DICTATION_MS, RECORDER_MESSAGE_TYPES, RECORDING_MIME_TYPE } from './constants.js';

/** The only sender accepted: this extension's background worker. */
const WORKER_URL = chrome.runtime.getURL('background.js');
/** Safety stop in case STOP never comes (e.g. the page went away). */
const RECORDING_CAP_MS = MAX_DICTATION_MS + 5_000;
/** Shorter recordings are not sent: Whisper tends to invent text for them. */
const MIN_RECORDING_MS = 500;
/** Plenty for speech (Whisper works on 16 kHz mono) and keeps uploads small. */
const AUDIO_BITS_PER_SECOND = 32_000;

/**
 * @typedef {object} Recording
 * @property {number} tabId The tab dictating.
 * @property {MediaStream} stream
 * @property {MediaRecorder} recorder
 * @property {Blob[]} chunks
 * @property {number} startedAt
 * @property {number} capTimer
 */

/**
 * @typedef {{ kind: 'recording' }
 *   | { kind: 'audio', data: string, mimeType: string }
 *   | { kind: 'cancelled' }
 *   | { kind: 'error', reason: 'permission' | 'no-microphone' | 'too-short' | 'failed' }
 *   | { kind: 'ignored' }} RecorderResult
 */

/** @type {Recording | null} At most one at a time. */
let recording = null;

/** @param {MediaStream} stream */
function releaseMicrophone(stream) {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

/**
 * Takes the recording of a tab out of `recording`, so nothing else can use it.
 * @param {number} tabId
 * @returns {Recording | null}
 */
function takeRecording(tabId) {
  const current = recording;
  if (!current || current.tabId !== tabId) {
    return null;
  }
  recording = null;
  clearTimeout(current.capTimer);
  return current;
}

/**
 * Drops a tab's recording and turns the microphone off.
 * @param {number} tabId
 * @returns {RecorderResult}
 */
function cancel(tabId) {
  const current = takeRecording(tabId);
  if (!current) {
    return { kind: 'ignored' };
  }
  if (current.recorder.state !== 'inactive') {
    current.recorder.stop();
  }
  releaseMicrophone(current.stream);
  return { kind: 'cancelled' };
}

/**
 * @param {unknown} error From getUserMedia().
 * @returns {RecorderResult}
 */
function describeMicrophoneError(error) {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return { kind: 'error', reason: 'permission' };
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return { kind: 'error', reason: 'no-microphone' };
  }
  return { kind: 'error', reason: 'failed' };
}

/**
 * Starts recording for a tab, replacing any other recording.
 * @param {number} tabId
 * @returns {Promise<RecorderResult>}
 */
async function start(tabId) {
  if (recording) {
    cancel(recording.tabId);
  }
  // Checked first: without the permission, getUserMedia() here would wait
  // for a prompt that a hidden page cannot show.
  const permission = await navigator.permissions.query({ name: 'microphone' });
  if (permission.state !== 'granted') {
    return { kind: 'error', reason: 'permission' };
  }

  /** @type {MediaStream} */
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (error) {
    return describeMicrophoneError(error);
  }

  /** @type {MediaRecorder} */
  let recorder;
  try {
    recorder = new MediaRecorder(stream, {
      mimeType: `${RECORDING_MIME_TYPE};codecs=opus`,
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    });
  } catch {
    releaseMicrophone(stream);
    return { kind: 'error', reason: 'failed' };
  }

  /** @type {Recording} */
  const current = { tabId, stream, recorder, chunks: [], startedAt: Date.now(), capTimer: 0 };
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) {
      current.chunks.push(event.data);
    }
  });
  recorder.start();
  current.capTimer = setTimeout(() => {
    if (cancel(tabId).kind === 'cancelled') {
      chrome.runtime.sendMessage({ type: RECORDER_MESSAGE_TYPES.EXPIRED }).catch(() => {});
    }
  }, RECORDING_CAP_MS);
  recording = current;
  return { kind: 'recording' };
}

/**
 * @param {Blob} blob
 * @returns {Promise<string>} The contents in base64 (messages carry JSON only).
 */
function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result).split(',', 2)[1] ?? ''));
    reader.addEventListener('error', () => reject(reader.error));
    reader.readAsDataURL(blob);
  });
}

/**
 * Stops a tab's recording, turns the microphone off and returns the audio.
 * @param {number} tabId
 * @returns {Promise<RecorderResult>}
 */
async function stop(tabId) {
  const current = takeRecording(tabId);
  if (!current) {
    return { kind: 'ignored' };
  }
  const stopped = new Promise((resolve) => current.recorder.addEventListener('stop', resolve, { once: true }));
  current.recorder.stop();
  await stopped;
  releaseMicrophone(current.stream);

  if (Date.now() - current.startedAt < MIN_RECORDING_MS) {
    return { kind: 'error', reason: 'too-short' };
  }
  const audio = new Blob(current.chunks, { type: RECORDING_MIME_TYPE });
  return { kind: 'audio', data: await toBase64(audio), mimeType: RECORDING_MIME_TYPE };
}

/**
 * @param {unknown} message
 * @returns {message is { type: string, tabId: number }}
 */
function isRecorderMessage(message) {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  const { type, tabId } = /** @type {{ type?: unknown, tabId?: unknown }} */ (message);
  return (
    (type === RECORDER_MESSAGE_TYPES.START ||
      type === RECORDER_MESSAGE_TYPES.STOP ||
      type === RECORDER_MESSAGE_TYPES.CANCEL) &&
    Number.isInteger(tabId)
  );
}

/**
 * @param {{ type: string, tabId: number }} message
 * @returns {Promise<RecorderResult>}
 */
async function handleMessage(message) {
  if (message.type === RECORDER_MESSAGE_TYPES.START) {
    return start(message.tabId);
  }
  if (message.type === RECORDER_MESSAGE_TYPES.STOP) {
    return stop(message.tabId);
  }
  return cancel(message.tabId);
}

// Content scripts' messages reach every extension page too; only the
// background worker's are handled.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.url !== WORKER_URL || !isRecorderMessage(message)) {
    return false;
  }
  handleMessage(message)
    .then(sendResponse)
    .catch(() => sendResponse({ kind: 'error', reason: 'failed' }));
  return true;
});
