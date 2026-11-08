<p align="center">
  <img src="icons/icon128.png" width="72" height="72" alt="">
</p>

<h1 align="center">Pilbot</h1>

<p align="center">
  A small AI helper for Google Chrome: ask about selected text, summarize a page, dictate into text fields.<br>
  Bring your own AI provider and API key. No Pilbot server, no account.
</p>

<p align="center">
  <a href="https://pilbot.pages.dev">Website</a> ·
  <a href="https://pilbot.pages.dev/privacy">Privacy policy</a> ·
  <a href="LICENSE">License</a>
</p>

## Made with AI

AI tools were used to build this project, including writing its code and documentation.

## Features

- **Ask** – select a question on any page (two words or more) and click the speech-bubble button next to it, or
  press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>Q</kbd> (<kbd>Option</kbd>+<kbd>Shift</kbd>+<kbd>Q</kbd> on a Mac).
  A short answer shows in the bottom-left corner.
- **Summarize** – on pages with enough text, a small bar at the top gives you a summary in 2–3 sentences.
- **Dictate** – a microphone button under text fields types what you say. Off until you turn it on; needs a
  provider with speech-to-text.
- **Knowledge** – up to 5,000 characters of your own notes (who you are, what you study, the language you want),
  sent with every question while it's switched on.
- **AI language** – the language answers and dictation use, or Automatic.
- A Material 3 side panel in light and dark, following Chrome or your choice.

## Supported providers

Pilbot works with any OpenAI-compatible API. Setup offers these presets:

| Provider | Voice (speech-to-text) | API key |
|---|---|---|
| Groq (default) | ✓ | required |
| OpenAI | ✓ | required |
| Mistral | ✓ | required |
| OpenRouter | – | required |
| Google Gemini | – | required |
| DeepSeek | – | required |
| Ollama, LM Studio (on your computer) | – | not needed |
| Custom: any OpenAI-compatible endpoint | if it has one | required, except on `localhost` |

Groq comes with its models filled in; for the other providers you type the model IDs during setup.

## Install

Pilbot isn't in the Chrome Web Store; you load it yourself. It needs Google Chrome 123 or newer on a computer.

1. Download the ZIP from [Releases](https://github.com/jakubimr25/pilbot-extension/releases/latest) or
   [pilbot.pages.dev](https://pilbot.pages.dev) and unzip it, or clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the folder that contains `manifest.json`.
4. Pin Pilbot from the puzzle-piece menu and click its icon. The side panel opens with a three-step setup:
   provider → API key → models.

Keep the folder where it is: Chrome loads Pilbot from it. To update, replace the files in that folder and click ↻
next to Pilbot on `chrome://extensions`. Your settings and key stay.

## Privacy and security

- **No Pilbot server.** Requests go straight from your browser to the provider you set up, and only when you use a
  feature: the selected text (plus your Knowledge notes, if on), the page title and readable text for a summary, or
  the recorded audio for dictation.
- **Your key stays on your device**, encrypted with AES-256-GCM. The encryption key is a non-extractable WebCrypto
  key in the extension's own storage, and each encrypted key is bound to the endpoint it was saved for, so it can't
  be sent anywhere else.
- **HTTPS only** (plain HTTP only to `localhost`), redirects refused, no cookies, no analytics, no remote code.
- **Web pages can't drive Pilbot.** Its buttons sit in a closed shadow root and react only to real clicks; only the
  side panel can save or remove the key.
- Text in form fields, passwords, card numbers and one-time codes are never sent. The microphone is on only while
  the button is red (the toolbar icon shows "rec"), for 2 minutes at most.

The details are in the [privacy policy](https://pilbot.pages.dev/privacy). Use a separate API key for Pilbot and
set a spending limit at your provider if it offers one.

### Permissions

| Permission | Why |
|---|---|
| `storage` | Settings, your Knowledge notes and the encrypted key. |
| `sidePanel` | The panel with setup and settings. |
| `scripting` | Adds Pilbot's buttons to tabs that were already open when it was installed. |
| `offscreen` | Records the microphone while you dictate (the background worker can't use it directly). |
| Access to all `http` and `https` sites | Shows the buttons on pages, and lets Pilbot call the provider endpoint you chose. |

## Project structure

Plain JavaScript modules: no build step, no dependencies.

| File | Role |
|---|---|
| `manifest.json` | Manifest V3. |
| `background.js` | Service worker: routes messages (each type from one sender only), rate limits, recording. |
| `provider.js`, `secret-store.js` | Checks, saves and removes the provider; encrypts the key. |
| `openai.js`, `ai.js`, `prompts.js` | OpenAI-compatible client; questions, summaries and transcription; system prompts. |
| `content.js` | The buttons and answer boxes on web pages. |
| `sidepanel.html`, `sidepanel.js`, `styles.css` | The side panel: setup, features and settings. |
| `offscreen.html`, `offscreen.js` | The microphone recorder. |
| `microphone.html`, `microphone.js` | The page that asks for microphone permission. |
| `constants.js` | Shared constants, provider presets and validation. |

## Development

Load the folder unpacked (see [Install](#install)), edit, then click ↻ on `chrome://extensions` and reopen the side
panel. Design notes, data flows and the reasoning behind the security choices are in
[DEVELOPMENT.md](DEVELOPMENT.md) (in Slovak).

### Releases

1. Set the same new version in `manifest.json`, `LICENSE` and `THIRD-PARTY-NOTICES.txt`, and push to `main`.
2. On GitHub, open **Actions → Release → Run workflow**.

The [workflow](.github/workflows/release.yml) builds `pilbot-<version>.zip`, signs where it was built (a build
provenance attestation) and publishes it as an immutable release tagged `v<version>`: neither the ZIP nor the tag can
change afterwards. Anyone can check that a ZIP was built here with the [GitHub CLI](https://cli.github.com):

```bash
gh attestation verify pilbot-1.0.0.zip --repo jakubimr25/pilbot-extension
```

## License

Pilbot is free for **personal, non-commercial use** under the [Pilbot License](LICENSE): you may use it and share
unchanged copies free of charge, but not sell it or use it commercially. It's source-available, not open source.

The icons are Material Symbols by Google, under the Apache License 2.0; see
[THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).

AI answers, summaries and transcriptions can be wrong. Pilbot is provided as is, without warranty.
