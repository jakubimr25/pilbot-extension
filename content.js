/**
 * Content script (isolated world, top frame only).
 *
 * With Ask switched on in the side panel (the default), selecting a question
 * on the page shows a small bar with "Ask" and × next to the selection. Ask
 * (or the extension shortcut) sends the selected text to the background
 * worker, and a brief answer is shown in a small panel in the bottom-left
 * corner. × hides the bar for this selection.
 *
 * With Voice switched on in the side panel, focusing a text field shows a
 * microphone button below it. Clicking it has the background worker record
 * (in the extension's own offscreen document: this page never gets the
 * microphone); clicking again turns the recording into text, which is typed
 * where the cursor is.
 *
 * With Summary switched on (the default), a page with enough text gets a
 * small bar at the top center, also when its text arrives late or it moves
 * to another address in place (as on X): its summary button sends the
 * page's readable text (see readPageText(); never form fields or hidden
 * parts) to the background worker and shows the summary below the bar; ×
 * closes the bar for this page.
 *
 * The UI lives in a closed Shadow DOM, is styled with a constructed
 * stylesheet (works under strict page CSP) and renders text with
 * textContent only. This file never touches the API key, the network or
 * the microphone.
 */
(() => {
  'use strict';

  // Keep in sync with constants.js (content scripts cannot import modules
  // without exposing extension files to web pages).
  const MESSAGE_TYPES = Object.freeze({
    ANSWER_SELECTION: 'ANSWER_SELECTION',
    ASK_SELECTION: 'ASK_SELECTION',
    PING: 'PING',
    SUMMARIZE_PAGE: 'SUMMARIZE_PAGE',
    DICTATION_START: 'DICTATION_START',
    DICTATION_STOP: 'DICTATION_STOP',
    DICTATION_CANCEL: 'DICTATION_CANCEL',
  });
  const ENABLED_KEY = 'enabled';
  const THEME_KEY = 'theme';
  const ASK_KEY = 'askEnabled';
  const DICTATION_KEY = 'dictationEnabled';
  const SUMMARY_KEY = 'summaryEnabled';
  const THEMES = Object.freeze(['light', 'dark', 'system']);
  const DEFAULT_THEME = 'system';
  const MAX_PAGE_TEXT_LENGTH = 4000;
  const MIN_PAGE_TEXT_LENGTH = 200;
  const MAX_PAGE_TITLE_LENGTH = 300;
  const MIN_SELECTION_LENGTH = 3;
  const MAX_SELECTION_LENGTH = 2000;
  const MAX_DICTATION_MS = 120_000;
  const MAX_TRANSCRIPT_LENGTH = 5000;

  /** The Summarize bar shows only on pages with at least this much readable text. */
  const SUMMARY_OFFER_MIN_LENGTH = 1000;
  /** How often, at most, a changing page is looked at again for the Summarize bar. */
  const SUMMARY_CHECK_INTERVAL_MS = 1000;
  /**
   * How long after a page opens, or moves to another address in place (as on
   * X), its text is looked for. Sites like X fill in their posts late.
   */
  const SUMMARY_WATCH_MS = 20_000;
  /** Most page text read before it is shortened for a summary; keeps huge pages fast. */
  const MAX_PAGE_SCAN_LENGTH = 60_000;
  /** Longest summary shown. */
  const MAX_SUMMARY_LENGTH = 12_000;

  /**
   * <input> types that get the dictation button (plus <textarea> and editors).
   * Not url, tel or number: dictation types words, not addresses or digits.
   */
  const DICTATION_INPUT_TYPES = Object.freeze(['text', 'search', 'email']);
  /** Fields for card numbers, passwords and one-time codes never get it. */
  const SENSITIVE_AUTOCOMPLETE = /(?:^|\s)(?:cc-|one-time-code|current-password|new-password)/i;

  const HOST_ATTRIBUTE = 'data-ai-quick-ask';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const EDGE_MARGIN_PX = 8;
  const BUTTON_GAP_PX = 6;
  // Material Symbols on a 24 px grid, filled: the same icons as in the side panel.
  const CHAT_PATHS = Object.freeze(['M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z']);
  const MIC_PATHS = Object.freeze([
    'M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z',
  ]);
  const STOP_PATHS = Object.freeze(['M8 6h8c1.1 0 2 .9 2 2v8c0 1.1-.9 2-2 2H8c-1.1 0-2-.9-2-2V8c0-1.1.9-2 2-2z']);
  const SUMMARY_PATHS = Object.freeze([
    'M3 10h11v2H3v-2zm0-2h11V6H3v2zm0 8h7v-2H3v2zm15.01-3.13.71-.71a.996.996 0 0 1 1.41 0l.71.71c.39.39.39 1.02 0 1.41l-.71.71-2.12-2.12zm-.71.71-5.3 5.3V21h2.12l5.3-5.3-2.12-2.12z',
  ]);
  const CLOSE_PATHS = Object.freeze([
    'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  ]);

  const UI_CSS = `
    :host {
      all: initial !important;
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      width: 0 !important;
      height: 0 !important;
      overflow: visible !important;
      z-index: 2147483647 !important;
      display: block !important;
    }
    [hidden] { display: none !important; }
    /* Chrome's blue-grey Material 3 colors (as in styles.css). Light or dark
       comes from the theme picked in the side panel, or matches the page. */
    .ui {
      --fg: #1b1b1f;
      --bg: #ededf4;
      --tonal: #e2e2e9;
      --on-tonal: #44474e;
      --line: rgba(0, 0, 0, 0.06);
      --shadow: 0 1px 3px rgba(0, 0, 0, 0.12), 0 4px 12px rgba(0, 0, 0, 0.08);
      --primary: #525f77;
      --error: #b3261e;
      --recording: #ba1a1a;
      --on-recording: #ffffff;
      color: var(--fg);
      /* The side panel's type: Google Sans and Roboto when installed, else the system font. */
      font: 400 14px/20px "Google Sans Text", "Google Sans", Roboto, system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .ui[data-theme="dark"] {
      --fg: #e4e2e3;
      --bg: #232427;
      --tonal: #36373b;
      --on-tonal: #c4c6d0;
      --line: rgba(255, 255, 255, 0.06);
      --shadow: 0 1px 3px rgba(0, 0, 0, 0.4), 0 4px 12px rgba(0, 0, 0, 0.3);
      --primary: #bac7e3;
      --error: #f2b8b5;
      --recording: #ffb4ab;
      --on-recording: #690005;
    }
    .surface {
      box-sizing: border-box;
      border: 1px solid var(--line);
      background: var(--bg);
      color: var(--fg);
      box-shadow: var(--shadow);
    }

    /* Answer panel (bottom-left): a Material 3 card on the bars' surface. A
       quiet header (icon and name in "label medium", close icon button) over
       the text in "body medium"; a progress ring while waiting. */
    .box {
      position: fixed;
      left: 16px;
      bottom: 16px;
      min-width: min(240px, calc(100vw - 32px));
      max-width: min(360px, calc(100vw - 32px));
      padding: 4px 4px 16px 16px;
      border-radius: 16px;
      animation: enter 0.2s cubic-bezier(0.05, 0.7, 0.1, 1);
    }
    .head {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--on-tonal);
      font-size: 12px;
      font-weight: 500;
      line-height: 16px;
      letter-spacing: 0.5px;
    }
    .head > svg {
      flex: none;
      width: 16px;
      height: 16px;
      fill: currentColor;
    }
    .title { flex: 1; min-width: 0; }
    /* Material standard icon button. */
    .close {
      display: grid;
      flex: none;
      place-items: center;
      width: 32px;
      height: 32px;
      margin: 0;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: inherit;
      cursor: pointer;
    }
    .close:hover { background-image: linear-gradient(color-mix(in srgb, currentColor 8%, transparent) 0 0); }
    .close:active { background-image: linear-gradient(color-mix(in srgb, currentColor 12%, transparent) 0 0); }
    .close:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
    .close svg {
      width: 20px;
      height: 20px;
      fill: currentColor;
    }
    .body {
      max-height: 40vh;
      margin-top: 4px;
      padding-right: 12px;
      overflow-y: auto;
      letter-spacing: 0.25px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      scrollbar-width: none;
    }
    .box[data-state="error"] .body { color: var(--error); }
    .loading {
      display: flex;
      align-items: center;
      gap: 12px;
      color: var(--on-tonal);
    }
    .loading svg { flex: none; width: 20px; height: 20px; }

    /* Ask bar (next to the selection: Ask and ×): the same Material 3
       connected button group as help and settings in the side panel, icons
       only (the names are tooltips), on the answer panel's surface. The
       buttons are equal, a quiet tonal grey (only a recording turns red) with
       small inner corners; one turns fully round while pressed, and stays
       round while chosen: Summarize while its summary shows. */
    .actions {
      position: fixed;
      top: 0;
      left: 0;
      display: inline-flex;
      gap: 2px;
      padding: 4px;
      border-radius: 24px;
      animation: pop 0.12s ease-out;
    }
    .action {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 56px;
      height: 40px;
      margin: 0;
      padding: 0;
      border: 0;
      border-radius: 8px;
      background: var(--tonal);
      color: var(--on-tonal);
      cursor: pointer;
      transition:
        border-radius 0.35s cubic-bezier(0.42, 1.67, 0.21, 0.9),
        background-color 0.2s cubic-bezier(0.2, 0, 0, 1),
        color 0.2s cubic-bezier(0.2, 0, 0, 1);
    }
    .action:first-child { border-top-left-radius: 20px; border-bottom-left-radius: 20px; }
    .action:last-child { border-top-right-radius: 20px; border-bottom-right-radius: 20px; }
    /* State layers: a tint of the button's own text color. */
    .action:hover { background-image: linear-gradient(color-mix(in srgb, currentColor 8%, transparent) 0 0); }
    .action:active {
      border-radius: 20px;
      background-image: linear-gradient(color-mix(in srgb, currentColor 12%, transparent) 0 0);
    }
    .action:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
    .action svg {
      flex: none;
      width: 20px;
      height: 20px;
      fill: currentColor;
    }

    /* Summarize bar: the same bar at the top center of the page, and the
       summary in an answer panel just below it. */
    .pill {
      top: 12px;
      right: 0;
      width: max-content;
      margin: 0 auto;
    }
    .box.summary {
      top: 68px;
      right: 16px;
      bottom: auto;
      width: min(440px, calc(100vw - 32px));
      max-width: none;
      margin: 0 auto;
    }
    .summary .body { max-height: min(60vh, 520px); }
    .ui:has(> .summary:not([hidden])) .pill > .action:first-child { border-radius: 20px; }

    /* Dictation button below a text field: the same bar with one button.
       Red and pulsing while recording; a progress ring while it starts or
       types. */
    .action[data-state="recording"] {
      border-radius: 20px;
      background-color: var(--recording);
      color: var(--on-recording);
      animation: recording 1.6s ease-in-out infinite;
    }
    .action[data-state="busy"] { cursor: progress; }
    svg.spinner {
      fill: none;
      stroke: currentColor;
      stroke-width: 2.5;
      stroke-linecap: round;
      stroke-dasharray: 38 100;
      animation: spin 0.9s linear infinite;
    }

    @keyframes enter { from { opacity: 0; transform: translateY(4px); } }
    @keyframes pop { from { opacity: 0; transform: scale(0.92); } }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes recording {
      50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--recording) 35%, transparent); }
    }
    @media (prefers-reduced-motion: reduce) {
      .box, .actions, .action[data-state="recording"] { animation: none; }
      svg.spinner { animation-duration: 2.4s; }
    }
  `;

  /**
   * @typedef {{ kind: 'answer', text: string }
   *   | { kind: 'error', message: string }
   *   | { kind: 'ignored' }} AnswerResult
   */

  /**
   * @typedef {object} Ui
   * @property {HTMLDivElement} host
   * @property {HTMLDivElement} wrapper
   * @property {HTMLDivElement} box
   * @property {HTMLDivElement} body
   * @property {HTMLDivElement} actions The Ask bar.
   * @property {HTMLDivElement} dictation The bar with the dictation button.
   * @property {HTMLButtonElement} dictateButton
   * @property {HTMLDivElement} pill The Summarize bar.
   * @property {HTMLButtonElement} summaryButton
   * @property {HTMLDivElement} summaryBox The panel with the summary, below the bar.
   * @property {HTMLDivElement} summaryBody
   */

  /**
   * Dictation, step by step: idle (the button waits), starting (the
   * microphone is being turned on), recording, transcribing (the audio is
   * being turned into text).
   * @typedef {'idle' | 'starting' | 'recording' | 'transcribing'} DictationState
   */

  /**
   * @typedef {object} SelectionCandidate
   * @property {string} text Normalized selected text.
   * @property {Range} range Snapshot of the selection, used for positioning.
   */

  let enabled = false;
  let askEnabled = false;
  let dictationEnabled = false;
  let themeSetting = DEFAULT_THEME;
  let requestSeq = 0;
  /** @type {string | null} */
  let lastAskedText = null;
  /** @type {Ui | null} */
  let ui = null;
  /** @type {SelectionCandidate | null} */
  let candidate = null;
  let repositionFrame = 0;
  /** @type {HTMLElement | null} The text field the dictation button belongs to. */
  let dictationField = null;
  /** @type {DictationState} */
  let dictationState = 'idle';
  let dictationTimer = 0;
  /** @type {MutationObserver | null} */
  let staleHostObserver = null;
  let summaryEnabled = false;
  /** Set once the Summarize bar was closed with ×: it stays away on this page. */
  let summaryDismissed = false;
  let summaryLoading = false;
  let summarySeq = 0;
  /** @type {string | null} The summary of this page, so asking again sends nothing. */
  let pageSummary = null;
  /** Pending look at the page for the Summarize bar; 0 when there is none. */
  let summaryCheckTimer = 0;
  /** @type {MutationObserver | null} Notices late content and moves to another address in place. */
  let pageObserver = null;
  /** The address (without its #fragment) of the page the bar belongs to. */
  let summaryPageUrl = '';
  /** Until when (Date.now()) the page's text is looked for. */
  let summaryWatchUntil = 0;
  /**
   * The Summarize bar is offered when a page is opened, not in tabs that were
   * already open when the background worker injected this copy.
   */
  const loadedFresh = document.readyState !== 'complete';

  // ---------------------------------------------------------------------------
  // Old copies of this script
  // ---------------------------------------------------------------------------
  //
  // Reloading or updating the extension does not stop the copy of this script
  // already running in open tabs: it stays, cut off from the extension, with
  // its old buttons. The background worker injects the new copy into open
  // tabs, and the newest copy takes over:
  // - it announces itself with TAKEOVER_EVENT; copies from version 7.3 on
  //   remove themselves when they hear it (or notice they are cut off);
  // - older copies cannot hear it, so their UI is removed whenever they add it.

  const TAKEOVER_EVENT = `ai-quick-ask-takeover-${chrome.runtime.id}`;

  /** @returns {boolean} False once the extension was reloaded or removed. */
  function isExtensionAlive() {
    try {
      return typeof chrome.runtime?.id === 'string';
    } catch {
      return false;
    }
  }

  function removeStaleHosts() {
    for (const element of [...(document.documentElement?.children ?? [])]) {
      if (element.hasAttribute(HOST_ATTRIBUTE) && element !== ui?.host) {
        element.remove();
      }
    }
  }

  function takeOverOldCopies() {
    document.dispatchEvent(new CustomEvent(TAKEOVER_EVENT));
    // Added after dispatching, so this copy does not hear its own event.
    document.addEventListener(TAKEOVER_EVENT, teardown);
    if (document.documentElement) {
      removeStaleHosts();
      staleHostObserver = new MutationObserver(removeStaleHosts);
      staleHostObserver.observe(document.documentElement, { childList: true });
    }
  }

  // ---------------------------------------------------------------------------
  // UI construction
  // ---------------------------------------------------------------------------

  /**
   * @template {keyof HTMLElementTagNameMap} K
   * @param {K} tag
   * @param {string} className
   * @returns {HTMLElementTagNameMap[K]}
   */
  function createElement(tag, className) {
    const element = document.createElement(tag);
    element.className = className;
    return element;
  }

  /**
   * @param {string} viewBox
   * @param {readonly string[]} paths Path data, one element each.
   * @returns {SVGSVGElement}
   */
  function createIcon(viewBox, paths) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('aria-hidden', 'true');
    for (const pathData of paths) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', pathData);
      svg.append(path);
    }
    return svg;
  }

  /** @returns {SVGSVGElement} Material circular progress indicator. */
  function createSpinner() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'spinner');
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '8.5');
    svg.append(circle);
    return svg;
  }

  /**
   * Sets an icon-only button's name, shown as its tooltip and read by screen readers.
   * @param {HTMLButtonElement} button
   * @param {string} name
   */
  function setButtonName(button, name) {
    button.title = name;
    button.setAttribute('aria-label', name);
  }

  /**
   * @param {string} className
   * @param {string} name Tooltip and accessible name.
   * @param {(event: MouseEvent) => void} onClick
   * @returns {HTMLButtonElement}
   */
  function createActionButton(className, name, onClick) {
    const button = createElement('button', className);
    button.type = 'button';
    setButtonName(button, name);
    button.addEventListener('click', onClick);
    return button;
  }

  /**
   * A panel for an answer or a summary: a header with its icon, name and a
   * close button, over the text.
   * @param {string} className
   * @param {string} title
   * @param {readonly string[]} iconPaths
   * @param {() => void} onClose
   * @returns {{ box: HTMLDivElement, body: HTMLDivElement }}
   */
  function createPanel(className, title, iconPaths, onClose) {
    const box = createElement('div', className);
    box.hidden = true;
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    const head = createElement('div', 'head');
    const name = createElement('span', 'title');
    name.textContent = title;
    const close = createElement('button', 'close');
    close.type = 'button';
    setButtonName(close, 'Close');
    close.append(createIcon('0 0 24 24', CLOSE_PATHS));
    close.addEventListener('click', onClose);
    head.append(createIcon('0 0 24 24', iconPaths), name, close);
    const body = createElement('div', 'body');
    box.append(head, body);
    return { box, body };
  }

  /** @returns {Ui} */
  function createUi() {
    const host = createElement('div', '');
    host.setAttribute(HOST_ATTRIBUTE, '');
    const root = host.attachShadow({ mode: 'closed' });

    const sheet = new CSSStyleSheet();
    sheet.replaceSync(UI_CSS);
    root.adoptedStyleSheets = [sheet];

    const wrapper = createElement('div', 'ui');

    const { box, body } = createPanel('box surface', 'Answer', CHAT_PATHS, closePanel);

    const actions = createElement('div', 'actions surface');
    actions.hidden = true;
    // Keep the page selection intact when a button is pressed.
    actions.addEventListener('mousedown', (event) => event.preventDefault());
    const askButton = createActionButton('action', 'Ask', onAskClick);
    askButton.append(createIcon('0 0 24 24', CHAT_PATHS));
    const actionsClose = createActionButton('action', 'Close', onActionsCloseClick);
    actionsClose.append(createIcon('0 0 24 24', CLOSE_PATHS));
    actions.append(askButton, actionsClose);

    const dictation = createElement('div', 'actions surface');
    dictation.hidden = true;
    // Keep the focus (and the cursor) in the text field when the button is pressed.
    dictation.addEventListener('mousedown', (event) => event.preventDefault());
    const dictateButton = createActionButton('action', 'Dictate', onDictateClick);
    dictation.append(dictateButton);

    const pill = createElement('div', 'actions pill surface');
    pill.hidden = true;
    const summaryButton = createActionButton('action', 'Summarize page', onSummarizeClick);
    summaryButton.append(createIcon('0 0 24 24', SUMMARY_PATHS));
    const pillClose = createActionButton('action', 'Close', onPillCloseClick);
    pillClose.append(createIcon('0 0 24 24', CLOSE_PATHS));
    pill.append(summaryButton, pillClose);
    const summary = createPanel('box summary surface', 'Summary', SUMMARY_PATHS, closeSummary);

    wrapper.append(box, actions, dictation, pill, summary.box);
    root.append(wrapper);
    document.documentElement.append(host);
    return {
      host,
      wrapper,
      box,
      body,
      actions,
      dictation,
      dictateButton,
      pill,
      summaryButton,
      summaryBox: summary.box,
      summaryBody: summary.body,
    };
  }

  /** @returns {Ui} */
  function ensureUi() {
    if (!ui || !ui.host.isConnected) {
      ui?.host.remove();
      ui = createUi();
    }
    applyTheme();
    return ui;
  }

  /**
   * Light or dark as picked in the side panel; "system" matches the page.
   * Checked each time the UI is shown, since pages can switch themselves.
   */
  function applyTheme() {
    if (ui) {
      ui.wrapper.dataset.theme = themeSetting === 'system' ? detectPageTheme() : themeSetting;
    }
  }

  /**
   * Picks the theme from the page background so the UI blends in
   * (light surface on light pages, dark surface on dark pages).
   * @returns {'light' | 'dark'}
   */
  function detectPageTheme() {
    for (const element of [document.body, document.documentElement]) {
      if (!element) {
        continue;
      }
      const match = getComputedStyle(element).backgroundColor.match(
        /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/,
      );
      if (!match || (match[4] !== undefined && Number(match[4]) < 0.5)) {
        continue;
      }
      const [r, g, b] = match.slice(1, 4).map(Number);
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5 ? 'dark' : 'light';
    }
    // Transparent page: the browser canvas is dark only if the page opts in.
    const pageSupportsDark = getComputedStyle(document.documentElement).colorScheme.includes('dark');
    return pageSupportsDark && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  // ---------------------------------------------------------------------------
  // Answer panel
  // ---------------------------------------------------------------------------

  function closePanel() {
    requestSeq += 1;
    lastAskedText = null;
    if (ui) {
      ui.box.hidden = true;
    }
  }

  /**
   * Shows a panel with a progress ring and what it is waiting for.
   * @param {HTMLDivElement} box
   * @param {HTMLDivElement} body
   * @param {string} label e.g. "Thinking".
   */
  function setPanelLoading(box, body, label) {
    box.hidden = false;
    box.dataset.state = 'loading';
    box.setAttribute('aria-busy', 'true');
    const loading = createElement('span', 'loading');
    loading.append(createSpinner(), `${label}…`);
    body.replaceChildren(loading);
  }

  /**
   * @param {HTMLDivElement} box
   * @param {HTMLDivElement} body
   * @param {string} text
   * @param {'answer' | 'error'} state
   */
  function setPanelText(box, body, text, state) {
    box.hidden = false;
    box.dataset.state = state;
    box.removeAttribute('aria-busy');
    body.textContent = text;
  }

  function showLoading() {
    const { box, body } = ensureUi();
    setPanelLoading(box, body, 'Thinking');
  }

  /**
   * @param {string} text
   * @param {'answer' | 'error'} state
   */
  function showText(text, state) {
    const { box, body } = ensureUi();
    setPanelText(box, body, text, state);
  }

  /**
   * Shows a message in the answer panel, replacing any answer on its way.
   * @param {string} message
   */
  function showError(message) {
    requestSeq += 1;
    lastAskedText = null;
    showText(message, 'error');
  }

  /**
   * Shows the message of an error result from the background worker.
   * @param {unknown} response
   */
  function showResponseError(response) {
    const result = /** @type {{ kind?: unknown, message?: unknown } | null | undefined} */ (response);
    if (result?.kind === 'error' && typeof result.message === 'string') {
      showError(result.message);
    }
  }

  /**
   * Renders a background response after validating its shape.
   * @param {unknown} response
   */
  function renderResult(response) {
    const result = /** @type {Partial<AnswerResult> & Record<string, unknown> | null | undefined} */ (response);
    if (result?.kind === 'answer' && typeof result.text === 'string') {
      showText(result.text, 'answer');
    } else if (result?.kind === 'error' && typeof result.message === 'string') {
      showText(result.message, 'error');
    } else {
      closePanel();
    }
  }

  // ---------------------------------------------------------------------------
  // Ask bar
  // ---------------------------------------------------------------------------

  function hideActions() {
    candidate = null;
    if (ui) {
      ui.actions.hidden = true;
    }
  }

  /**
   * Returns the last non-empty line box of the range (the end of the selection).
   * @param {Range} range
   * @returns {DOMRect}
   */
  function getSelectionEndRect(range) {
    const rects = range.getClientRects();
    for (let i = rects.length - 1; i >= 0; i -= 1) {
      if (rects[i].width > 0 && rects[i].height > 0) {
        return rects[i];
      }
    }
    return range.getBoundingClientRect();
  }

  /**
   * Places a bar just below the anchor, aligned with its left or right edge
   * (above it when there is no room below), inside the viewport. Hidden while
   * the anchor is off screen.
   * @param {HTMLDivElement} bar
   * @param {DOMRect} anchor
   * @param {'left' | 'right'} align
   */
  function placeBar(bar, anchor, align) {
    const offscreen =
      (anchor.width === 0 && anchor.height === 0) || anchor.bottom < 0 || anchor.top > innerHeight;
    bar.hidden = offscreen;
    if (offscreen) {
      return;
    }

    const { offsetWidth: width, offsetHeight: height } = bar;
    let top = anchor.bottom + BUTTON_GAP_PX;
    if (top + height > innerHeight - EDGE_MARGIN_PX) {
      top = anchor.top - BUTTON_GAP_PX - height;
    }
    top = Math.min(Math.max(top, EDGE_MARGIN_PX), innerHeight - height - EDGE_MARGIN_PX);
    const left = Math.min(
      Math.max(align === 'left' ? anchor.left : anchor.right - width, EDGE_MARGIN_PX),
      innerWidth - width - EDGE_MARGIN_PX,
    );
    bar.style.setProperty('top', `${Math.round(top)}px`);
    bar.style.setProperty('left', `${Math.round(left)}px`);
  }

  /** Places the Ask bar just below the end of the selection. */
  function positionActions() {
    if (ui && candidate) {
      placeBar(ui.actions, getSelectionEndRect(candidate.range), 'right');
    }
  }

  /** @param {SelectionCandidate} next */
  function showActions(next) {
    candidate = next;
    ensureUi();
    positionActions();
  }

  /** @param {MouseEvent} event */
  function onAskClick(event) {
    if (!event.isTrusted || !candidate) {
      return;
    }
    const { text } = candidate;
    hideActions();
    void ask(text);
  }

  /**
   * Hides the bar for this selection; the next one shows it again. The
   * selection itself stays.
   * @param {MouseEvent} event
   */
  function onActionsCloseClick(event) {
    if (!event.isTrusted) {
      return;
    }
    hideActions();
  }

  // ---------------------------------------------------------------------------
  // Dictation
  // ---------------------------------------------------------------------------

  /**
   * Returns the text field that may get the dictation button: an enabled,
   * editable text input, textarea or rich-text editor, but never one for a
   * password, a card number or a one-time code.
   * @param {EventTarget | undefined} target The focused element.
   * @returns {HTMLElement | null}
   */
  function getDictationField(target) {
    if (
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLInputElement && DICTATION_INPUT_TYPES.includes(target.type))
    ) {
      return !target.disabled && !target.readOnly && !SENSITIVE_AUTOCOMPLETE.test(target.autocomplete)
        ? target
        : null;
    }
    return target instanceof HTMLElement && target.isContentEditable ? target : null;
  }

  /** Shows the microphone (start), stop (recording) or a progress ring. */
  function renderDictateButton() {
    if (!ui) {
      return;
    }
    const button = ui.dictateButton;
    if (dictationState === 'idle') {
      button.replaceChildren(createIcon('0 0 24 24', MIC_PATHS));
      delete button.dataset.state;
      setButtonName(button, 'Dictate');
    } else if (dictationState === 'recording') {
      button.replaceChildren(createIcon('0 0 24 24', STOP_PATHS));
      button.dataset.state = 'recording';
      setButtonName(button, 'Stop and type');
    } else {
      button.replaceChildren(createSpinner());
      button.dataset.state = 'busy';
      setButtonName(button, dictationState === 'starting' ? 'Starting the microphone…' : 'Typing…');
    }
  }

  /**
   * Places the dictation bar below the start of its text field, where the
   * text begins (the right edge on right-to-left pages), or hides it when the
   * field is gone.
   */
  function positionDictation() {
    if (!ui || !dictationField) {
      return;
    }
    if (!dictationField.isConnected) {
      cancelDictation();
      hideDictation();
      return;
    }
    const rtl = getComputedStyle(dictationField).direction === 'rtl';
    placeBar(ui.dictation, dictationField.getBoundingClientRect(), rtl ? 'right' : 'left');
  }

  /** @param {HTMLElement} field */
  function showDictation(field) {
    dictationField = field;
    ensureUi();
    renderDictateButton();
    positionDictation();
  }

  /** Hides the dictation bar; a dictation in progress keeps it. */
  function hideDictation() {
    if (dictationState !== 'idle') {
      return;
    }
    dictationField = null;
    if (ui) {
      ui.dictation.hidden = true;
    }
  }

  /** @param {DictationState} state */
  function setDictationState(state) {
    dictationState = state;
    clearTimeout(dictationTimer);
    if (state === 'recording') {
      dictationTimer = setTimeout(() => void stopDictation(), MAX_DICTATION_MS);
    }
    renderDictateButton();
  }

  /**
   * Sends a dictation step to the background worker.
   * @param {string} type
   * @returns {Promise<unknown>} undefined when this script was cut off (and torn down).
   */
  async function sendDictation(type) {
    try {
      return await chrome.runtime.sendMessage({ type });
    } catch {
      // Extension was reloaded or removed: this script is orphaned.
      teardown();
      return undefined;
    }
  }

  async function startDictation() {
    setDictationState('starting');
    const response = await sendDictation(MESSAGE_TYPES.DICTATION_START);
    if (dictationState !== 'starting') {
      // Cancelled meanwhile; the worker runs that cancel after this start.
      return;
    }
    const result = /** @type {{ kind?: unknown } | null | undefined} */ (response);
    setDictationState(result?.kind === 'recording' ? 'recording' : 'idle');
    showResponseError(response);
  }

  async function stopDictation() {
    if (dictationState !== 'recording' || !dictationField) {
      return;
    }
    const field = dictationField;
    setDictationState('transcribing');
    const response = await sendDictation(MESSAGE_TYPES.DICTATION_STOP);
    if (dictationState !== 'transcribing') {
      return;
    }
    setDictationState('idle');
    const result = /** @type {{ kind?: unknown, text?: unknown } | null | undefined} */ (response);
    if (
      result?.kind === 'transcript' &&
      typeof result.text === 'string' &&
      result.text.length <= MAX_TRANSCRIPT_LENGTH
    ) {
      typeIntoField(field, result.text);
    } else {
      showResponseError(response);
    }
  }

  /** Drops a dictation in progress: the microphone goes off, nothing is typed. */
  function cancelDictation() {
    if (dictationState === 'idle') {
      return;
    }
    setDictationState('idle');
    try {
      chrome.runtime.sendMessage({ type: MESSAGE_TYPES.DICTATION_CANCEL }).catch(() => {});
    } catch {
      // Cut off from the extension, whose reload closed the recorder already.
    }
  }

  /** @param {MouseEvent} event */
  function onDictateClick(event) {
    if (!event.isTrusted || !dictationField) {
      return;
    }
    if (dictationState === 'idle') {
      void startDictation();
    } else if (dictationState === 'recording') {
      void stopDictation();
    }
  }

  /**
   * @param {HTMLElement} field
   * @returns {string} The character just before the cursor, or '' when unknown.
   */
  function getCharBeforeCursor(field) {
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      return field.value.charAt((field.selectionStart ?? field.value.length) - 1);
    }
    const selection = document.getSelection();
    const node = selection?.anchorNode;
    return node?.nodeType === Node.TEXT_NODE ? (node.textContent ?? '').charAt(selection.anchorOffset - 1) : '';
  }

  /**
   * An e-mail address as dictated, made to fit an e-mail field: Whisper
   * writes it like a sentence ("Anna@example.com." or "anna @ example.com"),
   * so spaces and closing punctuation go, and it is lower case.
   * @param {string} text
   * @returns {string}
   */
  function toEmailText(text) {
    return text.replace(/\s+/g, '').replace(/[.,!?;:…]+$/u, '').toLowerCase();
  }

  /**
   * Types the dictated text where the cursor is, as plain text, like the
   * user typing it: the page gets its usual input events and Undo works.
   * @param {HTMLElement} field
   * @param {string} text
   */
  function typeIntoField(field, text) {
    if (!field.isConnected) {
      showError('The text field is gone, so nothing was typed.');
      return;
    }
    if (!field.matches(':focus')) {
      field.focus();
    }
    const email = field instanceof HTMLInputElement && field.type === 'email';
    // An address gets no space before it.
    const spaced = email ? toEmailText(text) : /\S/.test(getCharBeforeCursor(field)) ? ` ${text}` : text;
    if (spaced === '') {
      return;
    }
    if (document.execCommand('insertText', false, spaced)) {
      return;
    }
    // Some fields refuse insertText; plain inputs can still take the text
    // (not e-mail fields: they have no selection, so setRangeText() throws).
    if (field instanceof HTMLTextAreaElement || (field instanceof HTMLInputElement && !email)) {
      const end = field.value.length;
      field.setRangeText(spaced, field.selectionStart ?? end, field.selectionEnd ?? end, 'end');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      showError('This field did not accept the text. Try clicking into it first.');
    }
  }

  // ---------------------------------------------------------------------------
  // Page text (what a summary sends)
  // ---------------------------------------------------------------------------
  //
  // Only the readable text of the page's main content is sent, one block per
  // line, and only after a click on the summary button. Left out: code,
  // media and frames; navigation, headers, footers, sidebars, dialogs and
  // menus; cookie bars, ads, sharing buttons, related links and comments;
  // hidden and fixed or sticky parts; form fields and editors (the user's own
  // typing); one-word lines (buttons, labels) and repeated lines. Long runs of
  // letters and digits (keys, tokens) are masked. Links' URLs, the page's URL
  // and its metadata are never read.

  /** Elements whose text is never sent: code, media, page furniture and form controls. */
  const SKIPPED_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'frame', 'object', 'embed',
    'video', 'audio', 'picture', 'img', 'map', 'nav', 'header', 'footer', 'aside', 'form', 'button',
    'input', 'textarea', 'select', 'label', 'dialog', 'menu',
  ]);
  /** ARIA roles of page furniture and controls. */
  const SKIPPED_ROLES = new Set([
    'navigation', 'banner', 'contentinfo', 'complementary', 'search', 'dialog', 'alertdialog',
    'menu', 'menubar', 'toolbar', 'tablist', 'button', 'textbox', 'form',
  ]);
  /** A class or ID starting with one of these words marks a cookie bar, an ad, sharing buttons and the like. */
  const FURNITURE_NAME =
    /^(?:ads?|advert|banner|breadcrumbs?|comments?|consent|cookies?|footer|menu|modal|nav|navbar|newsletter|popup|promo|related|share|sharing|sidebar|social|sponsored|subscribe|toolbar)(?:[-_]|$)/i;
  /** Containers checked for fixed or sticky positioning (bars and widgets that stay on screen). */
  const POSITIONED_TAGS = new Set(['div', 'section']);
  /** Elements that start a new line of text. */
  const BLOCK_SELECTOR =
    'p, li, h1, h2, h3, h4, h5, h6, td, th, dt, dd, blockquote, pre, figcaption, caption, summary, div, section, article, main, body';
  /** Blocks whose one-word lines are kept: headings, list items and table cells. */
  const SHORT_LINE_TAGS = /^(?:h[1-6]|li|td|th|dt|dd)$/;
  /** Long unbroken runs of letters and digits: keys, tokens and hashes shown on the page. */
  const SECRET_LIKE = /[A-Za-z0-9_-]{32,}/g;

  /**
   * @param {Element} element
   * @returns {boolean} Whether its ID or a class names page furniture.
   */
  function hasFurnitureName(element) {
    return `${element.id} ${element.getAttribute('class') ?? ''}`
      .split(/\s+/)
      .some((name) => FURNITURE_NAME.test(name));
  }

  /**
   * Decides whether an element's text may be part of a summary.
   * @param {Element} element
   * @param {boolean} skipNamed Whether to also leave out elements named like page furniture.
   * @returns {number} A NodeFilter result: REJECT leaves out the element and everything in it.
   */
  function filterPageElement(element, skipNamed) {
    if (
      SKIPPED_TAGS.has(element.localName) ||
      SKIPPED_ROLES.has(element.getAttribute('role') ?? '') ||
      element.hasAttribute(HOST_ATTRIBUTE) ||
      element.hasAttribute('hidden') ||
      element.hasAttribute('inert') ||
      element.getAttribute('aria-hidden') === 'true' ||
      (element instanceof HTMLElement && element.isContentEditable) ||
      (skipNamed && hasFurnitureName(element))
    ) {
      return NodeFilter.FILTER_REJECT;
    }
    if (!element.checkVisibility({ visibilityProperty: true })) {
      // display: contents has no box of its own, but its children show.
      return getComputedStyle(element).display === 'contents' ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_REJECT;
    }
    if (POSITIONED_TAGS.has(element.localName)) {
      const { position } = getComputedStyle(element);
      if (position === 'fixed' || position === 'sticky') {
        return NodeFilter.FILTER_REJECT;
      }
    }
    return NodeFilter.FILTER_SKIP;
  }

  /**
   * Picks the element holding the page's main text: its only article, else
   * its main area, else the whole body.
   * @returns {Element | null}
   */
  function findContentRoot() {
    const articles = [...document.querySelectorAll('article')].filter(
      (article) => !article.parentElement?.closest('article'),
    );
    if (articles.length === 1 && (articles[0].textContent?.length ?? 0) >= SUMMARY_OFFER_MIN_LENGTH) {
      return articles[0];
    }
    const main = document.querySelector('main, [role="main"]');
    if (main && (main.textContent?.length ?? 0) >= SUMMARY_OFFER_MIN_LENGTH) {
      return main;
    }
    return document.body;
  }

  /** @param {string} match */
  function maskSecret(match) {
    return /\d/.test(match) && /[A-Za-z]/.test(match) ? '[…]' : match;
  }

  /**
   * Cleans one line and marks headings and list items, or returns '' for a
   * line that is left out (one-word buttons and labels such as "Share").
   * @param {string} raw
   * @param {Element | null} block The element the line comes from.
   * @returns {string}
   */
  function cleanPageLine(raw, block) {
    const text = normalizeSelection(raw).replace(SECRET_LIKE, maskSecret);
    const tag = block?.localName ?? '';
    if (text === '' || (!/\s/.test(text) && !SHORT_LINE_TAGS.test(tag))) {
      return '';
    }
    if (/^h[1-6]$/.test(tag)) {
      return `# ${text}`;
    }
    return tag === 'li' ? `- ${text}` : text;
  }

  /**
   * Reads the readable text inside root, one block per line.
   * @param {Element} root
   * @param {number} limit Stops reading once the text is this long.
   * @param {boolean} skipNamed
   * @returns {string}
   */
  function collectPageText(root, limit, skipNamed) {
    /** @type {string[]} */
    const lines = [];
    const seen = new Set();
    let length = 0;
    let line = '';
    /** @type {Element | null} */
    let block = null;
    const endLine = () => {
      const text = cleanPageLine(line, block);
      line = '';
      // Repeated lines are mostly page furniture; table cells may repeat.
      if (text !== '' && (!seen.has(text) || /^t[dh]$/.test(block?.localName ?? ''))) {
        seen.add(text);
        length += (lines.length > 0 ? 1 : 0) + text.length;
        lines.push(text);
      }
    };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.nodeType === Node.ELEMENT_NODE
          ? filterPageElement(/** @type {Element} */ (node), skipNamed)
          : NodeFilter.FILTER_ACCEPT,
    });
    for (let node = walker.nextNode(); node !== null && length < limit; node = walker.nextNode()) {
      const nodeBlock = node.parentElement?.closest(BLOCK_SELECTOR) ?? null;
      if (nodeBlock !== block) {
        endLine();
        block = nodeBlock;
      }
      line += node.previousSibling?.nodeName === 'BR' ? ` ${node.nodeValue}` : node.nodeValue;
    }
    endLine();
    return lines.join('\n');
  }

  /**
   * The readable text of the page's main content. A page whose content
   * itself is named like furniture (e.g. "sidebar-layout") is read again
   * without that check.
   * @param {number} limit Stops reading once the text is this long.
   * @returns {string}
   */
  function readPageText(limit) {
    const root = findContentRoot();
    if (!root) {
      return '';
    }
    const text = collectPageText(root, limit, true);
    return text.length >= SUMMARY_OFFER_MIN_LENGTH ? text : collectPageText(root, limit, false);
  }

  /**
   * Same as trimPageText() in constants.js: keeps the start (70%) and the end
   * of a long text, cut at line breaks.
   * @param {string} text
   * @param {number} max
   * @returns {string}
   */
  function trimPageText(text, max) {
    if (text.length <= max) {
      return text;
    }
    const headLength = Math.floor(max * 0.7);
    const head = text.slice(0, headLength);
    const tail = text.slice(text.length - (max - headLength - 3));
    const headEnd = head.lastIndexOf('\n');
    return `${headEnd > 0 ? head.slice(0, headEnd) : head}\n…\n${tail.slice(tail.indexOf('\n') + 1)}`;
  }

  // ---------------------------------------------------------------------------
  // Summarize bar
  // ---------------------------------------------------------------------------

  /** Shows the summary icon, or a progress ring while summarizing. */
  function renderSummaryButton() {
    if (!ui) {
      return;
    }
    const button = ui.summaryButton;
    if (summaryLoading) {
      button.replaceChildren(createSpinner());
      button.dataset.state = 'busy';
      setButtonName(button, 'Summarizing…');
    } else {
      button.replaceChildren(createIcon('0 0 24 24', SUMMARY_PATHS));
      delete button.dataset.state;
      setButtonName(button, 'Summarize page');
    }
  }

  /** @returns {string} The page's address without its #fragment. */
  function getPageUrl() {
    return location.href.split('#')[0];
  }

  /**
   * Looks for the page's text now and whenever the page changes, for
   * SUMMARY_WATCH_MS. Sites like X fill in their posts after the page has
   * loaded, and move to other addresses without loading a new page; the
   * observer notices both.
   */
  function watchPage() {
    if (!enabled || !summaryEnabled || !document.documentElement) {
      return;
    }
    summaryPageUrl = getPageUrl();
    summaryWatchUntil = Date.now() + SUMMARY_WATCH_MS;
    if (!pageObserver) {
      pageObserver = new MutationObserver(onPageMutation);
      pageObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
    scheduleSummaryCheck();
  }

  function stopWatchingPage() {
    pageObserver?.disconnect();
    pageObserver = null;
    clearTimeout(summaryCheckTimer);
    summaryCheckTimer = 0;
  }

  /** At most one look per SUMMARY_CHECK_INTERVAL_MS, however busy the page is. */
  function onPageMutation() {
    if (summaryCheckTimer === 0) {
      scheduleSummaryCheck();
    }
  }

  function scheduleSummaryCheck() {
    clearTimeout(summaryCheckTimer);
    summaryCheckTimer = setTimeout(checkPage, SUMMARY_CHECK_INTERVAL_MS);
  }

  /**
   * Another address is another page: a bar closed with × comes back, and its
   * summary is made anew. The bar shows once the page has enough text.
   */
  function checkPage() {
    summaryCheckTimer = 0;
    if (!isExtensionAlive()) {
      teardown();
      return;
    }
    const url = getPageUrl();
    if (url !== summaryPageUrl) {
      summaryPageUrl = url;
      summaryWatchUntil = Date.now() + SUMMARY_WATCH_MS;
      summaryDismissed = false;
      pageSummary = null;
      closeSummary();
    }
    if (summaryDismissed || (ui && !ui.pill.hidden) || Date.now() > summaryWatchUntil || !document.body) {
      return;
    }
    if (readPageText(SUMMARY_OFFER_MIN_LENGTH).length >= SUMMARY_OFFER_MIN_LENGTH) {
      ensureUi().pill.hidden = false;
      renderSummaryButton();
    }
  }

  function onPageReady() {
    watchPage();
  }

  /** Hides the summary; one on its way is dropped when it arrives. */
  function closeSummary() {
    summarySeq += 1;
    summaryLoading = false;
    if (ui) {
      ui.summaryBox.hidden = true;
      renderSummaryButton();
    }
  }

  /** Hides the bar and its summary. */
  function hideSummaryBar() {
    closeSummary();
    if (ui) {
      ui.pill.hidden = true;
    }
  }

  /**
   * Summarizes the page. A summary already made for this page is shown again
   * without a request.
   */
  async function summarize() {
    const { summaryBox, summaryBody } = ensureUi();
    if (pageSummary !== null) {
      setPanelText(summaryBox, summaryBody, pageSummary, 'answer');
      return;
    }
    const text = trimPageText(readPageText(MAX_PAGE_SCAN_LENGTH), MAX_PAGE_TEXT_LENGTH);
    if (text.length < MIN_PAGE_TEXT_LENGTH) {
      setPanelText(summaryBox, summaryBody, 'There is not enough text on this page to summarize.', 'error');
      return;
    }
    const seq = ++summarySeq;
    summaryLoading = true;
    renderSummaryButton();
    setPanelLoading(summaryBox, summaryBody, 'Summarizing');

    /** @type {unknown} */
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.SUMMARIZE_PAGE,
        title: normalizeSelection(document.title).slice(0, MAX_PAGE_TITLE_LENGTH),
        text,
      });
    } catch {
      // Extension was reloaded or removed: this script is orphaned.
      teardown();
      return;
    }
    if (seq !== summarySeq) {
      return;
    }
    summaryLoading = false;
    renderSummaryButton();
    const panel = ensureUi();
    const result = /** @type {{ kind?: unknown, text?: unknown, message?: unknown } | null | undefined} */ (response);
    if (result?.kind === 'answer' && typeof result.text === 'string' && result.text.length <= MAX_SUMMARY_LENGTH) {
      pageSummary = result.text;
      setPanelText(panel.summaryBox, panel.summaryBody, result.text, 'answer');
    } else if (result?.kind === 'error' && typeof result.message === 'string') {
      setPanelText(panel.summaryBox, panel.summaryBody, result.message, 'error');
    } else {
      closeSummary();
    }
  }

  /**
   * Summarizes the page, or hides the summary when it is shown.
   * @param {MouseEvent} event
   */
  function onSummarizeClick(event) {
    if (!event.isTrusted || !ui) {
      return;
    }
    if (!ui.summaryBox.hidden) {
      closeSummary();
    } else {
      void summarize();
    }
  }

  /** @param {MouseEvent} event */
  function onPillCloseClick(event) {
    if (!event.isTrusted) {
      return;
    }
    summaryDismissed = true;
    hideSummaryBar();
  }

  // ---------------------------------------------------------------------------
  // Selection handling
  // ---------------------------------------------------------------------------

  /**
   * Selections in form fields and editors are ignored: they usually hold
   * the user's own (possibly private) input, and a button there would get
   * in the way of editing.
   * @returns {boolean}
   */
  function isEditableContext() {
    if (document.designMode === 'on') {
      return true;
    }
    const active = document.activeElement;
    if (
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLSelectElement ||
      (active instanceof HTMLElement && active.isContentEditable)
    ) {
      return true;
    }
    const anchor = document.getSelection()?.anchorNode ?? null;
    const element = anchor instanceof Element ? anchor : anchor?.parentElement ?? null;
    return Boolean(element && (element.isContentEditable || element.closest('input, textarea')));
  }

  /**
   * @param {string} raw
   * @returns {string}
   */
  function normalizeSelection(raw) {
    return raw
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Same filter as isAnswerableText() in constants.js; the background
   * re-checks everything. Skips single words/tokens and mostly numeric text,
   * so the button does not pop up on every double-click.
   * @param {string} text Normalized text.
   * @returns {boolean}
   */
  function isAnswerableText(text) {
    if (text.length < MIN_SELECTION_LENGTH || text.length > MAX_SELECTION_LENGTH) {
      return false;
    }
    if (!/\s/.test(text) || !/\p{L}{2}/u.test(text)) {
      return false;
    }
    const digitCount = text.match(/\d/g)?.length ?? 0;
    return digitCount / text.length <= 0.5;
  }

  /** @returns {SelectionCandidate | null} */
  function readSelectionCandidate() {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0 || isEditableContext()) {
      return null;
    }
    const raw = selection.toString();
    if (raw.length > MAX_SELECTION_LENGTH * 2) {
      return null;
    }
    const text = normalizeSelection(raw);
    if (!isAnswerableText(text)) {
      return null;
    }
    return { text, range: selection.getRangeAt(0).cloneRange() };
  }

  function refreshActions() {
    const next = enabled && askEnabled ? readSelectionCandidate() : null;
    if (next) {
      showActions(next);
    } else {
      hideActions();
    }
  }

  // ---------------------------------------------------------------------------
  // Asking
  // ---------------------------------------------------------------------------

  /**
   * Sends the text to the background worker and renders the result.
   * Responses to superseded requests are dropped.
   * @param {string} text
   */
  async function ask(text) {
    if (ui && !ui.box.hidden && text === lastAskedText) {
      return;
    }
    const seq = ++requestSeq;
    lastAskedText = text;
    showLoading();

    /** @type {unknown} */
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.ANSWER_SELECTION, text });
    } catch {
      // Extension was reloaded or removed: this script is orphaned.
      teardown();
      return;
    }
    if (seq === requestSeq) {
      renderResult(response);
    }
  }

  /** Handles the keyboard shortcut (relayed by the background worker); off with the Ask switch. */
  function askCurrentSelection() {
    if (!enabled || !askEnabled) {
      return;
    }
    const next = readSelectionCandidate();
    hideActions();
    if (next) {
      void ask(next.text);
    } else {
      showError('Select a question on the page first (at least two words).');
    }
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  /**
   * @param {Event} event
   * @returns {boolean} Whether the event happened inside the extension UI.
   */
  function isFromUi(event) {
    return ui !== null && event.composedPath().includes(ui.host);
  }

  /** @param {PointerEvent} event */
  function onPointerUp(event) {
    if (!isExtensionAlive()) {
      teardown();
      return;
    }
    if (event.isTrusted && !isFromUi(event)) {
      // Let the browser finish updating the selection first.
      setTimeout(refreshActions, 0);
    }
  }

  /** @param {KeyboardEvent} event */
  function onKeyUp(event) {
    if (!isExtensionAlive()) {
      teardown();
      return;
    }
    const selectsText =
      event.key === 'Shift' ||
      event.shiftKey ||
      ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a');
    if (event.isTrusted && selectsText && !isFromUi(event)) {
      setTimeout(refreshActions, 0);
    }
  }

  /** @param {KeyboardEvent} event */
  function onKeyDown(event) {
    if (event.key !== 'Escape') {
      return;
    }
    if (ui && (!ui.box.hidden || !ui.actions.hidden)) {
      hideActions();
      closePanel();
    }
    if (ui && !ui.summaryBox.hidden) {
      closeSummary();
    }
    cancelDictation();
  }

  /**
   * Shows the dictation button below a text field the user moved into.
   * @param {FocusEvent} event
   */
  function onFocusIn(event) {
    if (!event.isTrusted || isFromUi(event) || dictationState !== 'idle') {
      return;
    }
    const field = enabled && dictationEnabled ? getDictationField(event.composedPath()[0]) : null;
    if (field) {
      showDictation(field);
    } else {
      hideDictation();
    }
  }

  /** @param {FocusEvent} event */
  function onFocusOut(event) {
    if (!event.isTrusted || !dictationField) {
      return;
    }
    // The next element (if any) gets the focus after this event.
    setTimeout(() => {
      if (dictationField && !dictationField.matches(':focus')) {
        hideDictation();
      }
    }, 0);
  }

  /** The microphone never keeps recording for a tab in the background. */
  function onVisibilityChange() {
    if (document.hidden) {
      cancelDictation();
    }
  }

  function onSelectionChange() {
    if (candidate && document.getSelection()?.isCollapsed !== false) {
      hideActions();
    }
  }

  function onViewportChange() {
    if ((candidate || dictationField) && repositionFrame === 0) {
      repositionFrame = requestAnimationFrame(() => {
        repositionFrame = 0;
        positionActions();
        positionDictation();
      });
    }
  }

  /**
   * Handles messages from the extension itself (ping, shortcut relay).
   * Messages from tabs are ignored.
   * @param {unknown} message
   * @param {chrome.runtime.MessageSender} sender
   * @param {(response: { active: boolean }) => void} sendResponse
   * @returns {false}
   */
  function onRuntimeMessage(message, sender, sendResponse) {
    if (sender.id !== chrome.runtime.id || sender.tab) {
      return false;
    }
    const type = typeof message === 'object' && message !== null ? /** @type {{ type?: unknown }} */ (message).type : null;
    if (type === MESSAGE_TYPES.PING) {
      sendResponse({ active: true });
    } else if (type === MESSAGE_TYPES.ASK_SELECTION) {
      askCurrentSelection();
    }
    return false;
  }

  /**
   * Uses the theme picked in the side panel (or the default for anything else).
   * @param {unknown} value Stored theme name.
   */
  function setThemeSetting(value) {
    themeSetting = typeof value === 'string' && THEMES.includes(value) ? value : DEFAULT_THEME;
    applyTheme();
  }

  /**
   * @param {{ [key: string]: chrome.storage.StorageChange }} changes
   * @param {string} areaName
   */
  function onStorageChanged(changes, areaName) {
    if (areaName !== 'sync') {
      return;
    }
    if (THEME_KEY in changes) {
      setThemeSetting(changes[THEME_KEY].newValue);
    }
    if (ENABLED_KEY in changes) {
      enabled = changes[ENABLED_KEY].newValue !== false;
    }
    if (ASK_KEY in changes) {
      askEnabled = changes[ASK_KEY].newValue !== false;
    }
    if ((ENABLED_KEY in changes || ASK_KEY in changes) && !(enabled && askEnabled)) {
      hideActions();
      closePanel();
    }
    if (DICTATION_KEY in changes) {
      dictationEnabled = changes[DICTATION_KEY].newValue === true;
    }
    if ((ENABLED_KEY in changes || DICTATION_KEY in changes) && !(enabled && dictationEnabled)) {
      cancelDictation();
      hideDictation();
    }
    if (SUMMARY_KEY in changes) {
      summaryEnabled = changes[SUMMARY_KEY].newValue !== false;
    }
    // Switching it on in the side panel offers it on open pages too, even where it was closed.
    if (ENABLED_KEY in changes || SUMMARY_KEY in changes) {
      if (enabled && summaryEnabled) {
        summaryDismissed = false;
        watchPage();
      } else {
        stopWatchingPage();
        hideSummaryBar();
      }
    }
  }

  /** Removes this copy's UI and stops it for good (orphaned or replaced). */
  function teardown() {
    cancelDictation();
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('focusin', onFocusIn, true);
    window.removeEventListener('focusout', onFocusOut, true);
    window.removeEventListener('scroll', onViewportChange, true);
    window.removeEventListener('resize', onViewportChange);
    document.removeEventListener('selectionchange', onSelectionChange);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.removeEventListener(TAKEOVER_EVENT, teardown);
    document.removeEventListener('DOMContentLoaded', onPageReady);
    try {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
      chrome.storage.onChanged.removeListener(onStorageChanged);
    } catch {
      // Already cut off from the extension.
    }
    staleHostObserver?.disconnect();
    staleHostObserver = null;
    cancelAnimationFrame(repositionFrame);
    stopWatchingPage();
    // Drops answers and summaries still on their way.
    requestSeq += 1;
    summarySeq += 1;
    ui?.host.remove();
    ui = null;
    candidate = null;
    dictationField = null;
  }

  function init() {
    takeOverOldCopies();
    // Registered at document_start on window/capture, so these run before
    // page listeners and cannot be swallowed by the page.
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('focusin', onFocusIn, true);
    window.addEventListener('focusout', onFocusOut, true);
    window.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
    window.addEventListener('resize', onViewportChange, { passive: true });
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('visibilitychange', onVisibilityChange);
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    chrome.storage.onChanged.addListener(onStorageChanged);
    chrome.storage.sync
      .get([ENABLED_KEY, THEME_KEY, ASK_KEY, DICTATION_KEY, SUMMARY_KEY])
      .then((stored) => {
        enabled = stored[ENABLED_KEY] !== false;
        askEnabled = stored[ASK_KEY] !== false;
        dictationEnabled = stored[DICTATION_KEY] === true;
        summaryEnabled = stored[SUMMARY_KEY] !== false;
        setThemeSetting(stored[THEME_KEY]);
        if (loadedFresh) {
          if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', onPageReady, { once: true });
          } else {
            onPageReady();
          }
        }
      })
      .catch(() => {
        enabled = false;
      });
  }

  init();
})();
