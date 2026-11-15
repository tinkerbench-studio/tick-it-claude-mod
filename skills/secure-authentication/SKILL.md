---
name: secure-authentication
description: Secure-coding practices for authentication, covering sign-in and sign-up, passwords, sessions and cookies, JWTs and API tokens, OAuth and OIDC, MFA, and password reset or account recovery. Use before writing or changing any of that code, and when reviewing a change that touches it.
---

# Secure authentication

Authentication answers one question: who is this caller? Everything downstream trusts the answer, so a mistake here is a mistake everywhere. Follow this before you write or change the code; the security reviewer checks a change in this area against the same rules. A "Must" that the change breaks is a blocking finding. What a caller may then do is `tick-it:secure-access-control`; how keys and tokens are stored is `tick-it:secure-secrets`.

## Before you write

- Use what the project already has. A framework's or identity provider's sign-in, session and token handling is better tested than anything written for one ticket: extend it, and do not put a second mechanism beside it.
- Name the paths. Every way into an account is part of the change: sign-in, sign-up, reset, a magic link, an OAuth callback, an API token, a "remember me". The weakest one is the strength of the account.
- Decide what fails closed. An error, a timeout or a missing value while checking a credential is a refusal, never a pass.

## Must

- **Verify on the server, every request.** The identity comes from a credential the server checks (a session id it looks up, a token whose signature it verifies), never from a user id, an email or a role sent in the body, a query string, a header or an unsigned cookie.
- **Passwords are hashed with a password hash**: Argon2id, scrypt or bcrypt, with a salt per password and the library's current cost. Never a plain or fast hash (MD5, SHA-1, SHA-256 alone), never reversible encryption, never a comparison of plain text.
- **Secrets are compared in constant time** (the library's verify function, `timingSafeEqual`), and never appear in a log, an error, a URL or an analytics event. That covers passwords, tokens, reset codes and session ids.
- **Tokens and ids are random and long**: at least 128 bits from the platform's cryptographic generator. Never `Math.random`, a timestamp, a counter or anything derived from the user.
- **Tokens verify fully.** For a JWT: a fixed, allow-listed algorithm (never `none`, never the one the token names), the signature, `exp`, and the issuer and audience the service expects. A decoded token is not a verified one. The signing key is not in the repository.
- **Sessions end.** A session has an expiry, a new id at sign-in and at any change of privilege, and is revoked on sign-out, on a password change and when the account is removed or suspended. A stored token is kept as a hash where it only needs to be recognised.
- **Session cookies are `HttpOnly`, `Secure` and `SameSite`** (`Lax` at least), scoped to the narrowest host and path that works. A session token is not kept where page script can read it unless the design already depends on that.
- **Reset and verification links are single use, short lived and bound to the account** they were made for. Using one invalidates the others; a reset ends the account's other sessions. The answer to "does this email have an account?" is the same either way.
- **Guessing is limited**: a rate limit or lock-out on sign-in, reset, code entry and token checks, by account and by source, that an attacker cannot reset by changing a header.
- **OAuth and OIDC flows check `state`** (and use PKCE for a public client), match the redirect URI exactly against a registered list, and take the user's identity from the verified ID token or the provider's user endpoint, never from a parameter of the callback.
- **No way round.** No debug sign-in, default account, hard-coded password or "skip auth" switch that can be on outside local development; a stand-in sign-in refuses to run in a deployed copy.

## Should

- Offer or keep MFA for accounts that can do damage, and ask for the credential again before the most sensitive actions (changing the email or password, adding a key).
- Prefer short-lived access tokens with refresh over long-lived ones, and rotate refresh tokens on use.
- Give the same error and take the same time for "no such user" and "wrong password".
- Tell the account's owner when a credential, an email address or a second factor changes.

## Check before review

- Every new route, tool or handler: does it check the credential before it does anything, or say in the code why it is public?
- A test for each refusal: no credential, an expired or tampered one, and one that belongs to someone else.
- Nothing secret is logged on the failure paths you added.
