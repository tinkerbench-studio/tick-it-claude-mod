---
name: secure-secrets
description: Secure-coding practices for secrets and cryptography, covering API keys, tokens, passwords and connection strings, environment variables and secret stores, encryption, hashing, signatures and random values, and what reaches logs and error messages. Use before writing or changing code that reads, stores, compares, generates or transmits a secret, or that encrypts, hashes or signs, and when reviewing such a change.
---

# Secure secrets and cryptography

A secret is safe only while few things can read it and none of them repeats it. Cryptography is safe only when it is the library's, used the way the library says. Follow this before you write or change the code; the security reviewer checks a change in this area against the same rules. A "Must" that the change breaks is a blocking finding. Passwords and session tokens are also `tick-it:secure-authentication`.

## Before you write

- Find where the project keeps its secrets (a secret store, the platform's bindings, a vault) and how code reads them. A new secret goes there, by the naming it already uses.
- Decide who needs it. A secret used by the server never reaches the browser, a mobile build, a test fixture or a model's prompt.
- If you were shown a real secret while working (in a file, a log, a message), do not copy it anywhere, and tell the person it may need rotating.

## Must

- **No secret in the repository.** Not in code, configuration, a fixture, a test, a comment, documentation, a commit message or a pull request. An example uses an obviously fake value. A secret that was committed is compromised: it is rotated, not only deleted.
- **No secret in what leaves.** Logs, error messages, analytics, URLs and query strings, a response body, a tool's answer and a prompt carry none. Log that a key was used and its last few characters at most; scrub headers and bodies before logging a request.
- **Nothing secret in client code.** Anything shipped to a browser or an app can be read: only keys designed to be public go there, and a public prefix on an environment variable is a decision to publish it.
- **Read at run time, held briefly.** A secret comes from the store or the environment when it is needed; it is not written to disk, a cache, a build output or an image, and not passed as a command-line argument, which other processes can see.
- **Fail closed when it is missing.** A missing or empty secret stops the feature with a clear server-side error. It never falls back to a default, an empty key or a skipped check.
- **Compare in constant time** (`timingSafeEqual`, the library's verify) whenever one side is a secret, a MAC or a signature.
- **Use the platform's cryptography, never your own.** Authenticated encryption (AES-GCM, ChaCha20-Poly1305) with a fresh nonce per message; SHA-256 or better for hashing; HMAC or a real signature scheme to prove origin; a password hash for passwords. No MD5, SHA-1, DES, RC4 or ECB for anything that protects data, and no invented scheme.
- **Random means cryptographically random** for anything that must not be guessed: the platform's secure generator, at least 128 bits. Never `Math.random` or a clock.
- **Verify before you trust.** A webhook, a signed URL, a token or a signed cookie is checked against its signature, with the exact bytes received, before any of its content is used; a signed message also carries something that stops it being replayed (a timestamp, a nonce).
- **Keys are separate and replaceable.** A different key per purpose and per environment; a way to rotate one without redeploying everything; no key derived from a value an outsider can know.

## Should

- Store only what must be recovered. Keep a token as a hash when it only needs recognising, and show a secret to its owner once.
- Scope each key to the least it can do, and give it an expiry.
- Mask a secret on screen and name it so that secret scanning recognises it.

## Check before review

- Run the project's secret scanner, or search the diff for long random strings, `key`, `token`, `secret`, `password` and `BEGIN`.
- Read every log and error line you added as if it were public.
- A test for the missing-secret path and for a bad signature, each asserting a refusal.
