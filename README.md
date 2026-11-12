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

## Features

- **Ask** – select a question on a page and click the speech-bubble button next to it, or press
  <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>Q</kbd> (<kbd>Option</kbd>+<kbd>Shift</kbd>+<kbd>Q</kbd> on a Mac).
  A short answer shows in the bottom-left corner.
- **Summarize** – on pages with enough text, a bar at the top gives a summary in 2–3 sentences.
- **Dictate** – a microphone button under text fields types what you say. Off until you turn it on.
- **Knowledge** – up to 5,000 characters of your own notes, sent with every question while it's on.
- **AI language** – the language of answers and dictation, or Automatic.

## How it works

Pilbot calls any OpenAI-compatible API with your own key. The side panel sets it up in three steps:

1. **Provider** – Groq, OpenAI, OpenRouter, Google Gemini, Mistral, DeepSeek, Ollama or LM Studio on your
   computer, or any other OpenAI-compatible endpoint.
2. **API key and answer timeout** – Pilbot checks the key with the provider. The timeout is how long it waits
   for an answer: 45 seconds unless you change it (10–240).
3. **Models** – pick a chat model from the provider's list or type its ID. A speech-to-text model is optional
   and turns on dictation (Groq, OpenAI, Mistral, or a custom endpoint that has one).

You can change all of it later in the side panel: Settings → Edit provider.

## Install

Pilbot isn't in the Chrome Web Store; you load it yourself. It needs Google Chrome 123 or newer on a computer.

1. Download the ZIP from [Releases](https://github.com/jakubimr25/pilbot-extension/releases/latest) or
   [pilbot.pages.dev](https://pilbot.pages.dev) and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the folder that contains `manifest.json`.
4. Pin Pilbot from the puzzle-piece menu and click its icon to open the setup.

Keep the folder where it is: Chrome loads Pilbot from it. To update, replace the files in that folder and click ↻
next to Pilbot on `chrome://extensions`. Your settings and key stay.

## Privacy and security

- **No Pilbot server.** Requests go straight from your browser to your provider, and only when you use a feature.
- **Your key stays on your device**, encrypted (AES-256-GCM), and is only ever sent to the endpoint it was saved
  for.
- **HTTPS only** (plain HTTP only to `localhost`), redirects refused, no cookies, no analytics, no remote code.
- **Web pages can't control Pilbot.** Only the side panel can save or remove the key.
- Text in form fields, passwords, card numbers and one-time codes are never sent. The microphone is on only while
  you dictate, for 2 minutes at most.

Use a separate API key for Pilbot and set a spending limit at your provider if it offers one. Details are in the
[privacy policy](https://pilbot.pages.dev/privacy).

| Permission | Why |
|---|---|
| `storage` | Settings, your Knowledge notes and the encrypted key. |
| `sidePanel` | The panel with setup and settings. |
| `scripting` | Adds Pilbot's buttons to tabs that were open before it was installed. |
| `offscreen` | Records the microphone while you dictate. |
| Access to all `http` and `https` sites | Shows the buttons on pages and calls the provider you chose. |

## Development

Plain JavaScript modules: no build step, no dependencies. Load the folder unpacked, edit, then click ↻ on
`chrome://extensions` and reopen the side panel.

To release a version:

1. Set the same new version in `manifest.json`, `LICENSE` and `THIRD-PARTY-NOTICES.txt`, and push to `main`.
2. On GitHub, open **Actions → Release → Run workflow**.

The [workflow](.github/workflows/release.yml) publishes `pilbot-<version>.zip` as an immutable release tagged
`v<version>`, with a build provenance attestation. To check that a ZIP was built here:

```bash
gh attestation verify pilbot-<version>.zip --repo jakubimr25/pilbot-extension
```

## License

Free for **personal, non-commercial use** under the [Pilbot License](LICENSE): you may use it and share unchanged
copies free of charge, but not sell it or use it commercially. It's source-available, not open source. The icons
are Material Symbols by Google, under the Apache License 2.0 ([THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt)).

AI tools were used to build this project, including its code and documentation. AI answers, summaries and
transcriptions can be wrong. Pilbot is provided as is, without warranty.
