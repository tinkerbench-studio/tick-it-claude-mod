---
name: upload-screenshots
description: Upload a ticket's before/after pictures to Tick-it with presign_screenshot_upload and confirm_screenshot instead of committing them. Use when a UI change needs its pictures, or on /tick-it:upload-screenshots.
argument-hint: <ticket key> <picture folder>
---

Upload the picture files in a folder for a ticket (`$ARGUMENTS`: the ticket key, then the folder; the repository is the `origin` remote's owner/name).

1. `node ${CLAUDE_PLUGIN_ROOT}/scripts/upload-screenshots.mjs plan <dir>` prints the `{ name, type }` of each picture.
2. Call `presign_screenshot_upload` (repository, ticket, name, type) for each. Save the answers as a JSON array in a scratch file: each answer's `url` and `headers`, plus the `name` you passed.
3. `node ${CLAUDE_PLUGIN_ROOT}/scripts/upload-screenshots.mjs put <dir> <presigned.json>` PUTs each file and prints `{ "confirm": [{ "name" }] }` for those accepted.
4. Call `confirm_screenshot` (repository, ticket, name) for each name printed. Only then is a picture confirmed. Never commit the pictures.

Before review, run `node ${CLAUDE_PLUGIN_ROOT}/scripts/ui-evidence-check.mjs <ticket key>`: it fails a UI change (`design.uiPaths` in `.tick-it/config.json`) that commits pictures, or whose uploaded pictures (read from Tick-it with `list_screenshots`, with `TICKIT_TOKEN` set) lack a before or an after for a story or page in a variant that `scripts/ui-evidence-required.json` lists (dark, light and 390 px phone), naming each. Name a touched story or page no picture shows yet with `--touches`, and one the change adds with `--new`.
