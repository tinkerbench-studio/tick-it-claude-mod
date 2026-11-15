---
name: secure-access-control
description: Secure-coding practices for access control, covering permissions, roles, scopes, ownership checks, admin-only actions, multi-tenant isolation and membership changes. Use before writing or changing code that decides who may read or change something, when adding a route, tool or query that returns someone's data, and when reviewing such a change.
---

# Secure access control

Access control answers: may this caller do this, to this thing? Most real breaches of an application are here, as a check that is missing on one path, not one that is wrong. Follow this before you write or change the code; the security reviewer checks a change in this area against the same rules. A "Must" that the change breaks is a blocking finding. Who the caller is belongs to `tick-it:secure-authentication`.

## Before you write

- Write down the rule in one sentence: who may do it, to what, and under which condition ("a member of the repository may read its tickets; only its owner may add or remove members"). If you cannot, the code will not be right either.
- Find the place the project already makes this decision (a policy module, a guard, a helper that scopes a query) and go through it. A check retyped in a handler drifts from the others.
- List every path to the same data: the page, the API route, the export, the search, the background job, the tool an agent calls. Each needs the check.

## Must

- **Deny by default.** A route, tool or action with no rule refuses. Access is granted by a check that passed, never by the absence of one that failed, and an error while checking is a refusal.
- **Check on the server, on every request, for the object asked for.** Not once at sign-in, not in the client, not by hiding a button. An id in the request is a claim: confirm the caller may reach *that* record (it is theirs, or their organisation's, or shared with them) before reading or changing it.
- **Scope the query, not only the route.** Fetch with the owner or tenant in the condition (`WHERE id = ? AND owner_id = ?`) so another tenant's row cannot come back, and check the parent when the thing belongs to one (a comment's post, a file's project).
- **The caller's role, tenant and permissions come from the server's record of them**, looked up from the verified identity. Never from the request body, a query parameter, a header the caller sets or a claim the caller could have written.
- **Changes to roles and membership are themselves guarded**: only a role above may grant one, nobody raises their own, and the last owner cannot be removed. A change takes effect at once, so tokens and sessions issued under the old role stop carrying it.
- **Write only the fields the caller may set.** Take named fields from the input; never pass the whole body to an update, or a field like `role`, `ownerId`, `isAdmin` or `tenantId` becomes writable.
- **A refusal gives nothing away**: the same answer for "not yours" and "does not exist" where existence is itself private, and no record, count or name in the error.
- **Admin and internal surfaces are behind their own gate**, checked in the handler as well as at the network edge. An internal route is not safe because nobody links to it.
- **A machine caller gets the least it needs**: a token's scopes are checked per action, and a new scope or role is not wider than the feature requires.

## Should

- Use identifiers that cannot be guessed (UUIDs, ULIDs) for anything reachable by id; they are not a substitute for the check.
- Keep the decision in one function per rule, with a name that says the rule, so a reviewer and a test can find it.
- Record who granted, changed or used a privileged permission.

## Check before review

- For each new or changed way in: one test per kind of caller who must be refused (no credential or missing scope, a role too low, a member of another tenant), asserting the reason and that nothing was written.
- Try the id of something that is not yours in every parameter you added.
- Search for the other places that return the same data and confirm each makes the same check.
