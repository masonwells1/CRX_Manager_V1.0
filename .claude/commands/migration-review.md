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
1. Get a real current UTC timestamp (the workflow cannot — its clock is disabled). Run:
   `(Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")`
2. Write the proof file to `.claude/session-state/migration-review-<safe-name>.json` where `<safe-name>` is the migration name with every char outside `[A-Za-z0-9_.-]` replaced by `_`, then truncated to 80 characters (this matches the guard's own slug rule). Content:
   ```json
   {
     "migration": "<migration name or filename>",
     "timestamp": "<the ISO timestamp from step 1>",
     "reviewers": ["rls-security-reviewer", "migration-drift-reviewer"],
     "findings": "clean",
     "queryHash": "<sha256 of the exact migration SQL — see note>"
   }
   ```
   (The reviewers list is provenance-only — the migration-apply-guard hook validates findings + queryHash, not this list.)
   Use `"findings": "blockers-fixed"` instead if blockers were found and fixed earlier this session.
   `queryHash` binds the proof to this exact SQL so an edit-after-review can't slip through. Reliable way to get it: when Mason approves the apply (step 4), attempt the `apply_migration` call once — the guard prints the expected SHA-256 — paste that into `queryHash` and retry. (Omitting it still works but loses the content-binding protection.)
   IMPORTANT: the `migration` value must substring-match the `name` you will pass to `apply_migration`, or the guard won't match the proof. The proof expires after 30 minutes.
3. Tell Mason it's clean, list any MED/LOW findings as FYI (not blockers), and list the `refutedBlockers` so he can see what was checked and dismissed.

### 3b. If verdict is `'blocked'`
1. Do NOT write a proof file. Do NOT apply.
2. Show Mason each real blocker in plain English: what it is, where (`location`), why it matters, and the recommended fix.
3. Offer to fix them. After fixing, re-run this command — the workflow re-verifies, and only a clean pass produces a proof.

### 4. Apply (only after a clean proof exists, and only with Mason's explicit go-ahead)
The proof unblocks `apply_migration`; it does not authorize it. Per Mason's standing rules, still explain the migration (offer `/explain-migration`) and wait for his approval before the apply call.

## Hard rules
- **Read-only review.** The workflow and this review step never edit code, apply migrations, or deploy.
- **A proof file is only ever written after a genuinely clean (or blockers-fixed) verdict.** Never hand-write a proof to skip the review.
- **Plain English for Mason** — he has zero coding experience.
