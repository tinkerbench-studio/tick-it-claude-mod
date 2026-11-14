---
name: upload-screenshots
description: Upload a ticket's before/after pictures to Tick-it instead of committing them, and check a UI change carries them
---

Upload the picture files in a folder for a ticket (`$ARGUMENTS`: the ticket key, then the folder; the repository is the `origin` remote's owner/name).

1. `node ${CLAUDE_PLUGIN_ROOT}/scripts/upload-screenshots.mjs plan <dir>` prints the `{ name, type }` of each picture.
2. Call `presign_screenshot_upload` (repository, ticket, name, type) for each. Save the answers as a JSON array in a scratch file: each answer's `url` and `headers`, plus the `name` you passed.
3. `node ${CLAUDE_PLUGIN_ROOT}/scripts/upload-screenshots.mjs put <dir> <presigned.json>` PUTs each file and prints the `{ name }` of those accepted.
4. Call `confirm_screenshot` (repository, ticket, name) for each name printed. Only then is a picture confirmed. Never commit the pictures.

Before review, run `node ${CLAUDE_PLUGIN_ROOT}/scripts/ui-evidence-check.mjs <ticket key>`; the repository's UI path globs are in `.tick-it/ui-evidence.json`.
