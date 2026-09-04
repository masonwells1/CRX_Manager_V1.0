## 2026-09-04 - migration-drift-reviewer CHECK 2 decides from local history and uses live evidence only to acquit

**Files:** `.claude/agents/migration-drift-reviewer.md` (CHECK 2 steps 2-4),
`scripts/check-agent-guidance.mjs`
**Found by:** third exact-SHA `gpt-5.6-sol` push proof on PR #594, commit `73e2f26e`

## HIGH — the hardened charter had made the gate inoperable

This is the important one, and it was self-inflicted. The previous revision required fresh live
identity-signature evidence and emitted **HIGH** whenever it was absent. But
`scripts/write-apply-proofs.mjs` executes this charter as a sandboxed read-only Codex run whose
prompt contains only the charter text and the migration path — verified at
`buildReviewerCharterPrompt`, which injects no catalog result — and the charter itself says the
reviewer cannot query Supabase. Every migration containing a `CREATE OR REPLACE FUNCTION` would
therefore have emitted HIGH forever, the run would have returned BLOCKERS, and no function
migration could ever have been applied through the sanctioned proof path. A gate that always fails
is a gate that gets bypassed.

**Resolved by splitting detection from acquittal**, which also settles the contradiction the same
review flagged as MEDIUM (step 2 called differing historical arguments a BLOCKER while step 4 called
history merely a signal):

- **Local history is the detector and decides the default verdict.** A prior authored signature with
  different argument types and no `DROP FUNCTION` is a **BLOCKER**, decidable from the one-pass grep
  with no database access. Exactly one authored signature, or none, is **clean** — no live evidence
  is requested, because none is needed.
- **Fresh live identity evidence is the only thing that can acquit that BLOCKER**, and it is never
  required to reach a verdict. Its sole purpose is the stale case: a later `DROP` removed an
  overload the history still shows.
- **Absent live evidence, the BLOCKER stands.** The charter no longer emits a HIGH demanding
  evidence the run cannot obtain, and absence is never read as clean.

Round one's counterexample still fails closed under this rule without any live read: live
`f(integer)`, migration adds `f(text)` with no `DROP` — history shows two differing signatures, so
step 2 blocks on history alone.

## HIGH — argument types also render search_path-dependently

The previous revision fixed the function-name half of `regprocedure` ambiguity by requiring a
separate `nspname` column, but `regprocedure` renders the ARGUMENT TYPES per search_path too. Two
schemas holding identically named types can make an authored signature look like an exact match
while PostgreSQL resolves it to different type OIDs and creates a second overload. Acquitting
evidence must now carry `proargtypes` — the canonical input-type OID vector — or types rendered
under a controlled, explicitly stated search_path. The `regprocedure` text is for human reading and
never for the match decision. Evidence with no timestamp or no project binding does not acquit
either.

## Assertions

Seven new pins in `scripts/check-agent-guidance.mjs` cover the history-decides-default rule, the
no-live-evidence-needed clean case, the BLOCKER-stands-unacquitted rule, the named sandboxed runner,
the canonical-OID comparison, the argument-type rendering warning, and the rejection of undated or
unbound evidence — 21 CHECK 2 assertions in total.
