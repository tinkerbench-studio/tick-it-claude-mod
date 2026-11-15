---
name: secure-personal-data
description: Secure-coding practices for personal data, covering what is collected and stored about people, what reaches logs, analytics and third parties, test data and fixtures, retention, export and deletion, and consent for cookies and tracking. Use before writing or changing code that stores, logs, sends, exports or deletes data about a person, or adds analytics or tracking, and when reviewing such a change.
---

# Secure handling of personal data

Personal data is anything that says something about a person who can be identified: a name, an email address, a booking, a location, a message, an id that leads to them. The safest data is the data that was never collected; the next safest is data few things can read and that is gone when it is no longer needed. Follow this before you write or change the code; the security reviewer checks a change in this area against the same rules. A "Must" that the change breaks is a blocking finding. Who may read a record is `tick-it:secure-access-control`; keys and encryption are `tick-it:secure-secrets`.

## Before you write

- Name the personal data the change touches, why the feature needs each item, where it is stored, who and what can read it, and when it goes. If the project keeps a record of this, the change updates it.
- Read what the project has already promised: its privacy notice, its consent rules, its data-handling documents. Code that contradicts them is a defect even when it works.

## Must

- **Collect and keep only what the feature needs.** No field stored "in case", no copy made where a reference would do, no personal data added to a record, an event or a cache that works without it.
- **Not in logs, errors, analytics or URLs.** Log an id, not the person: no names, email addresses, message bodies, addresses, document contents, tokens or full request bodies in a log line, an error report, a metric label, a trace, an analytics event or a query string. Scrub before logging, not after.
- **Not in the repository.** Fixtures, tests, seeds, screenshots, examples and documentation use invented or properly pseudonymised data. Real data copied from production does not enter git, a ticket, a pull request or a prompt.
- **A person's data reaches only that person and those they shared it with.** Every read, list, search, export and notification is scoped; a response carries the fields the screen needs, not the whole record.
- **Third parties get it only by decision.** Sending personal data to a new service, an analytics tool, a model provider or an email or message channel is called out in the pull request with what is sent and why, and matches what the project has told its users.
- **Sensitive kinds get more.** Credentials, payment details, government ids, health, precise location and the contents of private messages are encrypted where they rest, never shown in full where a mask would do, and never placed in a notification, a subject line or a preview.
- **Deletion and retention work everywhere the data went.** A new store, cache, index, backup, export or derived copy of personal data is covered by the same deletion and expiry as the original; deleting an account removes or anonymises what the change added.
- **Consent comes first where it is required.** A new cookie, identifier, tracker or analytics call that is not strictly necessary waits for the user's consent, honours its withdrawal and follows the project's consent mechanism rather than a new one.
- **Exports and shares are deliberate.** A download, a shared link, a report or an email that carries personal data is authorised for that caller, limited to what was asked for, and expires or can be revoked where it is a link.

## Should

- Pseudonymise or aggregate when the purpose allows it: a count instead of a list, a hash instead of an address.
- Keep personal data in few places, behind one module, so access and deletion can be reasoned about.
- Record access to the most sensitive data, without recording the data.

## Check before review

- Read each new log line, event and error as if it were shown to a stranger.
- Search the diff and the fixtures for real-looking names, email addresses, phone numbers and references.
- Say in the pull request what personal data the change adds or moves, where it goes and how it is deleted.
