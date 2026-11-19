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

Before review, run `node ${CLAUDE_PLUGIN_ROOT}/scripts/ui-evidence-check.mjs <ticket key>` (with `TICKIT_TOKEN` set): for a UI change (`design.uiPaths` in `.tick-it/config.json`) it fails when pictures are committed, and when `list_screenshots` shows no before or no after for a story or page the change touches, in each variant of `scripts/ui-evidence-required.json` (dark, light and phone), naming each; name an upload `<page>-<variant>-before.png` and `<page>-<variant>-after.png` (a `-before-after.png` from `ui:compare` counts as both). With no token, or when Tick-it cannot be reached, it fails and says so.
