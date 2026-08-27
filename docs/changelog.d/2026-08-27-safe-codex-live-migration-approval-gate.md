## 2026-08-27 — Safe Codex live-migration approval gate

Codex previously blocked every live migration even after Mason explicitly approved it. The first
candidate fix used text from UserPromptSubmit as an approval token, but exact-commit adversarial
review proved that relayed machine text could be mistaken for Mason's authorship. That design was
removed before release.

The replacement moves production credentials and execution out of the local Codex shell. A manual
GitHub workflow accepts one exact current-main commit, reviewed PR-head commit, human-dispatched
full two-charter clean-review evidence, timestamped migration filename, and SQL SHA-256. The workflow
parses and preserves that evidence, rejects non-regular Git migration entries, and rebuilds from the
immutable commit blob so a symlink cannot redirect the bytes applied.
Its `production-database` environment requires Mason's GitHub account, rejects administrator bypass,
and releases its credentials only after the website approval. Mason does not need a second account:
Codex uses a fine-grained machine credential with Actions and Deployments both read-only, so it can
inspect the run but GitHub refuses both dispatch and approval attempts from it. Mason starts and
approves the run from his signed-in website session.

The generated batch takes a transaction-scoped advisory lock plus a live ledger table lock, refuses
duplicate versions, names, or exact SQL content and any migration not newer than the live effective
high-water mark, runs compatible SQL, writes and verifies the hash-bound ledger row, then commits.
It rejects a second embedded timestamp in a filename, preventing a future-dated alias from replaying
an old migration. Its atomicity decision now reuses the repository's canonical transaction wrapper
classifier, including `CLUSTER`. Migrations with transaction control, `CONCURRENTLY`, database-level
DDL, client meta-commands, or other non-atomic forms remain parked.

Before Mason can approve a run, GitHub verifies Mason's manual dispatch, the PR whose head received
the review, the PR's merge as the still-current `main`, and byte-identical migration Git blobs before
and after merge. Every third-party action in the credential-bearing path
is pinned to a full audited commit. The official Supabase setup action is pinned to v3.0.0's exact
commit, which verifies npm package integrity; the workflow separately asserts CLI version 2.109.1.

Prevention tests mutation-test wrong project, missing file, wrong hash, stale timestamp aliases,
non-human dispatch and merged-PR mismatches, PostgreSQL transaction aliases, non-atomic commands,
lock/order placement, ledger binding, action pinning, and no-overwrite behavior without a network or
live database. Ordinary PR CI and the production
workflow both run the owning test. The workflow remains inert until the protected environment,
least-privilege Codex credential, and production secrets are installed and their deny path is proven.
