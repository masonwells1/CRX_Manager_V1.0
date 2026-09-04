## 2026-09-04 - Invoice `season` follows the invoice DATE, closing the 2026-09-30 window

- New migration `supabase/migrations/20260904180000_invoice_season_follows_invoice_date.sql`
  (NOT APPLIED at the time of writing). It re-emits two SECURITY DEFINER bodies —
  `_save_invoice_lineage_unaware_impl_20260827` and `_save_field_app_invoice_impl_20260714` — so
  that `season` is derived from the same date the invoice is stamped with:
  `compute_season(COALESCE(<payload invoice_date>, (now() AT TIME ZONE 'America/Chicago')::date))`.
  That is the pattern `_save_field_app_split_invoice_impl` already uses.
- Ships with a one-line frontend fix in `src/pages/FieldApplicationInvoice.tsx` (below), without
  which the server fix does not actually close the window on that page.
- Why: `20260904160000_invoice_date_fallbacks_chicago` (applied live 2026-09-04, PR #589, apply
  recorded in PR #598) moved the server-side `invoice_date` fallback to the America/Chicago business
  date. Both of these bodies still took `season` from `current_season()`, which is `compute_season`
  of the UTC calendar day. `compute_season` rolls at month >= 10, so between 7 pm America/Chicago on
  2026-09-30 and midnight UTC an invoice would be dated 2026-09-30 (season 2026) and stamped
  `season = 2027`. Before the 2026-09-04 apply both stamps were UTC and therefore agreed with each
  other; correcting the date is what exposed the coupling. `season` drives
  `customer_application_rates` lookups and year-end statements, so the mismatch is a real business
  defect, not a cosmetic one.
- **A THIRD site the deferred residual did not name.** Inside
  `_save_field_app_invoice_impl_20260714`, the per-customer rate lookup also matched on
  `car.season = current_season()` (`20260904160000_...sql:1082`), not only the INSERT's season stamp
  (`:874`). Fixing the stamp alone would have filed the invoice under one season while pricing it at
  another — a NEW internal inconsistency introduced by the fix.
- **The edit path, raised independently by both reviewers** (`rls-security-reviewer` M3,
  `migration-drift-reviewer` H1). The UPDATE branch of that function sets `invoice_date` but never
  `season`, so an early draft that bound the rate lookup to the *new-invoice* season would have
  filed an edited invoice under one season and priced it at another — the very defect this change
  exists to prevent. **Resolved by binding the lookup to `v_invoice_season`: the season the ROW
  actually carries**, returned by the INSERT and read back from the UPDATE. The invariant is then
  simply *the application fee is priced at the season this invoice is filed under*, and it holds on
  both the create and the edit path.
  - The alternative — re-seasoning the invoice on edit — was rejected. It rewrites an existing
    record onto a different year-end statement, and on a governed split invoice the provenance
    triggers (`20260719044912` / `20260719060256`) refuse a `season` change outright. Binding the
    lookup closes the same divergence and rewrites nothing.
  - The drift reviewer also cited `20260625190000_guard_billed_job_immutability.sql:120` as a third
    trigger guarding `invoices.season`. **That citation is wrong** — the trigger is
    `BEFORE UPDATE ON public.jobs` (`:163-167`), not `invoices`, and is irrelevant here. Verified
    from source rather than taken on faith.
- Live starting pins re-verified read-only against production (`rhyzpcqhnizqbxphqdkr`) on
  2026-09-04, after the `20260904160000` apply, via `md5(p.prosrc)` — the function BODY only, not
  `pg_get_functiondef`, which includes the header and produces digests that read as false drift:
  `_save_invoice_lineage_unaware_impl_20260827` `e1f1e0e641bd22f23505a7afc4384b2b` ->
  `e3fc9bd9c1da4b2eb8082e91781e4915`, and `_save_field_app_invoice_impl_20260714`
  `bf900b8bd31439b9fa2963b161e107ca` -> `29d699a8b0698424345a78e9aac9dcd1`. Both bodies are LF on
  live, so unlike `20260904160000` there is no CRLF preimage to accept.
- **THREE ACCEPTED CONSEQUENCES of not re-seasoning on edit, all OPEN OWNER DECISIONS for Mason.**
  Every one is confined to an EDIT that moves an invoice date across October 1 — none is in the
  2026-09-30 evening window this file exists to close — and every one is now **observed by a prover
  phase rather than inferred from reading the code**:
  1. *(PHASE 6c)* On such an edit the two stamps stay divergent: `invoice_date` moves, `season` does
     not. So the file's opening claim — date and season agree — holds on CREATE, not on EDIT. This
     is the price of never rewriting an existing record's season.
  2. *(PHASE 6d, `migration-drift-reviewer` H1 round 2)* In a MULTI-GROWER group, an edit that also
     ADDS a grower prices the pre-existing invoices at their stored season and the new one at the
     invoice date's season. Observed: one application, one invoice group, one date — the
     pre-existing grower filed season 2026 at 1111c/acre, the added grower filed season 2027 at
     2222c/acre. **Two growers on the same application billed at different seasons' rates.** Before
     this change all of them priced from the clock, so the stamps could already diverge but the
     prices could not. This is the one genuinely NEW money outcome.
  3. *(PHASE 6e, `rls-security-reviewer` M-A round 2)* If no `customer_application_rates` row exists
     for the season the invoice is filed under, the fee silently falls back to the service default.
     Observed: with a rate row for 2027 but none for the filed season 2026, the fee billed the
     9999c/acre default instead of a negotiated rate. Pre-existing fallback behaviour on a newly
     reachable path — `src/pages/ApplicationServiceDetail.tsx` defaults its Season box to the
     current season, so an override entered after the roll lands on the wrong side of it.
- Numbering: `20260904180000` sorts above the live ordering boundary
  `20260904160000_invoice_date_fallbacks_chicago` (ledger `version` `20260904130047`). Read from the
  `name` column with `where name ~ '^[0-9]{14}'` — `version` and `name` diverge, and `max(name)`
  returns garbage because legacy non-timestamp rows sort above digits.
- Guards restored or added after review, all in the preflight/postflight (no body change):
  - `PREFLIGHT_SIGNATURE` / `PREFLIGHT_SECDEF`, which the predecessor carried and an earlier draft
    of this file had dropped (`migration-drift-reviewer` H2). `md5(prosrc)` covers the body only and
    says nothing about arity, return type or security mode.
  - `PREFLIGHT_ATTRS`, pinning **every** attribute `CREATE OR REPLACE` can reset — volatility,
    parallel safety, strictness, leakproof, cost and set-returning (`v`/`u`/false/false/100/false,
    all read live). The command names none of them, so each would silently revert to its default; a
    live `STRICT` reverting to `CALLED ON NULL INPUT` would change what a NULL argument does
    (`rls-security-reviewer` L-1). The postflight re-asserts all of them.
  - `POSTFLIGHT_CHICAGO` raised from `>= 1` to `>= 2` (`migration-drift-reviewer` M2). The Chicago
    token count goes 1 -> 2 with this change, so at `>= 1` the new season line alone satisfied it
    and a regressed `invoice_date` fallback would have passed the guard meant to protect it.
  - The UTC-date regression guard now counts two spellings case-insensitively and its message names
    exactly what it counts, instead of claiming "zero UTC current-date tokens" from one
    case-sensitive literal.
  - `to_regrole(...)` guards around every `has_function_privilege` call. It RAISES on a missing
    role, so a clean-rebuild database without the Supabase web roles would have been refused in the
    preflight — contradicting this file's own disaster-recovery goal.
  - `ON COMMIT DROP` plus a recorded `pg_current_xact_id()` on the ACL pin table, with a new
    `POSTFLIGHT_ATOMICITY` check. A TEMP table survives COMMIT for the whole session, so the old
    "the preflight and postflight are not in the same transaction" message proved same *session*,
    not same *transaction*.
  - Overload-count checks moved first in the postflight: with two overloads the non-STRICT
    `SELECT ... INTO` takes an arbitrary row, so every later message could name the wrong overload.
- **The four token-count postflight guards are documented as intent guards, not tests.** They sit
  downstream of an exact md5 equality on the same `prosrc`, so on a clean apply they cannot fail
  independently (`migration-drift-reviewer` M1). They are load-bearing only for a mutated candidate
  that re-pins its own md5 — which is exactly how the prover's PHASE 8a exercises them — and the
  comment above them now says so rather than labelling one of them "THE FIX".
- **The grant check is a NOT-WIDENED claim, deliberately.** The preflight records each function's
  `proacl` plus its `anon`/`authenticated` EXECUTE privileges; the postflight refuses any widening.
  It does not assert an absolute grant list: a clean-rebuild database legitimately starts from a
  different ACL than production, and this file must not refuse a disaster-recovery rebuild for that.
  Same lesson as the CRLF/LF preimage in `20260904160000`, and it was learned the same way here —
  the first versions of both the migration and its prover asserted the absolute form and failed
  in-container against a legitimate starting state. On production the surface is `postgres=X/postgres`
  for the first body and `postgres=X/postgres | service_role=X/postgres` for the second: neither is
  reachable by `anon` or `authenticated` except through its wrapper (read read-only 2026-09-04).
  That read, not this file, is the evidence for the absolute claim.
- Proof: `scripts/smoke/prove-invoice-season-follows-invoice-date.mjs` reports **ALL PHASES PASSED**
  (throwaway PostgreSQL 17 container, network-less, no DB URL). It reaches production's CURRENT
  state from tracked files rather than a second hand-made fixture: baseline + ledger replay (58
  migrations) + the existing byte-exact live-body fixture + an in-container apply of the predecessor
  `20260904160000`, after which both bodies reproduce this candidate's live pins byte for byte.
- **PHASE 1b sets the container's ACCESS SURFACE to production's** (`REVOKE` from PUBLIC/anon/
  authenticated on both impls, `GRANT EXECUTE` to `service_role` on the field-app impl). This is not
  cosmetic. The clean-rebuild baseline leaves these impls PUBLIC-executable, so without this step
  PHASE 4's "access surface unchanged" assertion is vacuous AND the PHASE 8c widening mutation
  degenerates into a no-op — granting to a role that already holds EXECUTE widens nothing. That
  no-op is what an earlier run reported, and it read exactly like a broken guard. The guard was
  fine; the MUTATION was invalid. Recorded because the same trap will catch the next re-emit prover:
  a mutation test is only evidence if the starting state makes the mutation meaningful.
- What the proof shows, through the REAL installed functions rather than a re-implementation:
  - PHASE 2a — `save_invoice` with `invoice_date` 2026-10-01 and no season stamps `season = 2026`.
    The invoice is dated in season 2027 and filed in 2026.
  - PHASE 2b — the field-application save with the same date stamps `season = 2026` AND charges the
    seeded season-2026 rate of 1111c/acre instead of the season-2027 rate of 2222c. The wrong season
    is visible as a wrong PRICE, not only as a wrong label. A third distinct value (the service
    default, 9999c) is seeded so a lookup miss can never be mistaken for a correct answer.
  - PHASE 6a/6b — after the candidate, both calls file season 2027 and charge 2222c at 2026-10-01,
    and file season 2026 and charge 1111c at 2026-09-30: both sides of the boundary the 2026-09-30
    window sits on. The no-`invoice_date` fallback satisfies `season = compute_season(invoice_date)`.
  - PHASE 6c — the edit path. An invoice created at 2026-09-30 (season 2026) and then edited to
    2026-10-01 stays filed under season 2026 and is charged 1111c, the season-2026 rate. Filed and
    priced agree.
  - PHASE 7 — the clock wiring itself, instrumented. `compute_season` is temporarily replaced by a
    shim that encodes its argument as YYYYMMDD, so the `season` column reports WHICH DATE fed it.
    With a session zone whose calendar day differs from Chicago's, `season` followed the SESSION
    (UTC-side) day before the candidate (20260905) and the CHICAGO day after it (20260904). That is
    the exact swap the 2026-09-30 19:00-Chicago window turns on, demonstrated at today's instant —
    the literal calendar instant cannot be reproduced without faking the container clock, which
    would not be safe on a shared host.
  - PHASES 3/4/5 — drift refused atomically with both bodies untouched; apply reaches `PREFLIGHT_OK`
    and `POSTFLIGHT_OK`; replay reinstalls identical bodies.
  - PHASE 8 — mutations, which must FAIL. Leaving EITHER of the two `_save_field_app_invoice_impl`
    sites on the current-season helper aborts in `POSTFLIGHT_SEASON_CLOCK` with nothing installed
    (each mutant is re-pinned to its own md5 first, so the md5 guard cannot mask the season guard).
    Removing one drift pin lets a drifted body apply cleanly and be OVERWRITTEN, which is the damage
    the pin prevents. Adding a `GRANT EXECUTE ... TO authenticated` aborts in `POSTFLIGHT_GRANT`
    with the grant rolled back.
  - **PHASE 8d — the mutation no static guard can catch.** Binding the fee lookup to the
    NEW-invoice season instead of the row's own season uses no clock helper, so
    `POSTFLIGHT_SEASON_CLOCK` stays quiet and a re-pinned md5 passes: the mutant APPLIES. It is
    caught only behaviourally — the edited invoice is filed under season 2026 while charged 2222c,
    the 2027 rate, where the shipped binding charged 1111c. This is the reviewers' defect,
    reproduced on purpose, and it is why the edit-path fix is behaviour-tested rather than asserted.
  - **PHASE 8e — the same, for the UPDATE's read-back** (`rls-security-reviewer` L-3). Nothing
    proved `RETURNING season INTO v_invoice_season` on the UPDATE branch was load-bearing. Removing
    it also applies cleanly past every static guard, and is caught only by the price: the edit
    silently bills the 9999c service default where the shipped code billed 1111c.
- **The prover's dated time bomb was removed before it could fire** (`rls-security-reviewer` L-4).
  It hardcoded 2026-09-30 / 2026-10-01, which only reproduces the defect while the ambient season is
  2026 — so from 2026-10-01 the proof would have failed and read as a broken migration. It now
  derives both dates from `current_season()` at run time: for season Y, `Y-09-30` is always the
  ambient season and `Y-10-01` always the next one, so it stays correct every year (PHASE 1c prints
  the derivation and asserts it).
- **Frontend: `src/pages/FieldApplicationInvoice.tsx` defaulted its transaction date in UTC.**
  `useState(new Date().toISOString().slice(0, 10))` — `toISOString()` converts to UTC, so from about
  7 pm Chicago it pre-filled TOMORROW. Because that page ALWAYS sends `invoice_date`, the server's
  America/Chicago fallback never engages there, so this could only be fixed on the client: at
  19:30 Chicago on 2026-09-30 the page pre-filled 2026-10-01, and the server then correctly derived
  season 2027 from that wrong date. The date/season mismatch was closed; the wrong business DAY was
  not. Now uses the project's existing `localToday()` (`src/lib/dateUtils.ts:16`), as
  `InvoiceDetail.tsx:132` already did. The helper's own docstring documents this exact bug.
  A stale comment nearby claiming the server defaults `invoice_date` to the UTC current date was
  corrected in the same change. The two other `toISOString()` uses in the file (`:856`, `:2027`) are
  UTC-anchored arithmetic on explicit date strings — internally consistent and deliberately left.
- Frontend proof, run rather than asserted, at both the boundary and in a real browser:
  - The shipped `localToday()` from `src/lib/dateUtils.ts` executed with the process clock pinned to
    America/Chicago at 2026-10-01T00:30:00Z (19:30 Chicago on 2026-09-30) returns **2026-09-30**
    (season 2026), where the expression it replaced returns **2026-10-01** (season 2027). Same at
    23:59 Chicago; they agree again at 00:01 on Oct 1, so the divergence is exactly the window.
  - The real page rendered in a browser through the local stub harness with the page clock pinned to
    the same instant: the Transaction Date field shows **2026-09-30**. No console errors.
- Out of scope, tracked separately in `docs/manual/KNOWN_ISSUES.md`: `next_invoice_number()` takes
  its year from `extract(year FROM now())` (UTC), so a 2026-12-31 evening invoice is dated 2026 and
  numbered 2027; and OTHER paths still stamp `invoices.season` from the current-season helper —
  including the `invoices.season` column DEFAULT itself, `issue_return_credit`, the blend-ticket
  path and the delivery-split paths (surfaced by both reviewers; latest occurrences in migration
  sources, not yet confirmed against the live catalog). Neither is folded in: this file has a hard
  2026-09-30 deadline and each additional md5-pinned body widens its blast radius. The single
  remaining UTC current-date token in `_save_field_app_split_invoice_impl` (the commission
  `order_date`) is an OPEN OWNER DECISION for Mason and is untouched.
- Known behaviour delta, documented rather than guarded: an `invoice_date` of `'infinity'` now
  raises `cannot convert infinity to integer` instead of saving with a clock-derived season
  (confirmed read-only against live: `compute_season('infinity'::date)` raises). Fail-closed, not
  reachable from the date inputs, and left unguarded rather than changing the body for it.
- The migration remains NOT APPLIED. A live apply goes through `scripts/apply-migration-file.mjs`
  with fresh `write-apply-proofs.mjs` proofs and Mason's typed OK in the current conversation, per
  the standing gate.
