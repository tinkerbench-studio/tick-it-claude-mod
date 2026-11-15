---
name: secure-input
description: Secure-coding practices for untrusted input, covering validation at the boundary, shell commands and subprocesses, file paths and uploads, URLs fetched by the server (SSRF), redirects, webhooks, and parsers for XML, YAML, archives and serialised objects. Use before writing or changing code that takes data from a request, a file, a queue, a webhook, a command line or another service and passes it on, and when reviewing such a change.
---

# Secure handling of input

Input is anything the code did not make itself: a request, an upload, a header, a webhook, a file name, a row someone once wrote, an answer from another service. It becomes dangerous at a sink, a place that interprets it: a shell, a path, a parser, a URL, a redirect. Follow this before you write or change the code; the security reviewer checks a change in this area against the same rules. A "Must" that the change breaks is a blocking finding. SQL is `tick-it:secure-database`; HTML is `tick-it:secure-web`; prompts are `tick-it:secure-agents`.

## Before you write

- Trace each new value from where it enters to every place it is used. The rule belongs at the boundary where it enters; the encoding belongs at the sink.
- Use the project's own validation layer and its schema library. A rule retyped in a handler is the one that gets forgotten.

## Must

- **Validate at the boundary, on the server, against what is allowed**: the type, the length, the range, the format, the set of permitted values. Reject what does not fit; do not try to repair it. A block-list of bad strings is not validation. Checks in the client are for the user's convenience only.
- **No input in a shell line.** Run a program with an argument array and no shell; never build a command string. A value that must be an argument is validated, and placed after `--` where the program supports it so it cannot be read as an option. No `eval`, `new Function` or dynamic `import` of anything input chose.
- **A path stays where it is meant to.** Do not use a supplied name as a path. Where one is needed: resolve it against the base directory, then confirm the result is still inside that directory, after decoding and after following links; reject `..`, absolute paths and separators in a name. Better: store under an id the server made, and keep the supplied name as data.
- **Uploads are untrusted files.** Limit the size before reading; decide the type from the content and an allow-list, not the supplied name or header; give the stored file a new name; keep it outside anything that executes or serves it as a page; serve it with its own content type, `nosniff` and, for anything not meant to render, as a download.
- **The server does not fetch what the caller says.** A URL from input is parsed and checked against an allow-list of schemes and hosts; private, loopback, link-local and metadata addresses are refused after DNS resolution and again on each redirect; the request has a timeout and a size limit; the raw response is not handed back.
- **Redirects go where the server decided.** A redirect target from input is a relative path the application owns or an entry on an allow-list; `//host`, `\`, a scheme and an encoded variant are refused.
- **Parsers are configured not to reach out or run code.** XML with external entities and DTDs off; YAML with the safe loader; no native deserialisation (`pickle`, Java or PHP object streams, `Marshal`) of anything from outside; archives extracted with a check on each entry's path and the total size.
- **A webhook or callback proves where it came from**: its signature is verified over the raw body before any of it is used, and a repeated delivery is harmless.
- **Size and cost are bounded.** A body, a list, a page size, a recursion depth and a regular expression run on input each have a limit; an input cannot make one request arbitrarily expensive.
- **Errors do not echo.** A validation error names the field and the rule, not the stack, the path on disk or the value of someone else's data.

## Should

- Parse into a typed value once and pass that on, so later code cannot receive the raw string.
- Normalise before you compare (case, Unicode form, trailing dots and slashes) and compare the normalised form everywhere.
- Prefer an identifier the server issued over a name the caller chose, anywhere a name would be used to look something up.

## Check before review

- For each new input: a test with the hostile value for its sink (`; rm -rf`, `../../etc/passwd`, `http://169.254.169.254/`, `//evil.example`, a 50 MB body) asserting a refusal.
- Search the diff for the sinks: process spawning, file-system calls, HTTP clients, redirects, parsers, `eval`.
