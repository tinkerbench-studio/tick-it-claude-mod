---
name: secure-dependencies
description: Secure-coding practices for third-party code, covering adding, upgrading or removing a package, lock files and version pinning, install scripts, registries, GitHub Actions and container base images, and plugins or tools fetched at build or run time. Use before adding or changing a dependency or anything that downloads code, and when reviewing a change to a manifest or lock file.
---

# Secure dependencies

A dependency runs with everything the application can reach, and so does everything it depends on. Adding one is a decision to trust its maintainers and their accounts, now and at every later version. Follow this before you add or change one; the security reviewer checks a change in this area against the same rules. A "Must" that the change breaks is a blocking finding. Pipelines and images are also `tick-it:secure-infrastructure`.

## Before you add one

- Ask whether it is needed. The platform, the standard library or a dependency the project already has often does the job; a few lines written here are easier to review than a package.
- Check the package itself: the exact name (a near-miss name is a common trap), that it is the project it claims to be, that it is maintained and released recently, how widely it is used, its licence, and what it pulls in.
- A package name suggested by a model, a snippet or an error message is a claim. Confirm that it exists and is the well-known one before installing it: names that do not exist get registered by attackers.

## Must

- **Pinned the way the project pins.** The same form of version as its neighbours (exact where the project uses exact), and the lock file updated in the same change by the package manager, never edited by hand. A lock-file change with no manifest change, or the reverse, is explained.
- **From the registry the project uses.** No dependency from a URL, a tarball, a fork or a git branch unless the project already does that and the reference is a full commit hash. No new registry or scope mapping slipped into the package manager's configuration.
- **Nothing runs at install that the project has not allowed.** A new install or post-install script, a native build or a binary download is named in the pull request; where the project has an allow-list of packages that may run scripts, the new one is added there deliberately or not at all.
- **Known vulnerabilities are looked at.** Run the project's audit for the new or changed package. A finding that applies is fixed by a version that does not have it; one that does not apply is said so in the pull request, not silenced globally.
- **Actions, images and tools fetched at build or run time are pinned too**: a third-party action to a full commit hash, a base image to a digest or an exact version, a downloaded tool to a version with its checksum verified. Never `latest`, a moving tag or `curl | sh`.
- **It gets no more than it needs.** A build-time tool is a development dependency, not shipped. A package that only formats dates is not given the network, the file system or a secret by where it is called from.
- **Upgrades are read.** For a major version, or a package near anything sensitive (authentication, cryptography, parsing, the build), read the changelog for what changed in behaviour and defaults, and run the whole test suite, not the tests near the change.
- **Removed means removed.** A dependency no longer used leaves the manifest and the lock file, with its configuration and its allow-list entries.

## Should

- Prefer a package with few dependencies of its own, and one whose releases are signed or carry provenance.
- Keep the diff of a lock file to what the change needs: no unrelated upgrades riding along.
- Wrap a dependency that touches something sensitive behind one module, so it can be replaced and its use reviewed in one place.

## Check before review

- State in the pull request each dependency added, upgraded or removed, with the reason and what was checked.
- Read the lock-file diff: every new name is one you expected, from the registry you expected.
- The project's install, audit and full test commands were run on the change.
