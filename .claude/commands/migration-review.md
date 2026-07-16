Run a deep, verified review of a Supabase migration BEFORE applying it — and, if it comes back clean, write the proof file that `migration-apply-guard` requires so the apply isn't blocked.

This is the turnkey front door for the `migration-review` Workflow. The workflow does the heavy parallel review; this command stamps the proof and reports the result in plain English for Mason.

## What this catches
The B7/B8/B9 (2026-05-26) class and the March-2026 40-bug class: anon-EXECUTE-able SECURITY DEFINER DML, missing `search_path`, missing RLS on new tables, actor-forgery, CHECK-constraint regressions, function-overload collisions, column-name drift, and `updated_at` writes on tables that lack the column.

## Steps

### 1. Identify the migration
The argument is the migration file path (preferred), e.g. `supabase/migrations/20260530120000_add_foo.sql`. If the user is about to apply inline SQL with no file, capture the `name` and `sql` instead.

### 2. Run the workflow
Invoke the `migration-review` Workflow with the migration as args:
- file on disk:  `args = { file: '<path>' }`
- inline SQL:    `args = { name: '<name>', sql: '<the SQL>' }`

The workflow runs `rls-security-reviewer` + `migration-drift-reviewer` + `typescript-types-drift-reviewer` in parallel, then has independent skeptics try to **refute** every BLOCKER (a blocker is only dropped if BOTH skeptics refute it — security-conservative). It returns:
`{ migration, verdict: 'clean' | 'blocked', realBlockers[], refutedBlockers[], allFindings[], reviewers[] }`.

### 3a. If verdict is `'clean'`
1. Stamp the proof with the sanctioned wrapper — do NOT hand-write the JSON (it computes
   the timestamp, the guard's slug rule, and the content-binding `queryHash` from the
   on-disk file itself):
   ```
   node scripts/write-apply-proofs.mjs <migration-name-without-.sql>
   ```
   The wrapper ALWAYS runs a real, read-only review with the trusted Codex CLI and mints
   the proof pair (reviewer half + second-model half) only on a CLEAN machine verdict —
   there is no way to stamp a proof without that run (a BLOCKERS or failed run mints
   nothing; fix the findings or park the migration).
   IMPORTANT: the migration name must substring-match the `name` you will pass to
   `apply_migration`, or the guard won't match the proof. Proofs expire after 30 minutes.
   If the migration is edited after stamping, the hash no longer matches — re-run the
   review, then re-stamp.
2. Tell Mason it's clean, list any MED/LOW findings as FYI (not blockers), and list the `refutedBlockers` so he can see what was checked and dismissed.

### 3b. If verdict is `'blocked'`
1. Do NOT write a proof file. Do NOT apply.
2. Show Mason each real blocker in plain English: what it is, where (`location`), why it matters, and the recommended fix.
3. Offer to fix them. After fixing, re-run this command — the workflow re-verifies, and only a clean pass produces a proof.

### 4. Apply (only after a clean proof exists, and only with Mason's authorization)
The proof unblocks `apply_migration`; it does not authorize it. Two authorization paths (settled 2026-07-13 policy):
- **Interactive session (default):** explain the migration (offer `/explain-migration`) and wait for Mason's in-chat approval before the apply call.
- **Pre-authorized hands-free run** (Mason explicitly asked for the run AND autopilot is armed): no per-migration ask, but the Codex gate is mandatory — run `node scripts/write-apply-proofs.mjs <mig-name>`, which runs the trusted Codex CLI itself and mints the content-bound proof pair only on a CLEAN machine verdict (hand-writing the proof is blocked by review-proof-guard, by design). The apply-guard refuses hands-free applies without it, and refuses DESTRUCTIVE migrations (data deletes, schema/table/column/type drops, MERGE) outright — park those for Mason.

## Hard rules
- **Read-only review.** The workflow and this review step never edit code, apply migrations, or deploy.
- **A proof file is only ever written after a genuinely clean (or blockers-fixed) verdict.** Never hand-write a proof to skip the review.
- **Plain English for Mason** — he has zero coding experience.
