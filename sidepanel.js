/**
 * Side panel. Until an AI provider is set up, it shows only the provider
 * setup: a Material 3 onboarding flow in three steps (1. the provider, Groq by
 * default; 2. the connection: the API key, and the endpoint for Custom and
 * servers on this computer, checked with the provider, and how long to wait
 * for answers; 3. the models, picked from those the provider lists or typed
 * as their IDs). Once one is set up: the on/off switch, a
 * menu that picks the view (Ask, the switch for the Ask bar on pages; the
 * Knowledge text sent with every question; Voice, the dictation switch and
 * the microphone permission; Summary, the switch for the Summarize bar on
 * pages), a reset button (removes the provider and its key, after a dialog
 * confirms, and opens the setup again), a help popup about the view shown and a
 * settings popup with the theme (light, dark or Chrome's), the language the
 * AI answers and dictation write in (the panel itself stays in English) and
 * the AI provider, with the button that opens the setup again to change it or
 * remove the key. The panel stays open while you browse, so it follows
 * changes made elsewhere (the panel in another window).
 *
 * The Knowledge text and its switch, and the code of the language, are
 * written here, to chrome.storage.local (locked to trusted contexts); the
 * background worker reads them when it asks. The provider is checked and
 * saved by the background worker (provider.js): this panel sends what was
 * typed (PROVIDER_CHECK, PROVIDER_SAVE) and reads back only what is not
 * secret. The API key is never read back, shown or stored here. Text is
 * rendered as text nodes only.
 */

import {
  DEFAULT_ANSWER_TIMEOUT_SECONDS,
  DEFAULT_THEME,
  LANGUAGES,
  MAX_ANSWER_TIMEOUT_SECONDS,
  MAX_API_KEY_LENGTH,
  MAX_ENDPOINT_LENGTH,
  MAX_MODEL_LENGTH,
  MAX_REFERENCE_LENGTH,
  MESSAGE_TYPES,
  MICROPHONE_PAGE_PATH,
  MIN_ANSWER_TIMEOUT_SECONDS,
  PROVIDER_PRESETS,
  STORAGE_KEYS,
  THEMES,
  checkEndpoint,
  findPresetById,
  getDefaultPreset,
  getLanguage,
  getReferenceText,
  getTheme,
  isReferenceEnabled,
  isSupportedLanguage,
  isSupportedTheme,
  isValidAnswerTimeout,
  isValidApiKey,
  isValidModel,
  normalizeReferenceText,
  parseProviderSettings,
} from './constants.js';

/** @typedef {import('./constants.js').Language} Language */
/** @typedef {import('./constants.js').ProviderPreset} ProviderPreset */
/** @typedef {import('./constants.js').ProviderResult} ProviderResult */
/** @typedef {import('./constants.js').ProviderSettings} ProviderSettings */

/**
 * What the panel shows: "required", the setup, as no provider is set up;
 * "editing", the setup opened from settings; "ready", the panel itself.
 * @typedef {'required' | 'editing' | 'ready'} SetupState
 */

/**
 * A text field of the setup: its container (which shows the error state),
 * input and supporting text.
 * @typedef {object} SetupField
 * @property {HTMLElement} field
 * @property {HTMLInputElement} input
 * @property {HTMLElement} support
 */

/**
 * @typedef {object} PanelElements
 * @property {HTMLElement} setupTitle
 * @property {HTMLButtonElement} setupClose
 * @property {HTMLElement} setupProgress
 * @property {HTMLFormElement} providerForm
 * @property {HTMLElement} setupScroll
 * @property {HTMLElement[]} setupSteps The three steps, in order.
 * @property {HTMLElement} providerChoices
 * @property {HTMLElement} connectTitle
 * @property {HTMLElement} connectText
 * @property {HTMLElement} endpointInfo
 * @property {HTMLElement} endpointInfoValue
 * @property {SetupField} endpoint
 * @property {SetupField} key
 * @property {HTMLElement} keyLabel
 * @property {HTMLButtonElement} keyToggle
 * @property {HTMLAnchorElement} keyLink
 * @property {HTMLElement} keyLinkLabel
 * @property {HTMLButtonElement} removeButton
 * @property {SetupField} timeout
 * @property {SetupField} chatModel
 * @property {HTMLUListElement} chatModelList
 * @property {SetupField} transcriptionModel
 * @property {HTMLUListElement} transcriptionModelList
 * @property {HTMLParagraphElement} providerStatus
 * @property {HTMLButtonElement} backButton
 * @property {HTMLButtonElement} nextButton
 * @property {HTMLDialogElement} removeDialog
 * @property {HTMLButtonElement} removeCancel
 * @property {HTMLButtonElement} removeConfirm
 * @property {HTMLElement} snackbar
 * @property {HTMLElement} snackbarText
 * @property {HTMLInputElement} enabledToggle
 * @property {HTMLDivElement} menu
 * @property {HTMLInputElement[]} menuInputs In the order of VIEWS.
 * @property {HTMLElement[]} views In the order of VIEWS.
 * @property {HTMLInputElement} askToggle
 * @property {HTMLInputElement} knowledgeToggle
 * @property {HTMLTextAreaElement} knowledgeInput
 * @property {HTMLSpanElement} knowledgeStatus
 * @property {HTMLSpanElement} knowledgeCount
 * @property {HTMLInputElement} dictationToggle
 * @property {HTMLSpanElement} micStatus
 * @property {HTMLButtonElement} micAllow
 * @property {HTMLParagraphElement} voiceModelNote
 * @property {HTMLInputElement} summaryToggle
 * @property {HTMLButtonElement} resetButton
 * @property {HTMLDivElement} footerActions The help and settings buttons.
 * @property {HTMLDivElement} helpPopover
 * @property {HTMLElement[]} helps The help for each view, in the order of VIEWS.
 * @property {HTMLDivElement} settingsPopover
 * @property {HTMLFieldSetElement} themePicker
 * @property {HTMLInputElement[]} themeInputs
 * @property {HTMLInputElement} languageInput
 * @property {HTMLUListElement} languageList
 * @property {HTMLSpanElement} providerName
 * @property {HTMLSpanElement} providerDetail
 * @property {HTMLSpanElement} providerKeyStatus
 * @property {HTMLButtonElement} providerEditButton
 */

/**
 * Views picked in the menu; each is the <section id="view-…"> of that name,
 * with its help in <section id="help-…">.
 */
const VIEWS = Object.freeze(['ask', 'knowledge', 'voice', 'summary']);

/** The Knowledge text is saved this long after the last keystroke. */
const KNOWLEDGE_SAVE_DELAY_MS = 400;
/** @type {Readonly<Record<string, string>>} The microphone permission, per state. */
const MICROPHONE_STATUS = Object.freeze({
  granted: 'Allowed',
  prompt: 'Not allowed yet',
  denied: 'Blocked in Chrome',
});
/** Space between the account bar (help and settings buttons) and the popups. */
const POPOVER_GAP_PX = 16;
/** Smallest space between a popup and the panel's edges. */
const POPOVER_EDGE_PX = 8;
/** A popup is at most this share of the panel's height; beyond it, it scrolls. */
const POPOVER_MAX_HEIGHT_SHARE = 0.6;
/**
 * @type {Language} The first choice in the language field: no language set.
 * The AI answers in the language of the text and dictation detects the
 * language it hears; nothing is stored or sent. Its "English name" is the
 * hint shown next to it in the suggestions.
 */
const AUTOMATIC_LANGUAGE = Object.freeze({ code: '', name: 'Automatic', englishName: 'Same as the text' });
/** @type {readonly Language[]} Everything the language field offers, in the order of the suggestions. */
const LANGUAGE_CHOICES = Object.freeze([AUTOMATIC_LANGUAGE, ...LANGUAGES]);
/** The language field suggests at most this many languages at a time. */
const MAX_LANGUAGE_SUGGESTIONS = 5;
/**
 * localStorage copy of the theme, read synchronously on load so the panel
 * does not flash the other mode. chrome.storage.sync stays the source.
 */
const THEME_CACHE_KEY = 'theme';

/** The language set in settings, as last read from storage or picked here. */
let pickedLanguage = AUTOMATIC_LANGUAGE;
/** @type {Language[]} Suggestions under the language field; empty while the list is closed. */
let languageSuggestions = [];
/** The highlighted suggestion (Enter or leaving the field picks it), or -1. */
let languageHighlight = -1;
/** Whether the language field holds text typed since the last pick (not the name of the language set). */
let languageEdited = false;
/** Pending save of the Knowledge text; 0 when there is none. */
let knowledgeSaveTimer = 0;

/**
 * Looks up a required element and checks its type.
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

/**
 * Looks up a required part of an element.
 * @template {Element} T
 * @param {ParentNode} root
 * @param {string} selector
 * @param {new (...args: any[]) => T} type
 * @returns {T}
 */
function getRequiredPart(root, selector, type) {
  const element = root.querySelector(selector);
  if (!(element instanceof type)) {
    throw new Error(`Missing or invalid part: ${selector}`);
  }
  return element;
}

/**
 * @param {HTMLFieldSetElement} fieldset
 * @param {string} name
 * @param {number} count How many there must be.
 * @returns {HTMLInputElement[]}
 */
function getRadioInputs(fieldset, name, count) {
  const inputs = [...fieldset.querySelectorAll(`input[name="${name}"]`)].filter(
    (input) => input instanceof HTMLInputElement,
  );
  if (inputs.length !== count) {
    throw new Error(`Missing ${name} options`);
  }
  return inputs;
}

/**
 * @param {string} fieldId The text field's container.
 * @param {string} inputId
 * @param {string} supportId Its supporting text.
 * @returns {SetupField}
 */
function getSetupField(fieldId, inputId, supportId) {
  return {
    field: getRequiredElement(fieldId, HTMLElement),
    input: getRequiredElement(inputId, HTMLInputElement),
    support: getRequiredElement(supportId, HTMLElement),
  };
}

/** @returns {PanelElements} */
function getElements() {
  const menu = getRequiredElement('menu', HTMLDivElement);
  const themePicker = getRequiredElement('theme-picker', HTMLFieldSetElement);
  return {
    setupTitle: getRequiredElement('setup-title', HTMLElement),
    setupClose: getRequiredElement('setup-close', HTMLButtonElement),
    setupProgress: getRequiredElement('setup-progress', HTMLElement),
    providerForm: getRequiredElement('provider-form', HTMLFormElement),
    setupScroll: getRequiredElement('setup-scroll', HTMLElement),
    setupSteps: ['provider', 'connect', 'models'].map((step) => getRequiredElement(`setup-step-${step}`, HTMLElement)),
    providerChoices: getRequiredElement('provider-choices', HTMLElement),
    connectTitle: getRequiredElement('step-connect-title', HTMLElement),
    connectText: getRequiredElement('step-connect-text', HTMLElement),
    endpointInfo: getRequiredElement('endpoint-info', HTMLElement),
    endpointInfoValue: getRequiredElement('endpoint-info-value', HTMLElement),
    endpoint: getSetupField('endpoint-field', 'provider-endpoint', 'provider-endpoint-support'),
    key: getSetupField('key-field', 'provider-key', 'provider-key-support'),
    keyLabel: getRequiredElement('provider-key-label', HTMLElement),
    keyToggle: getRequiredElement('provider-key-toggle', HTMLButtonElement),
    keyLink: getRequiredElement('provider-key-link', HTMLAnchorElement),
    keyLinkLabel: getRequiredElement('provider-key-link-label', HTMLElement),
    removeButton: getRequiredElement('provider-remove', HTMLButtonElement),
    timeout: getSetupField('timeout-field', 'provider-timeout', 'provider-timeout-support'),
    chatModel: getSetupField('chat-model-field', 'provider-chat-model', 'chat-model-support'),
    chatModelList: getRequiredElement('chat-model-list', HTMLUListElement),
    transcriptionModel: getSetupField(
      'transcription-model-field',
      'provider-transcription-model',
      'transcription-model-support',
    ),
    transcriptionModelList: getRequiredElement('transcription-model-list', HTMLUListElement),
    providerStatus: getRequiredElement('provider-status', HTMLParagraphElement),
    backButton: getRequiredElement('setup-back', HTMLButtonElement),
    nextButton: getRequiredElement('setup-next', HTMLButtonElement),
    removeDialog: getRequiredElement('remove-dialog', HTMLDialogElement),
    removeCancel: getRequiredElement('remove-cancel', HTMLButtonElement),
    removeConfirm: getRequiredElement('remove-confirm', HTMLButtonElement),
    snackbar: getRequiredElement('snackbar', HTMLElement),
    snackbarText: getRequiredElement('snackbar-text', HTMLElement),
    enabledToggle: getRequiredElement('enabled', HTMLInputElement),
    menu,
    menuInputs: VIEWS.map((view) => getRequiredPart(menu, `input[name="view"][value="${view}"]`, HTMLInputElement)),
    views: VIEWS.map((view) => getRequiredElement(`view-${view}`, HTMLElement)),
    askToggle: getRequiredElement('ask-enabled', HTMLInputElement),
    knowledgeToggle: getRequiredElement('knowledge-enabled', HTMLInputElement),
    knowledgeInput: getRequiredElement('knowledge-text', HTMLTextAreaElement),
    knowledgeStatus: getRequiredElement('knowledge-status', HTMLSpanElement),
    knowledgeCount: getRequiredElement('knowledge-count', HTMLSpanElement),
    dictationToggle: getRequiredElement('dictation-enabled', HTMLInputElement),
    micStatus: getRequiredElement('mic-status', HTMLSpanElement),
    micAllow: getRequiredElement('mic-allow', HTMLButtonElement),
    voiceModelNote: getRequiredElement('voice-model-note', HTMLParagraphElement),
    summaryToggle: getRequiredElement('summary-enabled', HTMLInputElement),
    resetButton: getRequiredElement('reset', HTMLButtonElement),
    footerActions: getRequiredElement('footer-actions', HTMLDivElement),
    helpPopover: getRequiredElement('help-popover', HTMLDivElement),
    helps: VIEWS.map((view) => getRequiredElement(`help-${view}`, HTMLElement)),
    settingsPopover: getRequiredElement('settings-popover', HTMLDivElement),
    themePicker,
    themeInputs: getRadioInputs(themePicker, 'theme', THEMES.length),
    languageInput: getRequiredElement('language-input', HTMLInputElement),
    languageList: getRequiredElement('language-list', HTMLUListElement),
    providerName: getRequiredElement('provider-name', HTMLSpanElement),
    providerDetail: getRequiredElement('provider-detail', HTMLSpanElement),
    providerKeyStatus: getRequiredElement('provider-key-status', HTMLSpanElement),
    providerEditButton: getRequiredElement('provider-edit', HTMLButtonElement),
  };
}

// -----------------------------------------------------------------------------
// Menu
// -----------------------------------------------------------------------------

/**
 * Shows the view of the checked menu button, and its part of the help, and
 * hides the others. Also run on load, since Chrome can restore another button
 * than the HTML checks.
 * @param {PanelElements} elements
 */
function renderView(elements) {
  const index = Math.max(0, elements.menuInputs.findIndex((input) => input.checked));
  elements.menuInputs[index].checked = true;
  VIEWS.forEach((_, viewIndex) => {
    elements.views[viewIndex].hidden = viewIndex !== index;
    elements.helps[viewIndex].hidden = viewIndex !== index;
  });
}

// -----------------------------------------------------------------------------
// Help and settings popups
// -----------------------------------------------------------------------------

/**
 * Places a popup above the help and settings buttons, right-aligned with
 * them, and no taller than 60% of the panel or the space above them (it
 * scrolls beyond that, without a scrollbar). Popovers sit in the top layer
 * with fixed positioning.
 * @param {PanelElements} elements
 * @param {HTMLElement} popover
 */
function positionPopover(elements, popover) {
  const anchor = elements.footerActions.getBoundingClientRect();
  const { clientWidth, clientHeight } = document.documentElement;
  const maxHeight = Math.min(clientHeight * POPOVER_MAX_HEIGHT_SHARE, anchor.top - POPOVER_GAP_PX - POPOVER_EDGE_PX);
  popover.style.setProperty('right', `${Math.max(POPOVER_EDGE_PX, Math.round(clientWidth - anchor.right))}px`);
  popover.style.setProperty('bottom', `${Math.round(clientHeight - anchor.top + POPOVER_GAP_PX)}px`);
  popover.style.setProperty('max-height', `${Math.max(0, Math.round(maxHeight))}px`);
}

/** @param {PanelElements} elements */
function bindPopovers(elements) {
  for (const popover of [elements.helpPopover, elements.settingsPopover]) {
    popover.addEventListener('beforetoggle', (event) => {
      if (/** @type {ToggleEvent} */ (event).newState === 'open') {
        positionPopover(elements, popover);
      }
    });
    // A popup that scrolls opens at its top again.
    popover.addEventListener('toggle', (event) => {
      if (/** @type {ToggleEvent} */ (event).newState === 'open') {
        popover.scrollTop = 0;
      }
    });
  }
}

/** @param {PanelElements} elements */
function closePopovers(elements) {
  for (const popover of [elements.helpPopover, elements.settingsPopover]) {
    if (popover.matches(':popover-open')) {
      popover.hidePopover();
    }
  }
}

// -----------------------------------------------------------------------------
// Theme
// -----------------------------------------------------------------------------

/**
 * Switches the panel to light or dark, or back to following Chrome
 * ("system": no data-theme, so styles.css uses Chrome's mode).
 * @param {string} theme A supported theme name.
 */
function applyTheme(theme) {
  if (theme === 'system') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
  try {
    localStorage.setItem(THEME_CACHE_KEY, theme);
  } catch {
    // Storage can be unavailable; the theme still changes.
  }
}

/** @returns {string} The theme last used in this panel, or the default. */
function readCachedTheme() {
  try {
    const theme = localStorage.getItem(THEME_CACHE_KEY);
    return isSupportedTheme(theme) ? theme : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** @param {PanelElements} elements */
function bindSettingsPopover(elements) {
  // Keyboard users land on the current theme; arrow keys pick another.
  elements.settingsPopover.addEventListener('toggle', (event) => {
    if (/** @type {ToggleEvent} */ (event).newState === 'open') {
      (elements.themeInputs.find((input) => input.checked) ?? elements.themeInputs[0]).focus();
    }
  });
  elements.themePicker.addEventListener('change', (event) => {
    const input = event.target;
    const theme = input instanceof HTMLInputElement ? input.value : null;
    if (!isSupportedTheme(theme)) {
      return;
    }
    applyTheme(theme);
    chrome.storage.sync.set({ [STORAGE_KEYS.THEME]: theme }).catch(() => refreshSettings(elements));
  });
}

// -----------------------------------------------------------------------------
// Language (in the settings popup): the language the AI answers and dictation
// write in. Only its code is stored; the panel stays in English.
// -----------------------------------------------------------------------------

/**
 * @param {string} text
 * @returns {string} Lowercase, without accents or outer spaces, for matching.
 */
function normalizeLanguageText(text) {
  return text.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();
}

/**
 * @param {string} text
 * @returns {Language[]} The choices whose name (in itself or in English)
 *   starts with the text, then those that only contain it, Automatic and the
 *   most used first.
 */
function findLanguages(text) {
  const query = normalizeLanguageText(text);
  const names = (/** @type {Language} */ language) => [language.name, language.englishName].map(normalizeLanguageText);
  const starting = LANGUAGE_CHOICES.filter((language) => names(language).some((name) => name.startsWith(query)));
  const containing = LANGUAGE_CHOICES.filter(
    (language) => !starting.includes(language) && names(language).some((name) => name.includes(query)),
  );
  return [...starting, ...containing];
}

/**
 * @param {string} text
 * @returns {Language | undefined} The choice named exactly so: in itself, in
 *   English or by its code (an empty text names none).
 */
function matchLanguage(text) {
  const query = normalizeLanguageText(text);
  return LANGUAGE_CHOICES.find((language) =>
    [language.name, language.englishName, language.code].some(
      (name) => name !== '' && normalizeLanguageText(name) === query,
    ),
  );
}

/**
 * Shows the suggestions under the language field with the highlighted one
 * marked and scrolled into view, or closes the list when there are none.
 * Names are rendered as text nodes only.
 * @param {PanelElements} elements
 */
function renderLanguageSuggestions(elements) {
  const { languageInput, languageList } = elements;
  const wasOpen = !languageList.hidden;
  languageList.replaceChildren(
    ...languageSuggestions.map((language, index) => {
      const option = document.createElement('li');
      option.id = `language-option-${language.code || 'automatic'}`;
      option.className = 'language-option';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === languageHighlight));
      option.dataset.index = String(index);
      const name = document.createElement('span');
      name.className = 'language-name';
      // Automatic is in English, like the panel.
      if (language.code !== '') {
        name.lang = language.code;
      }
      name.textContent = language.name;
      option.append(name);
      if (language.englishName !== language.name) {
        const englishName = document.createElement('span');
        englishName.className = 'language-english';
        englishName.textContent = language.englishName;
        option.append(englishName);
      }
      return option;
    }),
  );
  const open = languageSuggestions.length > 0;
  languageList.hidden = !open;
  languageInput.setAttribute('aria-expanded', String(open));
  if (open && !wasOpen) {
    languageList.scrollIntoView({ block: 'nearest' });
  }
  const highlighted = languageList.children[languageHighlight];
  if (highlighted) {
    languageInput.setAttribute('aria-activedescendant', highlighted.id);
    highlighted.scrollIntoView({ block: 'nearest' });
  } else {
    languageInput.removeAttribute('aria-activedescendant');
  }
}

/**
 * Opens the suggestions for the text (the most used languages when it is
 * empty), with one highlighted (-1 for none, past the end for the last).
 * @param {PanelElements} elements
 * @param {string} text
 * @param {number} highlight
 */
function showLanguageSuggestions(elements, text, highlight) {
  languageSuggestions = findLanguages(text).slice(0, MAX_LANGUAGE_SUGGESTIONS);
  languageHighlight = Math.min(highlight, languageSuggestions.length - 1);
  renderLanguageSuggestions(elements);
}

/** @param {PanelElements} elements */
function closeLanguageSuggestions(elements) {
  languageSuggestions = [];
  languageHighlight = -1;
  renderLanguageSuggestions(elements);
}

/**
 * Picks the highlighted suggestion, else the choice the typed text names
 * exactly (Automatic for an emptied field), else keeps the language set: text
 * that names no language, or a field left without typing, never changes it.
 * Shows its name in the field, closes the list and saves a change.
 * @param {PanelElements} elements
 */
function commitLanguage(elements) {
  const text = elements.languageInput.value;
  const typed = languageEdited ? (text.trim() === '' ? AUTOMATIC_LANGUAGE : matchLanguage(text)) : undefined;
  const picked = languageSuggestions[languageHighlight] ?? typed ?? pickedLanguage;
  languageEdited = false;
  elements.languageInput.value = picked.name;
  closeLanguageSuggestions(elements);
  if (picked !== pickedLanguage) {
    pickedLanguage = picked;
    void saveLanguage(elements);
  }
}

/**
 * Saves the language set: only its code from the fixed list, never the text
 * typed in the field; Automatic removes it. When it cannot be saved, the
 * stored one shows again.
 * @param {PanelElements} elements
 */
async function saveLanguage(elements) {
  const { code } = pickedLanguage;
  try {
    if (isSupportedLanguage(code)) {
      await chrome.storage.local.set({ [STORAGE_KEYS.LANGUAGE]: code });
    } else {
      await chrome.storage.local.remove(STORAGE_KEYS.LANGUAGE);
    }
  } catch {
    refreshLanguage(elements);
  }
}

/**
 * Shows the language set (Automatic when none is), also when it was changed
 * in another window. The field is left alone while the user is typing in it,
 * so a change coming back never replaces what is typed.
 * @param {PanelElements} elements
 */
async function loadLanguage(elements) {
  const code = getLanguage(await chrome.storage.local.get(STORAGE_KEYS.LANGUAGE));
  pickedLanguage = LANGUAGES.find((language) => language.code === code) ?? AUTOMATIC_LANGUAGE;
  if (!languageEdited) {
    elements.languageInput.value = pickedLanguage.name;
  }
}

/** @param {PanelElements} elements */
function refreshLanguage(elements) {
  loadLanguage(elements).catch(() => {});
}

/**
 * The language field: a combobox with list autocomplete. Typing suggests
 * matching languages (the first one highlighted), the arrow keys move the
 * highlight, Enter, a click or leaving the field picks (and saves), Esc
 * closes the list.
 * @param {PanelElements} elements
 */
function bindLanguage(elements) {
  const { languageInput, languageList } = elements;
  languageInput.value = pickedLanguage.name;

  // Typing replaces the name shown; a click also shows the most used languages.
  languageInput.addEventListener('focus', () => languageInput.select());
  languageInput.addEventListener('click', () => {
    if (languageSuggestions.length === 0) {
      showLanguageSuggestions(elements, '', -1);
      languageInput.select();
    }
  });
  languageInput.addEventListener('input', () => {
    const text = languageInput.value;
    languageEdited = true;
    showLanguageSuggestions(elements, text, text.trim() === '' ? -1 : 0);
  });
  languageInput.addEventListener('keydown', (event) => {
    const open = languageSuggestions.length > 0;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const down = event.key === 'ArrowDown';
      if (!open) {
        showLanguageSuggestions(elements, '', down ? 0 : MAX_LANGUAGE_SUGGESTIONS);
        return;
      }
      const count = languageSuggestions.length;
      if (languageHighlight < 0) {
        languageHighlight = down ? 0 : count - 1;
      } else {
        languageHighlight = (languageHighlight + (down ? 1 : count - 1)) % count;
      }
      renderLanguageSuggestions(elements);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      commitLanguage(elements);
    } else if (event.key === 'Escape' && open) {
      // Closes only the list (not the popup) and puts the picked name back.
      event.preventDefault();
      languageEdited = false;
      languageInput.value = pickedLanguage.name;
      closeLanguageSuggestions(elements);
    }
  });
  languageInput.addEventListener('blur', () => commitLanguage(elements));

  // Keeps the focus in the field, so a click on a suggestion is not leaving it first.
  languageList.addEventListener('mousedown', (event) => event.preventDefault());
  languageList.addEventListener('click', (event) => {
    const option = event.target instanceof Element ? event.target.closest('.language-option') : null;
    if (option instanceof HTMLElement) {
      languageHighlight = Number(option.dataset.index);
      commitLanguage(elements);
    }
  });
}

// -----------------------------------------------------------------------------
// Switch
// -----------------------------------------------------------------------------

/**
 * Shows the stored switches and theme. Also used to undo a change that could
 * not be saved.
 * @param {PanelElements} elements
 */
async function renderSettings(elements) {
  const stored = await chrome.storage.sync.get([
    STORAGE_KEYS.ENABLED,
    STORAGE_KEYS.THEME,
    STORAGE_KEYS.ASK_ENABLED,
    STORAGE_KEYS.DICTATION_ENABLED,
    STORAGE_KEYS.SUMMARY_ENABLED,
  ]);
  elements.enabledToggle.checked = stored[STORAGE_KEYS.ENABLED] !== false;
  elements.askToggle.checked = stored[STORAGE_KEYS.ASK_ENABLED] !== false;
  elements.dictationToggle.checked = stored[STORAGE_KEYS.DICTATION_ENABLED] === true;
  elements.summaryToggle.checked = stored[STORAGE_KEYS.SUMMARY_ENABLED] !== false;
  const theme = getTheme(stored);
  applyTheme(theme);
  for (const input of elements.themeInputs) {
    input.checked = input.value === theme;
  }
}

/** @param {PanelElements} elements */
function refreshSettings(elements) {
  renderSettings(elements).catch(() => {});
}

// -----------------------------------------------------------------------------
// Ask
// -----------------------------------------------------------------------------

/** @param {PanelElements} elements */
function bindAsk(elements) {
  elements.askToggle.addEventListener('change', () => {
    chrome.storage.sync
      .set({ [STORAGE_KEYS.ASK_ENABLED]: elements.askToggle.checked })
      .catch(() => refreshSettings(elements));
  });
}

// -----------------------------------------------------------------------------
// Knowledge
// -----------------------------------------------------------------------------

/** @param {PanelElements} elements */
function renderKnowledgeCount(elements) {
  elements.knowledgeCount.textContent = `${elements.knowledgeInput.value.length} / ${MAX_REFERENCE_LENGTH}`;
}

/**
 * Shows the stored text and switch. The text is left alone while the user is
 * editing it, so a save coming back (normalized) never moves the cursor.
 * @param {PanelElements} elements
 */
async function loadKnowledge(elements) {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.REFERENCE_TEXT, STORAGE_KEYS.REFERENCE_ENABLED]);
  elements.knowledgeToggle.checked = isReferenceEnabled(stored);
  if (document.activeElement !== elements.knowledgeInput && knowledgeSaveTimer === 0) {
    elements.knowledgeInput.value = getReferenceText(stored);
    renderKnowledgeCount(elements);
  }
}

/** @param {PanelElements} elements */
function refreshKnowledge(elements) {
  loadKnowledge(elements).catch(() => {});
}

/**
 * Saves the text now, normalized and within the limit (the background worker
 * checks both again before sending it).
 * @param {PanelElements} elements
 */
async function saveKnowledge(elements) {
  clearTimeout(knowledgeSaveTimer);
  knowledgeSaveTimer = 0;
  const text = normalizeReferenceText(elements.knowledgeInput.value).slice(0, MAX_REFERENCE_LENGTH);
  let status = 'Saved';
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.REFERENCE_TEXT]: text });
  } catch {
    status = 'Could not save. Keep typing to try again.';
  }
  // A newer edit is already waiting: it keeps showing "Saving…".
  if (knowledgeSaveTimer === 0) {
    elements.knowledgeStatus.textContent = status;
  }
}

/**
 * Saves a waiting edit right away (the field lost focus or the panel closes).
 * @param {PanelElements} elements
 */
function flushKnowledge(elements) {
  if (knowledgeSaveTimer !== 0) {
    void saveKnowledge(elements);
  }
}

/** @param {PanelElements} elements */
function bindKnowledge(elements) {
  elements.knowledgeInput.maxLength = MAX_REFERENCE_LENGTH;
  renderKnowledgeCount(elements);
  elements.knowledgeInput.addEventListener('input', () => {
    renderKnowledgeCount(elements);
    elements.knowledgeStatus.textContent = 'Saving…';
    clearTimeout(knowledgeSaveTimer);
    knowledgeSaveTimer = setTimeout(() => void saveKnowledge(elements), KNOWLEDGE_SAVE_DELAY_MS);
  });
  elements.knowledgeInput.addEventListener('blur', () => flushKnowledge(elements));
  window.addEventListener('pagehide', () => flushKnowledge(elements));
  elements.knowledgeToggle.addEventListener('change', () => {
    chrome.storage.local
      .set({ [STORAGE_KEYS.REFERENCE_ENABLED]: elements.knowledgeToggle.checked })
      .catch(() => refreshKnowledge(elements));
  });
}

// -----------------------------------------------------------------------------
// Voice
// -----------------------------------------------------------------------------

/**
 * Shows whether the extension may use the microphone, and keeps it current.
 * Granting it happens on microphone.html: the side panel cannot show
 * Chrome's prompt.
 * @param {PanelElements} elements
 */
async function watchMicrophone(elements) {
  const permission = await navigator.permissions.query({ name: 'microphone' });
  const render = () => {
    elements.micStatus.textContent = MICROPHONE_STATUS[permission.state] ?? '';
    elements.micAllow.hidden = permission.state === 'granted';
  };
  permission.addEventListener('change', render);
  render();
}

/** @param {PanelElements} elements */
function bindVoice(elements) {
  elements.dictationToggle.addEventListener('change', () => {
    chrome.storage.sync
      .set({ [STORAGE_KEYS.DICTATION_ENABLED]: elements.dictationToggle.checked })
      .catch(() => refreshSettings(elements));
  });
  elements.micAllow.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL(MICROPHONE_PAGE_PATH) }).catch(() => {});
  });
  watchMicrophone(elements).catch(() => {});
}

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------

/** @param {PanelElements} elements */
function bindSummary(elements) {
  elements.summaryToggle.addEventListener('change', () => {
    chrome.storage.sync
      .set({ [STORAGE_KEYS.SUMMARY_ENABLED]: elements.summaryToggle.checked })
      .catch(() => refreshSettings(elements));
  });
}

// -----------------------------------------------------------------------------
// AI provider setup (checked and saved by the background worker, see provider.js)
// -----------------------------------------------------------------------------

/** The steps of the setup. */
const STEP_COUNT = 3;
/** Groups of the provider list in step 1, in order. */
const PRESET_GROUPS = Object.freeze([
  Object.freeze({ label: 'Cloud', includes: (/** @type {ProviderPreset} */ preset) => !preset.local && preset.id !== 'custom' }),
  Object.freeze({ label: 'On this computer', includes: (/** @type {ProviderPreset} */ preset) => preset.local }),
  Object.freeze({ label: 'Other', includes: (/** @type {ProviderPreset} */ preset) => preset.id === 'custom' }),
]);
/** How long the snackbar stays (Material 3: 4–10 s). */
const SNACKBAR_MS = 5000;
/**
 * Supporting texts shown without an error. The timeout and the model fields have none: only errors
 * (and notes for the models).
 */
const DEFAULT_TEXTS = Object.freeze({
  endpoint: 'OpenAI-compatible base URL, usually ending in /v1.',
});
const TIMEOUT_ERROR = `Enter whole seconds, from ${MIN_ANSWER_TIMEOUT_SECONDS} to ${MAX_ANSWER_TIMEOUT_SECONDS}.`;
/**
 * The model fields of step 3: "chat" for answers and summaries, "speech" for Voice.
 * @typedef {'chat' | 'speech'} ModelKind
 */
/** @type {readonly ModelKind[]} */
const MODEL_KINDS = Object.freeze(['chat', 'speech']);
/**
 * Models that cannot answer in a chat (embeddings, images, video, speech, moderation, realtime…):
 * not offered as the chat model. They can still be typed.
 */
const NON_CHAT_MODEL_PATTERN =
  /embed|whisper|transcri|tts|imagen|veo-|dall-e|image|moderation|rerank|guard|aqa|lyria|native-audio|realtime|orpheus|(?:^|[/_-])live(?:[/_-]|$)/i;
/** Speech-to-text models: the only ones offered for Voice. Others can still be typed. */
const SPEECH_MODEL_PATTERN = /whisper|transcri|voxtral|(?:^|[/_-])stt(?:[/_-]|$)/i;
/** A model field suggests at most this many models at a time, like the language field; typing finds the others. */
const MAX_MODEL_SUGGESTIONS = MAX_LANGUAGE_SUGGESTIONS;

/** @type {ProviderSettings | null} The provider as last read from storage. */
let provider = null;
/** @type {SetupState | null} null until the provider has been read. */
let setupState = null;
/** The step of the setup shown, 1 to 3. */
let setupStep = 1;
/** @type {string | null} The preset whose values fill the form; null before the first. */
let filledPresetId = null;
/** @type {string[] | null} The model IDs the provider listed in step 2; null when unknown. */
let listedModels = null;
/** @type {Record<ModelKind, string[]>} What each model field offers from the listed models, sorted. */
let modelChoices = { chat: [], speech: [] };
/**
 * Each model field's open list: the models shown and the highlighted one (-1 for none). No models
 * while it is closed.
 * @type {Record<ModelKind, { options: string[], highlight: number }>}
 */
const modelLists = { chat: { options: [], highlight: -1 }, speech: { options: [], highlight: -1 } };
/** Whether a check, save or removal is waiting for the background worker. */
let providerBusy = false;
/** Pending end of the snackbar; 0 when none shows. */
let snackbarTimer = 0;

/**
 * @param {ProviderSettings} settings
 * @returns {string} The provider's name: the preset's, else the endpoint's host.
 */
function getProviderName(settings) {
  return settings.preset.id === 'custom' ? new URL(settings.origin).host : settings.preset.name;
}

/**
 * Shows the provider in the settings popup and the Voice view. Only what is
 * not secret: the API key's last characters at most.
 * @param {PanelElements} elements
 */
function renderProviderInfo(elements) {
  if (provider === null) {
    elements.voiceModelNote.hidden = true;
    return;
  }
  const name = getProviderName(provider);
  elements.providerName.textContent = name;
  elements.providerDetail.textContent =
    provider.transcriptionModel === '' ? provider.chatModel : `${provider.chatModel} · Voice: ${provider.transcriptionModel}`;
  elements.providerKeyStatus.textContent = provider.hasKey
    ? `${provider.keyHint === '' ? 'Saved' : `••••${provider.keyHint}`}, encrypted on this device`
    : 'None (server on this computer)';
  elements.voiceModelNote.hidden = provider.transcriptionModel !== '';
}

/**
 * Material 3 snackbar: a short message at the bottom of the panel.
 * @param {PanelElements} elements
 * @param {string} message
 */
function showSnackbar(elements, message) {
  clearTimeout(snackbarTimer);
  elements.snackbarText.textContent = message;
  elements.snackbar.hidden = false;
  snackbarTimer = setTimeout(() => hideSnackbar(elements), SNACKBAR_MS);
}

/** @param {PanelElements} elements */
function hideSnackbar(elements) {
  clearTimeout(snackbarTimer);
  snackbarTimer = 0;
  elements.snackbar.hidden = true;
}

// --- Fields -------------------------------------------------------------------

/**
 * Shows a field's error (Material 3 error state: outline, label and
 * supporting text in the error color), or its usual supporting text.
 * @param {SetupField} part
 * @param {string | null} error
 * @param {string} supporting Shown without an error ('' hides the line).
 */
function renderField(part, error, supporting) {
  part.field.toggleAttribute('data-error', error !== null);
  part.input.setAttribute('aria-invalid', String(error !== null));
  part.support.textContent = error ?? supporting;
  part.support.hidden = (error ?? supporting) === '';
}

/**
 * @param {PanelElements} elements
 * @param {string} message '' to clear.
 */
function setProviderStatus(elements, message) {
  elements.providerStatus.textContent = message;
  elements.providerStatus.hidden = message === '';
}

/** @param {PanelElements} elements */
function clearSetupErrors(elements) {
  renderEndpointField(elements, null);
  renderKeyField(elements, null);
  renderTimeoutField(elements, null);
  renderModelFields(elements, null, null);
  setProviderStatus(elements, '');
}

/**
 * The preset picked in step 1 (Groq when none is).
 * @param {PanelElements} elements
 * @returns {ProviderPreset}
 */
function getPickedPreset(elements) {
  const checked = elements.providerChoices.querySelector('input[name="preset"]:checked');
  return (checked instanceof HTMLInputElement ? findPresetById(checked.value) : undefined) ?? getDefaultPreset();
}

/**
 * @param {PanelElements} elements
 * @param {string} id
 */
function checkPreset(elements, id) {
  for (const input of elements.providerChoices.querySelectorAll('input[name="preset"]')) {
    if (input instanceof HTMLInputElement) {
      input.checked = input.value === id;
    }
  }
}

/**
 * @param {ProviderPreset} preset
 * @returns {boolean} Whether step 2 asks for the endpoint: for Custom and servers on this
 *   computer (whose port can differ); the others have a fixed one.
 */
function asksForEndpoint(preset) {
  return preset.id === 'custom' || preset.local;
}

/**
 * The name used in the setup's texts: the preset's, or the endpoint's host for Custom.
 * @param {PanelElements} elements
 * @returns {string}
 */
function getSetupProviderName(elements) {
  const preset = getPickedPreset(elements);
  if (preset.id !== 'custom') {
    return preset.name;
  }
  const endpoint = checkEndpoint(elements.endpoint.input.value);
  return endpoint.ok ? new URL(endpoint.origin).host : 'Your provider';
}

/**
 * Whether the endpoint in the form is on the same origin as the saved
 * provider with a key: only then may the key field stay empty to keep it.
 * @param {PanelElements} elements
 * @returns {boolean}
 */
function canKeepSavedKey(elements) {
  const endpoint = checkEndpoint(elements.endpoint.input.value);
  return setupState === 'editing' && provider !== null && provider.hasKey && endpoint.ok && endpoint.origin === provider.origin;
}

/**
 * @param {PanelElements} elements
 * @param {string | null} error
 */
function renderEndpointField(elements, error) {
  renderField(elements.endpoint, error, DEFAULT_TEXTS.endpoint);
}

/**
 * The key field's label and supporting text for the endpoint and preset in
 * the form: the saved key's hint while it can be kept.
 * @param {PanelElements} elements
 * @param {string | null} error
 */
function renderKeyField(elements, error) {
  const endpoint = checkEndpoint(elements.endpoint.input.value);
  const local = endpoint.ok && endpoint.local;
  elements.keyLabel.textContent = local ? 'API key (optional)' : 'API key';
  elements.key.input.placeholder = local ? 'Not needed for most local servers' : 'Paste your API key';
  let supporting = '';
  if (canKeepSavedKey(elements) && provider !== null) {
    supporting = provider.keyHint === ''
      ? 'Leave empty to keep the saved key.'
      : `Leave empty to keep the saved key (••••${provider.keyHint}).`;
  } else if (local) {
    supporting = 'Only if your server asks for one.';
  }
  renderField(elements.key, error, supporting);
}

/**
 * @param {PanelElements} elements
 * @param {string | null} error
 */
function renderTimeoutField(elements, error) {
  renderField(elements.timeout, error, '');
}

/**
 * @param {PanelElements} elements
 * @returns {number | null} The seconds typed, or null when they are not a time the setup takes.
 */
function readTimeout(elements) {
  const text = elements.timeout.input.value.trim();
  const seconds = /^\d{1,4}$/.test(text) ? Number(text) : Number.NaN;
  return isValidAnswerTimeout(seconds) ? seconds : null;
}

/**
 * @param {string} id
 * @returns {string} The ID as listed models are compared (Gemini lists "models/…", Ollama "…:latest").
 */
function normalizeModelId(id) {
  return id.trim().replace(/^models\//, '').replace(/:latest$/, '').toLowerCase();
}

/**
 * @param {string} id
 * @returns {string} The model's name without "provider/" ("openai/gpt-oss-120b" → "gpt-oss-120b"), lowercase.
 */
function getModelName(id) {
  return id.slice(id.lastIndexOf('/') + 1).toLowerCase();
}

/**
 * @param {string} id
 * @returns {number} The version right after the model's family name ("gemini-2.5-flash" 2.5,
 *   "gpt-4.1-mini" 4.1, "qwen3-32b" 3), or 0 when there is none ("gpt-oss-120b", "deepseek-chat").
 */
function getModelVersion(id) {
  const match = /^[a-z]+-?(\d+(?:\.\d+)?)/.exec(getModelName(id));
  return match === null ? 0 : Number(match[1]);
}

/**
 * Orders a field's models for its suggestions: the model the preset suggests
 * first, then the others of its family ("gemini", "gpt"…), then the rest;
 * newer versions first in each, then by name.
 * @param {string[]} ids
 * @param {string} suggested The preset's model for the field ('' for none).
 * @returns {string[]}
 */
function orderModels(ids, suggested) {
  const family = /^[a-z]+/.exec(getModelName(suggested))?.[0] ?? '';
  const rank = (/** @type {string} */ id) => {
    if (suggested !== '' && normalizeModelId(id) === normalizeModelId(suggested)) {
      return 0;
    }
    return family !== '' && getModelName(id).startsWith(family) ? 1 : 2;
  };
  return [...ids].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      getModelVersion(b) - getModelVersion(a) ||
      a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }),
  );
}

/**
 * Keeps the models the provider listed in step 2, and what each model field
 * offers from them: IDs as the API takes them (Gemini lists "models/…"), each
 * once, in the order of orderModels(); the chat field without models that
 * cannot chat (all of them when that leaves none), Voice only speech-to-text
 * models.
 * @param {string[] | null} models null when unknown.
 * @param {ProviderPreset} [preset] The provider picked, whose suggested models come first.
 */
function setListedModels(models, preset) {
  listedModels = models;
  const ids = [...new Set((models ?? []).map((id) => id.replace(/^models\//, '')).filter((id) => id !== ''))];
  const chat = ids.filter((id) => !NON_CHAT_MODEL_PATTERN.test(id));
  modelChoices = {
    chat: orderModels(chat.length > 0 ? chat : ids, preset?.chatModel ?? ''),
    speech: orderModels(
      ids.filter((id) => SPEECH_MODEL_PATTERN.test(id)),
      preset?.transcriptionModel ?? '',
    ),
  };
}

/**
 * @param {PanelElements} elements
 * @param {ModelKind} kind
 * @returns {{ part: SetupField, list: HTMLUListElement }}
 */
function getModelField(elements, kind) {
  return kind === 'chat'
    ? { part: elements.chatModel, list: elements.chatModelList }
    : { part: elements.transcriptionModel, list: elements.transcriptionModelList };
}

/**
 * Marks the highlighted model in a field's list and scrolls it into view.
 * @param {PanelElements} elements
 * @param {ModelKind} kind
 */
function renderModelHighlight(elements, kind) {
  const { part, list } = getModelField(elements, kind);
  const { highlight } = modelLists[kind];
  for (const [index, option] of [...list.children].entries()) {
    option.setAttribute('aria-selected', String(index === highlight));
  }
  const highlighted = list.children[highlight];
  if (highlighted) {
    part.input.setAttribute('aria-activedescendant', highlighted.id);
    highlighted.scrollIntoView({ block: 'nearest' });
  } else {
    part.input.removeAttribute('aria-activedescendant');
  }
}

/**
 * Shows a field's list as it is in modelLists, or closes it when it has no
 * models. IDs are rendered as text nodes only.
 * @param {PanelElements} elements
 * @param {ModelKind} kind
 */
function renderModelList(elements, kind) {
  const { part, list } = getModelField(elements, kind);
  const { options } = modelLists[kind];
  const wasOpen = !list.hidden;
  list.replaceChildren(
    ...options.map((id, index) => {
      const option = document.createElement('li');
      option.id = `${list.id}-option-${index}`;
      option.className = 'model-option';
      option.setAttribute('role', 'option');
      option.dataset.index = String(index);
      option.textContent = id;
      return option;
    }),
  );
  const open = options.length > 0;
  list.hidden = !open;
  if (part.input.getAttribute('role') === 'combobox') {
    part.input.setAttribute('aria-expanded', String(open));
  }
  if (open && !wasOpen) {
    list.scrollIntoView({ block: 'nearest' });
  }
  renderModelHighlight(elements, kind);
}

/**
 * @param {PanelElements} elements
 * @param {ModelKind} kind
 * @param {string} text Typed in the field; '' when the list opens without typing.
 * @returns {string[]} The models a field suggests, like the language field
 *   does: without text, the model in the field first, then the others; with
 *   text, the model named exactly so, then those whose ID (or its part after
 *   "provider/") starts with it, then those that only contain it.
 */
function findModels(elements, kind, text) {
  const choices = modelChoices[kind];
  const query = text.trim().toLowerCase();
  if (query === '') {
    const current = normalizeModelId(getModelField(elements, kind).part.input.value);
    const inField = choices.find((id) => normalizeModelId(id) === current);
    return inField === undefined ? choices : [inField, ...choices.filter((id) => id !== inField)];
  }
  const names = (/** @type {string} */ id) => {
    const lower = id.toLowerCase();
    return [lower, lower.slice(lower.lastIndexOf('/') + 1)];
  };
  const exact = choices.filter((id) => normalizeModelId(id) === normalizeModelId(query));
  const starting = choices.filter((id) => !exact.includes(id) && names(id).some((name) => name.startsWith(query)));
  const containing = choices.filter(
    (id) => !exact.includes(id) && !starting.includes(id) && id.toLowerCase().includes(query),
  );
  return [...exact, ...starting, ...containing];
}

/**
 * Opens a field's suggestions for the text, with one highlighted (-1 for
 * none, past the end for the last), or closes them when none match.
 * @param {PanelElements} elements
 * @param {ModelKind} kind
 * @param {string} text
 * @param {number} highlight
 */
function showModelSuggestions(elements, kind, text, highlight) {
  const options = findModels(elements, kind, text).slice(0, MAX_MODEL_SUGGESTIONS);
  modelLists[kind] = { options, highlight: Math.min(highlight, options.length - 1) };
  renderModelList(elements, kind);
}

/**
 * @param {PanelElements} elements
 * @param {ModelKind} kind
 */
function closeModelOptions(elements, kind) {
  modelLists[kind] = { options: [], highlight: -1 };
  renderModelList(elements, kind);
}

/** @param {PanelElements} elements */
function closeAllModelOptions(elements) {
  for (const kind of MODEL_KINDS) {
    closeModelOptions(elements, kind);
  }
}

/**
 * Puts a model from a field's list into the field and closes the list.
 * @param {PanelElements} elements
 * @param {ModelKind} kind
 * @param {number} index
 */
function pickModelOption(elements, kind, index) {
  const id = modelLists[kind].options[index];
  if (id === undefined) {
    return;
  }
  getModelField(elements, kind).part.input.value = id;
  closeModelOptions(elements, kind);
  renderModelFields(elements, null, null);
}

/**
 * @param {string} id
 * @returns {boolean} Whether the provider lists this model (true while the list is unknown).
 */
function isListedModel(id) {
  return listedModels === null || listedModels.some((listed) => normalizeModelId(listed) === normalizeModelId(id));
}

/**
 * The model fields' supporting texts: none by default; a note when the
 * provider does not list the model typed (it may still work, so it does not
 * block; not while its suggestions are open, as it is still being typed) or
 * has no speech-to-text, or an error.
 * @param {PanelElements} elements
 * @param {string | null} chatError
 * @param {string | null} transcriptionError
 */
function renderModelFields(elements, chatError, transcriptionError) {
  const chat = elements.chatModel.input.value.trim();
  const transcription = elements.transcriptionModel.input.value.trim();
  const name = getSetupProviderName(elements);
  const unlisted = (/** @type {string} */ id, /** @type {ModelKind} */ kind) =>
    id !== '' && !isListedModel(id) && modelLists[kind].options.length === 0;
  const chatUnlisted = unlisted(chat, 'chat');
  const transcriptionUnlisted = unlisted(transcription, 'speech');
  const chatNote = chatUnlisted ? `${name} does not list this model. Check the ID.` : '';
  const transcriptionNote = transcriptionUnlisted
    ? `${name} does not list this model. Check the ID.`
    : transcription === '' && getPickedPreset(elements).id !== 'custom' && getPickedPreset(elements).transcriptionModel === ''
      ? `${name} has no speech-to-text, so Voice stays off.`
      : '';
  renderField(elements.chatModel, chatError, chatNote);
  renderField(elements.transcriptionModel, transcriptionError, transcriptionNote);
  elements.chatModel.field.toggleAttribute('data-note', chatError === null && chatUnlisted);
  elements.transcriptionModel.field.toggleAttribute('data-note', transcriptionError === null && transcriptionUnlisted);
}

/**
 * Shows the key as typed or hidden.
 * @param {PanelElements} elements
 * @param {boolean} visible
 */
function setKeyVisible(elements, visible) {
  elements.key.input.type = visible ? 'text' : 'password';
  elements.keyToggle.setAttribute('aria-pressed', String(visible));
  const label = visible ? 'Hide the API key' : 'Show the API key';
  elements.keyToggle.setAttribute('aria-label', label);
  elements.keyToggle.title = label;
}

/**
 * Empties the API key field: after a save, a removal, a new provider, and when
 * the panel closes, so the key does not stay in the page longer than needed.
 * @param {PanelElements} elements
 */
function clearKeyField(elements) {
  elements.key.input.value = '';
  setKeyVisible(elements, false);
}

/**
 * Step 3: each model field is a combobox when the provider listed models it
 * can offer (picked from the list, or typed), else a plain text field for the
 * ID; and the fields' notes.
 * @param {PanelElements} elements
 */
function renderModelsStep(elements) {
  for (const kind of MODEL_KINDS) {
    const { part, list } = getModelField(elements, kind);
    const offered = modelChoices[kind].length > 0;
    part.field.toggleAttribute('data-listed', offered);
    if (offered) {
      part.input.setAttribute('role', 'combobox');
      part.input.setAttribute('aria-autocomplete', 'list');
      part.input.setAttribute('aria-controls', list.id);
      part.input.setAttribute('aria-expanded', 'false');
      part.input.placeholder = kind === 'chat' ? 'Search or type a model ID' : 'None: Voice stays off';
    } else {
      for (const name of ['role', 'aria-autocomplete', 'aria-controls', 'aria-expanded', 'aria-activedescendant']) {
        part.input.removeAttribute(name);
      }
      part.input.placeholder = kind === 'chat' ? 'Model ID' : 'None: Voice stays off';
    }
    closeModelOptions(elements, kind);
  }
  renderModelFields(elements, null, null);
}

/**
 * Selects the whole text when a field gets the focus (like the language field
 * in settings), also by a click, so a filled-in value is replaced by typing.
 * @param {HTMLInputElement} input
 */
function selectOnFocus(input) {
  let clickFocus = false;
  input.addEventListener('mousedown', () => {
    clickFocus = document.activeElement !== input;
  });
  input.addEventListener('focus', () => input.select());
  input.addEventListener('mouseup', (event) => {
    // The mouse button going up would otherwise drop the selection again.
    if (clickFocus) {
      event.preventDefault();
      clickFocus = false;
    }
  });
}

// --- Steps --------------------------------------------------------------------

/**
 * Fills the form with a preset's endpoint. Only the default provider (Groq)
 * comes with its models filled in; for the others the model fields start
 * empty and the user types the IDs in step 3.
 * @param {PanelElements} elements
 * @param {ProviderPreset} preset
 */
function fillFromPreset(elements, preset) {
  const prefillModels = preset.id === getDefaultPreset().id;
  elements.endpoint.input.value = preset.baseUrl;
  elements.timeout.input.value = String(DEFAULT_ANSWER_TIMEOUT_SECONDS);
  elements.chatModel.input.value = prefillModels ? preset.chatModel : '';
  elements.transcriptionModel.input.value = prefillModels ? preset.transcriptionModel : '';
  filledPresetId = preset.id;
  setListedModels(null);
}

/**
 * Fills the form with the saved provider (the key field stays empty).
 * @param {PanelElements} elements
 * @param {ProviderSettings} settings
 */
function fillFromProvider(elements, settings) {
  elements.endpoint.input.value = settings.baseUrl;
  elements.timeout.input.value = String(settings.timeoutSeconds);
  elements.chatModel.input.value = settings.chatModel;
  elements.transcriptionModel.input.value = settings.transcriptionModel;
  filledPresetId = settings.preset.id;
  setListedModels(null);
}

/**
 * Step 2 for the preset picked: its title, the endpoint (a field for Custom
 * and servers on this computer, read-only otherwise), the key's label and
 * the "Get an API key" link (a fixed address from PROVIDER_PRESETS).
 * @param {PanelElements} elements
 */
function renderConnectStep(elements) {
  const preset = getPickedPreset(elements);
  const editable = asksForEndpoint(preset);
  elements.endpoint.field.hidden = !editable;
  elements.endpointInfo.hidden = editable;
  elements.endpointInfoValue.textContent = elements.endpoint.input.value.replace(/^https?:\/\//, '');
  if (preset.id === 'custom') {
    elements.connectTitle.textContent = 'Connect your provider';
    elements.connectText.textContent = 'Enter the address of an OpenAI-compatible API and its key.';
  } else if (preset.local) {
    elements.connectTitle.textContent = `Connect to ${preset.name}`;
    elements.connectText.textContent = `Check the address of ${preset.name} on this computer. A key is usually not needed.`;
  } else {
    elements.connectTitle.textContent = `Connect to ${preset.name}`;
    elements.connectText.textContent = `Paste an API key from your ${preset.name} account.`;
  }
  elements.keyLink.hidden = preset.keysUrl === '';
  if (preset.keysUrl !== '') {
    elements.keyLink.href = preset.keysUrl;
    elements.keyLinkLabel.textContent = `Get a ${preset.name} API key`;
  }
  elements.removeButton.hidden = setupState !== 'editing' || provider === null;
  renderEndpointField(elements, null);
  renderKeyField(elements, null);
  renderTimeoutField(elements, null);
}

/**
 * The bottom actions for the step shown: Back from step 2 on, Next until the
 * last step, then Finish (Save when editing).
 * @param {PanelElements} elements
 */
function renderSetupActions(elements) {
  elements.backButton.hidden = setupStep === 1;
  const last = setupStep === STEP_COUNT;
  elements.nextButton.textContent = providerBusy
    ? setupStep === 2
      ? 'Connecting…'
      : 'Saving…'
    : last
      ? setupState === 'editing'
        ? 'Save'
        : 'Finish'
      : 'Next';
}

/**
 * Shows a step, with a Material 3 shared-axis transition in the direction of
 * travel, and the progress indicator for it.
 * @param {PanelElements} elements
 * @param {number} step 1 to 3.
 * @param {'forward' | 'back' | 'none'} direction
 */
function goToStep(elements, step, direction) {
  setupStep = step;
  closeAllModelOptions(elements);
  elements.setupSteps.forEach((section, index) => {
    section.hidden = index + 1 !== step;
    if (index + 1 === step && direction !== 'none') {
      section.dataset.enter = direction;
      section.addEventListener('animationend', () => delete section.dataset.enter, { once: true });
    }
  });
  elements.setupProgress.setAttribute('aria-valuenow', String(step));
  elements.setupProgress.style.setProperty('--progress', String(step / STEP_COUNT));
  setProviderStatus(elements, '');
  if (step === 2) {
    renderConnectStep(elements);
  }
  if (step === 3) {
    renderModelsStep(elements);
  }
  renderSetupActions(elements);
  elements.setupScroll.scrollTop = 0;
  // Focus where the step starts: the provider picked, the first field, the models' title.
  if (step === 1) {
    elements.providerChoices.querySelector('input[name="preset"]:checked')?.focus({ preventScroll: true });
  } else if (step === 2) {
    (elements.endpoint.field.hidden ? elements.key.input : elements.endpoint.input).focus({ preventScroll: true });
  } else {
    elements.setupSteps[2].querySelector('h2')?.focus({ preventScroll: true });
  }
}

/**
 * Locks the form while the background worker checks or saves.
 * @param {PanelElements} elements
 * @param {boolean} busy
 */
function setProviderBusy(elements, busy) {
  providerBusy = busy;
  if (busy) {
    closeAllModelOptions(elements);
  }
  elements.providerForm.toggleAttribute('data-busy', busy);
  for (const control of elements.providerForm.querySelectorAll('input, button')) {
    if (control instanceof HTMLInputElement || control instanceof HTMLButtonElement) {
      control.disabled = busy;
    }
  }
  elements.setupClose.disabled = busy;
  elements.resetButton.disabled = busy;
  elements.nextButton.setAttribute('aria-busy', String(busy));
  renderSetupActions(elements);
}

/**
 * Shows an error from the background worker on the field it is about (going
 * back to its step when needed), else under the form.
 * @param {PanelElements} elements
 * @param {Partial<ProviderResult> & Record<string, unknown> | null | undefined} result
 */
function showProviderError(elements, result) {
  const message =
    result?.kind === 'error' && typeof result.message === 'string' ? result.message : 'Something went wrong. Try again.';
  const field = result?.kind === 'error' ? result.field : undefined;
  if (field === 'key' || field === 'timeout' || (field === 'endpoint' && asksForEndpoint(getPickedPreset(elements)))) {
    if (setupStep !== 2) {
      goToStep(elements, 2, 'back');
    }
    if (field === 'key') {
      renderKeyField(elements, message);
      elements.key.input.focus();
    } else if (field === 'timeout') {
      renderTimeoutField(elements, message);
      elements.timeout.input.focus();
    } else {
      renderEndpointField(elements, message);
      elements.endpoint.input.focus();
    }
  } else if (field === 'chatModel' || field === 'transcriptionModel') {
    if (setupStep !== 3) {
      goToStep(elements, 3, 'forward');
    }
    renderModelFields(elements, field === 'chatModel' ? message : null, field === 'transcriptionModel' ? message : null);
    elements[field].input.focus();
  } else {
    setProviderStatus(elements, message);
  }
}

/**
 * The connection the user typed, for the background worker.
 * @param {PanelElements} elements
 * @returns {{ baseUrl: string, apiKey: string }}
 */
function readConnection(elements) {
  return { baseUrl: elements.endpoint.input.value, apiKey: elements.key.input.value };
}

/**
 * Sends a message to the background worker; never rejects.
 * @param {object} message
 * @returns {Promise<Partial<ProviderResult> & Record<string, unknown> | null | undefined>}
 */
async function sendProviderMessage(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    return { kind: 'error', message: 'Could not reach the extension. Reopen the side panel.' };
  }
}

/**
 * Step 1 → 2: a new provider fills in its endpoint and suggested models (and
 * empties the key typed for another one); the saved provider when editing.
 * @param {PanelElements} elements
 */
function leaveProviderStep(elements) {
  const preset = getPickedPreset(elements);
  if (filledPresetId !== preset.id) {
    if (setupState === 'editing' && provider !== null && provider.preset.id === preset.id) {
      fillFromProvider(elements, provider);
    } else {
      fillFromPreset(elements, preset);
    }
    clearKeyField(elements);
  }
  goToStep(elements, 2, 'forward');
}

/**
 * Step 2 → 3: checks the endpoint and key with the provider (nothing is
 * saved yet) and keeps the models it lists for step 3.
 * @param {PanelElements} elements
 */
async function leaveConnectStep(elements) {
  const endpoint = checkEndpoint(elements.endpoint.input.value);
  if (!endpoint.ok) {
    renderEndpointField(elements, endpoint.message);
    elements.endpoint.input.focus();
    return;
  }
  const key = elements.key.input.value.trim();
  const keyError =
    key !== '' && !isValidApiKey(key)
      ? 'This key has characters an API key cannot have (spaces, line breaks…). Paste it again.'
      : key === '' && !endpoint.local && !canKeepSavedKey(elements)
        ? 'Enter your API key.'
        : null;
  if (keyError !== null) {
    renderKeyField(elements, keyError);
    elements.key.input.focus();
    return;
  }
  if (readTimeout(elements) === null) {
    renderTimeoutField(elements, TIMEOUT_ERROR);
    elements.timeout.input.focus();
    return;
  }
  setProviderBusy(elements, true);
  const result = await sendProviderMessage({ type: MESSAGE_TYPES.PROVIDER_CHECK, provider: readConnection(elements) });
  setProviderBusy(elements, false);
  if (result?.kind !== 'checked') {
    showProviderError(elements, result);
    return;
  }
  const models = Array.isArray(result.models) ? result.models.filter((id) => typeof id === 'string' && isValidModel(id)) : [];
  setListedModels(models.length > 0 ? models : null, getPickedPreset(elements));
  goToStep(elements, 3, 'forward');
}

/**
 * Step 3: saves everything. The background worker checks the endpoint and
 * key again, encrypts the key and stores the provider; the panel then shows,
 * with a snackbar.
 * @param {PanelElements} elements
 */
async function finishSetup(elements) {
  const chatModel = elements.chatModel.input.value.trim();
  const transcriptionModel = elements.transcriptionModel.input.value.trim();
  const chatError = chatModel === '' || !isValidModel(chatModel) ? 'Enter the model ID, without spaces.' : null;
  const transcriptionError =
    transcriptionModel !== '' && !isValidModel(transcriptionModel) ? 'Enter the model ID without spaces, or leave it empty.' : null;
  if (chatError !== null || transcriptionError !== null) {
    renderModelFields(elements, chatError, transcriptionError);
    (chatError !== null ? elements.chatModel.input : elements.transcriptionModel.input).focus();
    return;
  }
  const timeoutSeconds = readTimeout(elements);
  if (timeoutSeconds === null) {
    showProviderError(elements, { kind: 'error', message: TIMEOUT_ERROR, field: 'timeout' });
    return;
  }
  setProviderBusy(elements, true);
  const result = await sendProviderMessage({
    type: MESSAGE_TYPES.PROVIDER_SAVE,
    provider: { ...readConnection(elements), timeoutSeconds, chatModel, transcriptionModel },
  });
  if (result?.kind !== 'saved') {
    setProviderBusy(elements, false);
    showProviderError(elements, result);
    return;
  }
  clearKeyField(elements);
  // Read while still busy, so loadProvider() leaves the screen to this function.
  await loadProvider(elements).catch(() => {});
  setProviderBusy(elements, false);
  closeSetup(elements);
  const name = provider === null ? 'your provider' : getProviderName(provider);
  showSnackbar(elements, typeof result.notice === 'string' && result.notice !== '' ? `Saved. ${result.notice}` : `Connected to ${name}`);
}

/** @param {PanelElements} elements */
function submitStep(elements) {
  if (providerBusy) {
    return;
  }
  setProviderStatus(elements, '');
  if (setupStep === 1) {
    leaveProviderStep(elements);
  } else if (setupStep === 2) {
    void leaveConnectStep(elements);
  } else {
    void finishSetup(elements);
  }
}

// --- Screen -------------------------------------------------------------------

/**
 * Shows the setup, the panel or nothing yet, and the setup's top app bar for
 * its state: the logo while setting up, a close button while editing.
 * @param {PanelElements} elements
 */
function renderSetupState(elements) {
  document.body.dataset.setup = setupState ?? '';
  if (setupState === 'required' || setupState === 'editing') {
    closePopovers(elements);
    elements.setupTitle.textContent = setupState === 'editing' ? 'Edit AI provider' : 'Set up Pilbot';
    elements.setupClose.hidden = setupState !== 'editing';
    renderSetupActions(elements);
  }
}

/**
 * Opens the setup at step 1: with the saved provider picked when editing,
 * with Groq otherwise. The key field starts empty.
 * @param {PanelElements} elements
 * @param {'required' | 'editing'} state
 */
function openSetup(elements, state) {
  setupState = state;
  hideSnackbar(elements);
  clearKeyField(elements);
  if (state === 'editing' && provider !== null) {
    checkPreset(elements, provider.preset.id);
    fillFromProvider(elements, provider);
  } else {
    const preset = getDefaultPreset();
    checkPreset(elements, preset.id);
    fillFromPreset(elements, preset);
  }
  clearSetupErrors(elements);
  renderSetupState(elements);
  goToStep(elements, 1, 'none');
}

/**
 * Leaves the setup for the panel (only with a provider set up).
 * @param {PanelElements} elements
 */
function closeSetup(elements) {
  if (provider === null) {
    return;
  }
  setupState = 'ready';
  clearKeyField(elements);
  clearSetupErrors(elements);
  renderSetupState(elements);
}

/**
 * Asks to remove the provider and its key (the dialog), from the setup's
 * "Remove saved key" or the reset button in the panel.
 * @param {PanelElements} elements
 */
function confirmRemoveProvider(elements) {
  if (providerBusy || elements.removeDialog.open) {
    return;
  }
  closePopovers(elements);
  elements.removeDialog.showModal();
}

/**
 * Removes the provider and its key (confirmed in the dialog). The background
 * worker also deletes the encryption key; the setup then starts again. When
 * it fails, the message shows where the user is: under the setup's form, or
 * in a snackbar over the panel.
 * @param {PanelElements} elements
 */
async function removeProviderKey(elements) {
  elements.removeDialog.close();
  if (providerBusy) {
    return;
  }
  setProviderBusy(elements, true);
  const result = await sendProviderMessage({ type: MESSAGE_TYPES.PROVIDER_REMOVE });
  setProviderBusy(elements, false);
  if (result?.kind === 'removed') {
    provider = null;
    renderProviderInfo(elements);
    openSetup(elements, 'required');
    showSnackbar(elements, 'API key removed');
  } else if (setupState === 'ready') {
    showSnackbar(elements, 'Could not remove the key. Try again.');
  } else {
    setProviderStatus(elements, 'Could not remove the key. Try again.');
  }
}

/**
 * Reads the provider (never its key) and shows it. Without one, the setup
 * opens; one set up in another window closes it. A check, save or removal in
 * progress here decides on its own.
 * @param {PanelElements} elements
 */
async function loadProvider(elements) {
  provider = parseProviderSettings((await chrome.storage.local.get(STORAGE_KEYS.PROVIDER))[STORAGE_KEYS.PROVIDER]);
  renderProviderInfo(elements);
  if (providerBusy) {
    return;
  }
  if (provider === null) {
    if (setupState !== 'required') {
      openSetup(elements, 'required');
    }
  } else if (setupState === null || setupState === 'required') {
    closeSetup(elements);
  }
}

/** @param {PanelElements} elements */
function refreshProvider(elements) {
  loadProvider(elements).catch(() => {
    if (setupState === null) {
      openSetup(elements, 'required');
    }
  });
}

/**
 * Step 1's list: Material 3 list items with a radio button, grouped (cloud,
 * this computer, other). Names and descriptions are fixed texts from
 * PROVIDER_PRESETS, rendered as text nodes.
 * @param {PanelElements} elements
 */
function renderProviderChoices(elements) {
  elements.providerChoices.replaceChildren(
    ...PRESET_GROUPS.flatMap((group) => {
      const presets = PROVIDER_PRESETS.filter(group.includes);
      const label = document.createElement('p');
      label.className = 'choice-group-label';
      label.textContent = group.label;
      const list = document.createElement('div');
      list.className = 'choice-list';
      list.append(
        ...presets.map((preset) => {
          const item = document.createElement('label');
          item.className = 'choice-item';
          const radio = document.createElement('span');
          radio.className = 'radio';
          const input = document.createElement('input');
          input.type = 'radio';
          input.name = 'preset';
          input.value = preset.id;
          input.className = 'radio-input';
          const icon = document.createElement('span');
          icon.className = 'radio-icon';
          icon.setAttribute('aria-hidden', 'true');
          radio.append(input, icon);
          const text = document.createElement('span');
          text.className = 'choice-text';
          const headline = document.createElement('span');
          headline.className = 'choice-headline';
          headline.textContent = preset.name;
          const supporting = document.createElement('span');
          supporting.className = 'choice-supporting';
          supporting.textContent = preset.transcriptionModel === '' ? preset.description : `${preset.description} · Voice`;
          text.append(headline, supporting);
          item.append(radio, text);
          return item;
        }),
      );
      return [label, list];
    }),
  );
}

/**
 * A model field as a combobox with list autocomplete, like the language field,
 * while the provider listed models it can offer: a click shows the first
 * suggestions (the model in the field first), typing suggests matching models
 * (the first one highlighted), the arrow keys move the highlight, Enter or a
 * click puts the highlighted model in the field, Esc or leaving the field
 * closes the list. Unlike a language, any model ID may be typed: leaving the
 * field keeps the text as typed.
 * @param {PanelElements} elements
 * @param {ModelKind} kind
 */
function bindModelField(elements, kind) {
  const { part, list } = getModelField(elements, kind);
  const box = getRequiredPart(part.field, '.text-field-box', HTMLElement);
  const offered = () => part.field.hasAttribute('data-listed') && !part.input.disabled;
  const isOpen = () => modelLists[kind].options.length > 0;
  /** Opens the suggestions; the field's note waits until they close. */
  const open = (/** @type {string} */ text, /** @type {number} */ highlight) => {
    showModelSuggestions(elements, kind, text, highlight);
    renderModelFields(elements, null, null);
  };
  /** Closes the suggestions, then shows the field's note when the model typed is not listed. */
  const close = () => {
    if (isOpen()) {
      closeModelOptions(elements, kind);
      renderModelFields(elements, null, null);
    }
  };

  part.input.addEventListener('input', () => {
    if (offered()) {
      const text = part.input.value;
      open(text, text.trim() === '' ? -1 : 0);
    } else {
      renderModelFields(elements, null, null);
    }
  });
  // A click on the arrow or an icon keeps the focus in the field (leaving it would close the list first).
  box.addEventListener('mousedown', (event) => {
    if (offered() && event.target !== part.input) {
      event.preventDefault();
    }
  });
  // A click anywhere on the field shows the first suggestions, as on the language field.
  box.addEventListener('click', (event) => {
    if (!offered()) {
      return;
    }
    if (event.target !== part.input) {
      part.input.focus();
    }
    if (!isOpen()) {
      open('', -1);
    }
  });
  part.input.addEventListener('keydown', (event) => {
    if (!offered()) {
      return;
    }
    const state = modelLists[kind];
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const down = event.key === 'ArrowDown';
      if (!isOpen()) {
        open('', down ? 0 : MAX_MODEL_SUGGESTIONS);
        return;
      }
      const count = state.options.length;
      state.highlight = state.highlight < 0 ? (down ? 0 : count - 1) : (state.highlight + (down ? 1 : count - 1)) % count;
      renderModelHighlight(elements, kind);
    } else if (event.key === 'Enter' && isOpen()) {
      // Enter in an open list picks (or only closes it); the next one goes on.
      event.preventDefault();
      if (state.highlight >= 0) {
        pickModelOption(elements, kind, state.highlight);
      } else {
        close();
      }
    } else if (event.key === 'Escape' && isOpen()) {
      // Closes only the list, not the setup.
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });
  part.input.addEventListener('blur', close);

  // Keeps the focus in the field, so a click on a model is not leaving it first.
  list.addEventListener('mousedown', (event) => event.preventDefault());
  list.addEventListener('click', (event) => {
    const option = event.target instanceof Element ? event.target.closest('.model-option') : null;
    if (option instanceof HTMLElement) {
      pickModelOption(elements, kind, Number(option.dataset.index));
    }
  });
}

/** @param {PanelElements} elements */
function bindProvider(elements) {
  renderProviderChoices(elements);
  elements.endpoint.input.maxLength = MAX_ENDPOINT_LENGTH;
  elements.key.input.maxLength = MAX_API_KEY_LENGTH;
  elements.timeout.input.min = String(MIN_ANSWER_TIMEOUT_SECONDS);
  elements.timeout.input.max = String(MAX_ANSWER_TIMEOUT_SECONDS);
  elements.chatModel.input.maxLength = MAX_MODEL_LENGTH;
  elements.transcriptionModel.input.maxLength = MAX_MODEL_LENGTH;

  for (const kind of MODEL_KINDS) {
    bindModelField(elements, kind);
  }
  for (const part of [elements.endpoint, elements.key, elements.timeout, elements.chatModel, elements.transcriptionModel]) {
    selectOnFocus(part.input);
  }
  elements.timeout.input.addEventListener('input', () => renderTimeoutField(elements, null));

  // Double-clicking a provider is picking it and going on.
  elements.providerChoices.addEventListener('dblclick', (event) => {
    if (event.target instanceof Element && event.target.closest('.choice-item') && setupStep === 1) {
      submitStep(elements);
    }
  });
  elements.endpoint.input.addEventListener('input', () => {
    renderEndpointField(elements, null);
    renderKeyField(elements, null);
  });
  elements.key.input.addEventListener('input', () => renderKeyField(elements, null));
  elements.keyToggle.addEventListener('click', () => setKeyVisible(elements, elements.key.input.type === 'password'));
  elements.providerForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitStep(elements);
  });
  elements.backButton.addEventListener('click', () => {
    if (!providerBusy && setupStep > 1) {
      goToStep(elements, setupStep - 1, 'back');
    }
  });
  elements.setupClose.addEventListener('click', () => closeSetup(elements));
  elements.providerEditButton.addEventListener('click', () => openSetup(elements, 'editing'));
  elements.removeButton.addEventListener('click', () => confirmRemoveProvider(elements));
  elements.resetButton.addEventListener('click', () => confirmRemoveProvider(elements));
  elements.removeCancel.addEventListener('click', () => elements.removeDialog.close());
  elements.removeConfirm.addEventListener('click', () => void removeProviderKey(elements));
  // Esc while editing closes the setup, like its close button.
  elements.providerForm.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && setupState === 'editing' && !providerBusy) {
      event.preventDefault();
      closeSetup(elements);
    }
  });
  // The key never stays in the page after it closes.
  window.addEventListener('pagehide', () => clearKeyField(elements));
}

// -----------------------------------------------------------------------------
// Init
// -----------------------------------------------------------------------------

/** @param {PanelElements} elements */
function bindControls(elements) {
  elements.enabledToggle.addEventListener('change', () => {
    chrome.storage.sync
      .set({ [STORAGE_KEYS.ENABLED]: elements.enabledToggle.checked })
      .catch(() => refreshSettings(elements));
  });

  elements.menu.addEventListener('change', () => renderView(elements));
  bindAsk(elements);
  bindKnowledge(elements);
  bindVoice(elements);
  bindSummary(elements);
  bindPopovers(elements);
  bindSettingsPopover(elements);
  bindLanguage(elements);
  bindProvider(elements);

  const syncedKeys = [
    STORAGE_KEYS.ENABLED,
    STORAGE_KEYS.THEME,
    STORAGE_KEYS.ASK_ENABLED,
    STORAGE_KEYS.DICTATION_ENABLED,
    STORAGE_KEYS.SUMMARY_ENABLED,
  ];
  const knowledgeKeys = [STORAGE_KEYS.REFERENCE_TEXT, STORAGE_KEYS.REFERENCE_ENABLED];
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync' && syncedKeys.some((key) => key in changes)) {
      refreshSettings(elements);
    }
    if (areaName === 'local' && knowledgeKeys.some((key) => key in changes)) {
      refreshKnowledge(elements);
    }
    if (areaName === 'local' && STORAGE_KEYS.LANGUAGE in changes) {
      refreshLanguage(elements);
    }
    if (areaName === 'local' && STORAGE_KEYS.PROVIDER in changes) {
      refreshProvider(elements);
    }
  });
}

/** Wires up event listeners and renders the current state. */
function init() {
  applyTheme(readCachedTheme());
  const elements = getElements();
  renderView(elements);
  bindControls(elements);
  refreshSettings(elements);
  refreshKnowledge(elements);
  refreshLanguage(elements);
  refreshProvider(elements);
}

init();
