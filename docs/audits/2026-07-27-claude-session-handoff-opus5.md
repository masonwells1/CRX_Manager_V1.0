# Session handoff — 2026-07-27 (for a fresh Opus 5 session)

Repo: `C:\CRX_Manager` · Branch: `claude/deactivation-lockout-and-active-reads` · 1 commit ahead of
`origin/main`, 0 behind · **nothing pushed, no PR open.**

Read this, then verify anything load-bearing against live state before acting on it. Every fact below
was re-read from the repo or the live Supabase ledger on 2026-07-27, not from memory.

---

## The one thing to fix first

**Two migrations are APPLIED LIVE, but the docs still say "PLANNED — NOT APPLIED" under filenames
that no longer exist.** This is the only stale-fact hazard in the tree.

Live ledger high-water is `20260727174805`. Confirmed applied via Supabase MCP `list_migrations`:

| Live ledger version | Name | Disk file |
|---|---|---|
| `20260727174657` | `broad_reads_require_active_profile` | `supabase/migrations/20260727174657_broad_reads_require_active_profile.sql` |
| `20260727174805` | `deactivation_revokes_auth_access` | `supabase/migrations/20260727174805_deactivation_revokes_auth_access.sql` |

Both disk files were B7-renamed to match the server-assigned versions. Both are **untracked** — they
have never been committed.

Stale docs to correct:

- `docs/reference/migration-history.md` rows **828** and **829** both open with
  `**PLANNED — NOT APPLIED.**` and cite the pre-rename timestamps `20260727163000` / `20260727163100`.
  They need the same `APPLIED LIVE 2026-07-27 … server-assigned ledger version …` treatment rows
  825–827 already have, plus post-apply live proof.
- `docs/manual/KNOWN_ISSUES.md` §0a items 1 and 2 both say `**Fix drafted 2026-07-27, NOT yet
  applied:**` and cite the same dead filenames.

**Post-apply live proof — TAKEN 2026-07-27, results below.** It had been missing (the rich proof text
in migration-history is all *pre*-apply `BEGIN … ROLLBACK` rehearsal). It now exists; the migration-history
rows still need to be updated to carry it.

---

## What this branch contains

### 1. Committed — `aacbf594` "harness: pin Claude Opus 5, update Codex 5.6 lineup, fix stale/false-green skills"

44 files. Landed with the full pre-commit pipeline green (ledger guard, SQL validation, ESLint 0
errors, typecheck, full Vite build). Not pushed.

**Root cause it fixed:** `C:\Users\mason\.claude\settings.json` pinned the bare alias
`"model": "opus"`, which silently resolves to **Opus 4.8**. Neither CRX nor FarmRx sets its own
`model` key, so that single global line was the only pin — and it was inherited by the five reviewer
subagents, the workflow scripts, and the headless review wrapper. The money/inventory and RLS gates
had been running a generation behind. Now pinned to the canonical `claude-opus-5` (verified still in
place at line 165 as of this writing). **If Opus reverts again, look for a bare-alias `model` key
first.**

Also in that commit: `model:`/`effort:` frontmatter on all five `.claude/agents/*.md`; the Codex 5.6
lineup (`gpt-5.6-sol` reviewer/default, `gpt-5.6-terra` builder, `gpt-5.6-luna` low-risk) swept
through operational files; gate proofs now record which Codex agent produced the verdict; and
substantive rewrites to the `create-migration`, `new-rpc`, `deploy-edge-function`, `deploy-check`,
`new-page`, `audit`, and `spot-check-prod` skills to remove false-green patterns.

Historical files (`docs/CHANGELOG.md`, `docs/loops/`, `docs/archive/**`, migration headers)
deliberately keep `gpt-5.5` as accurate provenance — do not "fix" those.

**Adjudicated FALSE, do not re-open:** the CRX session-start prompt telling Claude to wait for
approval before multi-file edits does *not* contradict `AGENTS.md`. The standing execution
authorization there is Codex-specific and says so explicitly.

### 2. Uncommitted — the deactivation-lockout work (the branch's namesake)

Applied to the live database, proven pre-apply, but **not committed, not reviewed by CodeRabbit, not
in a PR.**

- `supabase/migrations/20260727174657_broad_reads_require_active_profile.sql` — adds a role-agnostic
  `public.is_active_profile()` helper and rewrites 31 wide-open PERMISSIVE SELECT policies (30 with
  `USING (true)`, plus `application_record_fields.arf_select`) to require an active profile. It does
  **not** narrow read access by role: every active user reads exactly what they read before; only
  deactivated accounts lose read.
- `supabase/migrations/20260727174805_deactivation_revokes_auth_access.sql` — makes
  `profiles.is_active = false` actually revoke access: bans the auth user (finite far-future
  sentinel, **not** `'infinity'` — GoTrue decodes that column into a Go `time.Time` and an infinity
  can 500 the auth endpoint) and deletes its `auth.sessions` / `auth.refresh_tokens` rows. Also adds
  `trg_guard_last_active_admin`, which refuses to deactivate the last active admin.
- `src/pages/SettingsPage.tsx` — deactivation confirm text now matches reality, and a plain-English
  toast on the `LAST_ACTIVE_ADMIN` error.
- `src/lib/rpcContracts.test.ts` — classifies `_sync_auth_access_on_profile_active` in
  `MUTATOR_INVENTORY_EXEMPT` as a trigger-only convergent auth-state mirror.
- `docs/manual/KNOWN_ISSUES.md`, `docs/reference/migration-history.md` — the stale rows above.

**Known residual, unavoidable, already stated in the migration header:** an access token already
issued stays cryptographically valid until it expires (~1 hour). Deleting sessions and refresh tokens
means it cannot be renewed and `banned_until` blocks both fresh sign-in and refresh-token exchange,
so access ends within that window at the latest. Instant revocation would need JWT revocation, which
GoTrue does not offer.

### 3. Uncommitted — unrelated, leave alone unless asked

`docs/audits/2026-07-26-claude-to-fable-pr231-remediation-handoff.md`,
`docs/audits/2026-07-26-codex-to-claude-section9-preapply-handoff.md`,
`docs/audits/2026-07-27-branch-worktree-cleanup-restore-ledger.md`, `docs/claude-memory/`.

---

## What still needs proving

### DONE — post-apply live proof, 2026-07-27

Taken directly against live via Supabase MCP `execute_sql`. **Entirely read-only:** structural
catalog reads, plus `SET LOCAL ROLE` / `SET LOCAL request.jwt.claims` impersonation of an *already
existing* deactivated account. No INSERT/UPDATE/DELETE, no DDL, no transaction that needed rolling
back. Paste these into migration-history rows 828/829.

Structural (8/8 pass):

```
1. triggers on public.profiles ....... trg_guard_last_active_admin, trg_sync_auth_access_on_profile_active
2. is_active_profile() ............... secdef=true  cfg=search_path=public, pg_temp
3. helper NOT exec by PUBLIC/anon .... PASS - acl=postgres=X,authenticated=X,service_role=X
4. trigger fns NOT exec by PUBLIC/anon/authenticated ... _guard_last_active_admin=PASS,
                                                          _sync_auth_access_on_profile_active=PASS
5. residual unconditional READ policies ............... 0        (target 0)
6. read policies gated on is_active_profile() ......... 30       (+ arf_select inline = 31)
7. arf_select still gates on is_active ................ PASS
8. blast radius ....... active_admins=4 active_profiles=10 banned_auth_users=0
```

Behavioural — real accounts, no impersonation of a *hypothetical* state:

| Reader | products | customer_addresses | quote_items | team_notes | `is_active_profile()` |
|---|---:|---:|---:|---:|---|
| **Deactivated** `sales_rep` `38cdefbc…` | 0 | 0 | 0 | 0 | `false` |
| **Active** admin `e2195c35…` | 604 | 5 | 20 | 53 | `true` |

That is the whole point of the change proven both directions: the deactivated account reads nothing,
and an active user's access is completely untouched.

Live state re-read immediately afterwards, unchanged: `active_admins=4 active_profiles=10
inactive_profiles=1 banned_auth_users=0 auth_sessions=2595 ledger_high_water=20260727174805`, and
`current_user` back to `postgres` (the `SET LOCAL`s expired with their transactions).

`banned_auth_users=0` is **correct, not a failure** — Mason's 2026-07-27 decision was new
deactivations only; the one already-deactivated account is deliberately not backfilled. Its lockout
comes from RLS (proven above), not from a ban.

### Still NOT proven

1. **The two `SettingsPage.tsx` strings are not visually confirmed.** Reaching Settings needs an admin
   login. Residual risk is cosmetic only — the database refuses a last-active-admin deactivation
   whether or not the friendly toast renders.
2. **The ban/session-revocation path has never been fired against a real deactivation.** The trigger is
   proven to *exist*, be SECURITY DEFINER, and be un-invokable by app roles; its ban-and-delete
   behaviour was proven pre-apply in a rolled-back rehearsal, but no live deactivation has occurred
   since (`banned_auth_users=0`). Firing it for real means deactivating an actual person — Mason's
   call, not something to do for a proof.

---

## Open items carried forward

- **BLOCKED — schema baseline refresh.** `supabase/baselines/` records high-water `20260719092832`,
  but its public-schema artifact already contains objects from `20260720213000`, so a from-zero
  rebuild stalls at migration 16 of 50 on an md5 precondition. This is a **disaster-recovery gap, not
  a production defect.** The refresh needs `supabase db dump` (not raw `pg_dump`), which fails with
  `permission denied to set role "postgres"` — the only CRX credential on this machine is the
  read-only `crx_backup_ro` role. **The one concrete unblocking step is Mason supplying the project's
  `postgres` database password** (Supabase dashboard → Project Settings → Database), or running the
  dump himself. Do **not** hand-roll the CLI's post-processing on top of a `crx_backup_ro` dump — the
  baseline *is* the DR path.
- **Open product decision, not a bug.** Which roles *should* see each of the 31 broad-read tables.
  The applied migration deliberately left read scope unchanged for active users. This is Mason's call.
- **Logged-in production click-through still unverified** from the 2026-07-26/27 RLS work.
- **Do not enable** `supplier_cost_basis_enabled`. **No Stage C** without Mason.

---

## Recommended next step

Correct the two stale doc files to reflect that both migrations are applied live, gather the missing
post-apply live proof, then present the whole branch to Mason for a push/PR decision. Pushing,
opening a PR, and merging all need his explicit approval — and on this repo **the merge to `main` is
the production deploy** (`protect-main` ruleset, 2026-07-14; direct pushes are impossible, and
CodeRabbit must be read before merging).

Nothing on this branch has been pushed. Nothing is queued to deploy.
