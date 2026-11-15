---
name: secure-web
description: Secure-coding practices for the browser side of a web application, covering cross-site scripting and HTML built from data, CSRF, cookies, CORS, security headers and content security policy, postMessage, and third-party scripts. Use before writing or changing code that renders data into a page, sets a cookie or a response header, handles a state-changing request from a browser, or configures CORS, and when reviewing such a change.
---

# Secure web pages and browser-facing responses

The browser runs whatever the page tells it to, with the user's session. So data must never become markup or script by accident, and a request must never count as the user's wish merely because their browser sent it. Follow this before you write or change the code; the security reviewer checks a change in this area against the same rules. A "Must" that the change breaks is a blocking finding. Where the data came from is `tick-it:secure-input`; sessions are `tick-it:secure-authentication`.

## Before you write

- Use the framework's or the project's own rendering and escaping. Its default (auto-escaped templates, JSX text, the project's `escape` helper) is the safe path; every step off it needs a reason.
- Know the context a value lands in: element text, an attribute, a URL, a script, a style. Each needs a different encoding, and the wrong one is no encoding.

## Must

- **Data is escaped for the context it is written into**, at the point of writing. Text goes in as text. A value in an attribute is quoted and attribute-escaped. Data for a script is delivered as JSON in a data attribute or a JSON script block and parsed, never concatenated into script source.
- **No raw HTML from data.** `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `dangerouslySetInnerHTML`, `v-html`, a template's "raw" or "safe" filter and their like take only constants, or HTML that has just passed a maintained sanitiser with an allow-list. A hand-written sanitiser or a regular expression is not one.
- **A URL from data is checked before it is used** as an `href`, `src`, form action or redirect: only `http`, `https`, `mailto` or a relative path. `javascript:` and `data:` are refused, including in mixed case or encoded.
- **Changing state takes more than a cookie.** Every request that changes something uses a method other than GET and is protected against cross-site forgery: the framework's CSRF token, or a `SameSite` session cookie together with a check of `Origin`. A sign-in, a sign-out and a JSON endpoint are not exempt because they are unusual.
- **Session cookies are `HttpOnly`, `Secure` and `SameSite`**, with the narrowest domain and path. Nothing that proves identity is kept in `localStorage` unless the design already rests on that.
- **CORS names its origins.** `Access-Control-Allow-Origin` is one of a fixed list, compared exactly; never the request's own `Origin` reflected back, never `*` together with credentials, never a suffix or substring match. A route that needs no cross-origin caller sends no CORS headers.
- **Security headers are kept, not weakened.** A content security policy without `unsafe-inline` or `unsafe-eval` for scripts where the project has one; `X-Content-Type-Options: nosniff`; framing refused or limited (`frame-ancestors`); HTTPS enforced with HSTS. A change that loosens one says so and why.
- **`postMessage` is checked both ways**: a named target origin when sending, never `*` for anything private; the `origin` and the shape of the data verified when receiving.
- **Links that open a new context and content from elsewhere are contained**: `rel="noopener"` where the browser does not already imply it, user content in an `iframe` given a `sandbox`, and a third-party script loaded from a pinned version with integrity where it is loaded at all.
- **Nothing private in the page that the user should not see.** A value hidden with CSS, left in a data attribute, a comment, a source map or the bundled configuration is published.

## Should

- Serve files users uploaded from a separate origin, as downloads.
- Send `Referrer-Policy` and a `Permissions-Policy` that turn off what the page does not use.
- Keep secrets out of URLs: they end up in history, logs and the `Referer` of the next request.
- Mark cache-sensitive responses `Cache-Control: no-store`, so a shared cache or the back button does not show one user's page to another.

## Check before review

- For each value newly rendered: a test or a story with `<img src=x onerror=alert(1)>` and `"><script>` showing it arrives as text.
- For each new state-changing route: a request from another origin, and one without the token, both refused.
- Search the diff for the raw-HTML sinks and for `Access-Control`, `SameSite`, `Content-Security-Policy`.
