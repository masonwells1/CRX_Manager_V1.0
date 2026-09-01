## 2026-08-31 — Modified migrations need a disposition and the recovery rule too

CodeRabbit's review of the frozen candidate `4bb9c05c` returned **Merge Risk: Moderate — not
merge-ready**, on the grounds that "branch-cleanup instructions do not cover modified migrations".
Verified and correct.

### What was wrong

The report has a leading section on the 4 branches that modify a migration `main` already carries,
and it tells the reader to "resolve these before anything else". It never says how. Two gaps
followed from that:

- **No disposition procedure.** The absent-migration section had gained a three-way
  applied-live / pending / abandoned classification after an earlier round, but the
  modified-migration section had nothing equivalent — no way to tell a rebase artifact from an
  abandoned edit from a change that reached production.
- **The recovery rule did not reach it.** The requirement to land byte-identical SQL in
  `supabase/migrations/` before deleting a branch sat *inside* the absent-migration section, so a
  reader working step 1 of the review order would never apply it.

The second gap is the dangerous one, and it hides a specific trap: a modified migration can also be
the only exact source of SQL running in production. A file of that name existing on `main` looks
like preservation and is not — what matters is which bytes production is running.

### Fixed

- The modified-migration section gains **"What to do with one of these before deleting it"**: the
  three cases (rebase artifact, abandoned edit, applied live in the modified form), what to preserve
  in each, and the instruction to establish the case from the PR, the ledger and the file rather
  than from the fact that `main` differs. It states that branches on an open PR are pending —
  naming `codex/pr509-source-recognition-fix-v2-20260830` on PR #517 — and that a case-three finding
  means a Hard Rule violation already reached production, so the ledger needs correcting as well as
  the branch preserving.
- The recovery rule is retitled and now opens by saying it **governs both migration sections**.
- Review-order step 1 points at the new subsection and repeats the trap in one line.

### Also

CodeRabbit's Title check failed: the PR title lacked the mandatory Conventional Commits scope. The
title now carries one.

All five `mode: error` CRX Hard Rule pre-merge checks passed on `4bb9c05c` — new-table RLS,
`SECURITY DEFINER` search_path, mutating-RPC idempotency, exact whole-cent money, and no edits to
applied migrations — each recorded as not-applicable for a documentation-only diff.

### Proof observed

The gap was confirmed by reading the rendered report: the modified-migration section contained no
disposition guidance, and the recovery rule was nested under the absent-migration heading.
`npm run check:docs` passes.

### Lesson

Third instance of the same shape: right data, incomplete instruction. The three-way disposition and
the recovery rule were both added in response to earlier findings, and both were written into the
section that prompted them rather than to every section they govern. Fixing where a finding points
is not the same as fixing where the rule applies.
