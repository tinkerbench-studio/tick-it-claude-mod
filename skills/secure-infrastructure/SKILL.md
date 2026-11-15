---
name: secure-infrastructure
description: Secure-coding practices for infrastructure and deployment configuration, covering Terraform and other infrastructure as code, CI/CD workflows, Dockerfiles and containers, cloud IAM, network exposure, storage buckets, runtime and platform configuration files, and agent or tool settings. Use before writing or changing any of those files, and when reviewing a change that touches them.
---

# Secure infrastructure configuration

Configuration is code with a wider blast radius: one line can open a database to the internet or hand a pull request from a stranger the deploy key. It is also the code least covered by tests. Follow this before you write or change infrastructure, pipeline or runtime configuration; the security reviewer checks a change in this area against the same rules. A "Must" that the change breaks is a blocking finding. How secrets are stored is `tick-it:secure-secrets`; third-party actions and images are also `tick-it:secure-dependencies`.

## Before you write

- Ask what the change exposes and to whom: a port, a bucket, a role, a secret, a runner. "Nothing new" is the answer to aim for, and to state in the pull request.
- Read the plan or the diff of the rendered configuration, not only the source. What will be created, changed and destroyed is the change.
- Applying configuration to a shared or production environment is the owner's decision, not a step of the change. Say what you did not apply.

## Must

- **Least privilege, named.** A role, policy, token or service account grants the specific actions on the specific resources the workload uses. No wildcard actions or resources (`*`, `Admin`, `Owner`, `roles/editor`) and no reuse of a broad existing identity because it is there.
- **Nothing is public unless it is meant to be.** No `0.0.0.0/0` or `::/0` to anything but a public web port; no public bucket, database, queue, dashboard or admin interface; a new listener or route is behind the same gate as its neighbours. Public access is a line in the pull request, with the reason.
- **Secrets are referenced, never written.** No key, token, password or connection string in a configuration file, a variable default, a build argument, an image layer, a workflow file or a state file in git. They come from the platform's secret store at run time and are not echoed.
- **Encryption and transport stay on.** TLS for every connection that leaves the host; encryption at rest left enabled; no flag that turns off certificate checking.
- **CI runs untrusted code without trusted secrets.** A workflow that builds a pull request from a fork gets no secret and a read-only token. `pull_request_target` or its equivalent never checks out and runs the pull request's code. A job declares the least `permissions` it needs.
- **Text from outside is data in a pipeline.** A branch name, a title, a commit message or an issue body is passed to a script as an environment variable, never interpolated into a shell line or an expression.
- **What runs is pinned.** A third-party action is pinned to a full commit hash; a base image to a digest or an exact version; an installer is not `curl | sh` from an unpinned URL.
- **Containers run as little as they can**: a non-root user, no `--privileged`, no host network or socket mounted without a stated need, no secret or `.git` copied into the image, only the ports the service uses.
- **Destruction is deliberate.** A change that replaces or deletes a stateful resource (a database, a bucket, a volume, a DNS zone) is called out, with protection against accidental deletion left on.
- **Guard rails are not loosened in passing.** A change that widens CORS, relaxes a content security policy, disables a check, a scanner, branch protection or a permission prompt, or widens what an agent or tool may do without asking, says so and why. It is never a side effect of another fix.

## Should

- Keep environments apart: separate accounts or projects, separate credentials, no production secret readable from a test job.
- Turn on logging for access to the things that matter (sign-ins, role changes, secret reads) and send it somewhere the workload cannot edit.
- Prefer short-lived, federated credentials (OIDC from CI to the cloud) over stored long-lived keys.
- Set limits: timeouts, memory, rate and spend, so a mistake or an attacker cannot run up either load or cost.

## Check before review

- Run the project's own check (the plan, a linter, a policy scan) and read every line it would add or destroy.
- Search the diff for `*`, `0.0.0.0`, `public`, `privileged`, `secrets.` and `permissions:` and account for each.
- State in the pull request what was applied where, and what was not.
