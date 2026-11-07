/**
 * Microphone permission page. The recorder (offscreen.js) is a hidden page
 * and cannot show Chrome's permission prompt, so this tab asks once; the
 * permission then holds for the whole extension, never for websites.
 * Nothing is recorded here: the microphone is released as soon as Chrome
 * hands it over.
 */

import { STORAGE_KEYS, getTheme } from './constants.js';

/** The tab closes itself this long after the microphone is allowed. */
const CLOSE_DELAY_MS = 1500;

/** @type {Readonly<Record<string, string>>} Text per permission state. */
const STATUS_TEXT = Object.freeze({
  granted: 'Allowed. You can dictate now.',
  prompt: 'Click Allow microphone, then Allow in Chrome’s prompt.',
  denied:
    'Blocked. Allow it with the microphone icon in the address bar (or in Chrome’s site settings), then reload this page.',
});

/**
 * @template {Element} T
 * @param {string} id
 * @param {new (...args: any[]) => T} type
 * @returns {T}
 */
function getRequiredElement(id, type) {
  const element = document.getElementById(id);
  if (!(element instanceof type)) {
    throw new Error(`Missing or invalid element: #${id}`);
  }
  return element;
}

/** Uses the theme picked in the side panel ("system" follows Chrome). */
async function applyTheme() {
  const theme = getTheme(await chrome.storage.sync.get(STORAGE_KEYS.THEME));
  if (theme !== 'system') {
    document.documentElement.dataset.theme = theme;
  }
}

/** Asks Chrome for the microphone and lets it go right away. */
async function requestMicrophone() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) {
      track.stop();
    }
  } catch {
    // Dismissed or blocked: the permission state below shows which.
  }
}

async function closeTab() {
  const tab = await chrome.tabs.getCurrent();
  if (typeof tab?.id === 'number') {
    await chrome.tabs.remove(tab.id);
  }
}

async function init() {
  applyTheme().catch(() => {});
  const status = getRequiredElement('mic-status', HTMLParagraphElement);
  const allow = getRequiredElement('mic-allow', HTMLButtonElement);
  const permission = await navigator.permissions.query({ name: 'microphone' });

  const render = () => {
    status.textContent = STATUS_TEXT[permission.state] ?? '';
    allow.hidden = permission.state !== 'prompt';
  };
  permission.addEventListener('change', () => {
    render();
    if (permission.state === 'granted') {
      setTimeout(() => closeTab().catch(() => {}), CLOSE_DELAY_MS);
    }
  });
  allow.addEventListener('click', () => void requestMicrophone());
  render();
}

void init();
