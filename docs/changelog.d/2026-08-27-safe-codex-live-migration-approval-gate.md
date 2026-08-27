## 2026-08-27 — Safe Codex live-migration approval gate

Codex previously blocked every live migration even after Mason explicitly approved it. The first
candidate fix used text from UserPromptSubmit as an approval token, but exact-commit adversarial
review proved that relayed machine text could be mistaken for Mason's authorship. That design was
removed before release.

The replacement disables Codex's raw Supabase `apply_migration` and `execute_sql` tools. A local,
CRX-only bridge exposes one write tool: it reads the exact timestamped migration file from the repo,
verifies the caller-supplied SHA-256, fixed production project, ordered snapshot, current review
proof, and destructive-SQL rules inside the tool handler, and only then transmits an atomic batch.
That tool uses Codex's native approval prompt routed to Mason, not the automatic reviewer.

The atomic batch refuses a duplicate version/name, runs compatible migration SQL and its ledger row
in one transaction, verifies the content-bound ledger row afterwards, then invokes the existing
registry-stale and applied-snapshot invalidation hooks. Migrations with their own transaction
control or operations such as `CONCURRENTLY` remain parked for a human-operated path. Passing the
technical gate does not approve production: Mason must approve that specific native tool prompt.

Prevention tests mutation-test the wrong-project, missing-file, wrong-hash, missing-review,
non-transactional, duplicate-ledger, post-apply, and native protocol paths without a live
connection. The bridge, configuration, shared migration rules, and maintenance producer become
protected harness files only after a fresh exact-head gpt-5.6-sol/high proof validates the producer
and its pinned preimages.
