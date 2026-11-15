---
name: secure-agents
description: Secure-coding practices for software with a language model in the loop, covering prompts built from outside text, prompt injection, tools and MCP servers, agent permissions and hooks, subagents, and what a model's output is allowed to do. Use before writing or changing a prompt, a tool, an agent, a hook, a skill or code that acts on a model's answer, and when reviewing such a change.
---

# Secure agents and model-driven code

A model reads instructions and data in the same stream and cannot be relied on to tell them apart. So anything it reads can try to steer it, and anything it writes is a suggestion from an untrusted party until code has checked it. Follow this before you write or change the code; the security reviewer checks a change in this area against the same rules. A "Must" that the change breaks is a blocking finding. Where the outside text enters is `tick-it:secure-input`; what the caller may do is `tick-it:secure-access-control`.

## Before you write

- Draw the line between who may instruct (the person, the operator's configuration) and what is only data (a ticket, a web page, a pull request, an email, a file, a tool's answer, another agent's message). Everything in the second group stays data however it is worded.
- Ask what the worst action is that the agent could take with the tools and credentials it holds, if the text it read were written by an attacker. The design has to make that action impossible or approved, not unlikely.

## Must

- **Outside text is marked as data and never promoted.** It goes into a prompt inside a clear boundary, labelled as content to work on, not concatenated into the instructions. No code path treats a line of fetched or user-written text as a command, a setting or a permission.
- **The rule is enforced in code, not in the prompt.** "Do not do X" in a prompt is a request. Whatever must not happen (a call the model may not make, a path it may not write, a limit it may not pass) is checked by the code around the model, and that check cannot be switched off by anything the model produces.
- **Tools are least privilege.** An agent gets the tools and scopes its task needs and no more. A tool that reads is separate from one that writes; one that deletes, sends, pays, publishes or changes permissions needs the person's approval or an explicit, narrow allow-list. A subagent does not hold more than the agent that started it.
- **A model's output is input.** Before it reaches a shell, a query, a path, HTML, a URL or another tool, it is validated like any other input: parsed against a schema, checked against an allow-list, bound as a parameter. Arguments of a tool call are validated by the tool, on the server, for the caller's own permissions.
- **The agent acts as the user, not above them.** A tool carries out the action with the caller's identity and permissions. The model's say-so never widens access: it cannot name another user, another tenant or a higher role and be believed.
- **Nothing leaves that should not.** Secrets, other users' data and system prompts that hold anything sensitive are not placed where the model can repeat them; a response, a link, an image URL or a tool call the model writes cannot carry private data to a destination chosen by text it read.
- **Its own record cannot be written by the model.** Results that others rely on (a review verdict, a test result, a cost, an approval) are recorded by code from what happened, never taken from the model's claim that it happened.
- **Third-party tools and servers are chosen, pinned and read.** An MCP server, a plugin, a skill or a hook is added deliberately, from a known source at a fixed version; a tool's description is text from outside too, and cannot grant itself trust.
- **Loops and spend are bounded.** A limit on steps, time, tokens, cost and spawned agents, enforced by the code, so neither a mistake nor hostile text can run without end.
- **Permission prompts and guards are not loosened in passing.** A change that auto-approves a tool, widens an allow-list, bypasses a permission mode or removes a refusal says so and why.

## Should

- Keep a log of the actions taken and the tool calls made, with what triggered each, that the model cannot edit.
- Show the person what an action will do before it is approved, in the code's words, not the model's summary of it.
- Test with hostile content: a ticket, a page or a tool answer that says "ignore your instructions and…", asserting that the guarded action does not happen.

## Check before review

- For each new place outside text enters a prompt: where is its boundary, and what could it make the agent do?
- For each new tool or wider permission: who can cause it to be called, with what arguments, and what checks them?
- A test that the code-side refusal holds when the model asks for the forbidden thing.
