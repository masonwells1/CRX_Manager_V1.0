## 2026-09-06 — the field-application invoice PREVIEW prices at the invoice's season, not the server clock (CRX-SEC-001)

Closes the open `preview_field_app_invoice_split` entry in `docs/manual/KNOWN_ISSUES.md`, raised as a
P1 by the Codex GitHub App on PR #599 and the sole HIGH finding in that PR's 2026-09-05 push-proof.

> **APPLIED LIVE 2026-09-08 04:58Z**, ledger version `20260908045843`, with Mason's explicit
> in-conversation approval. Verified from `pg_proc` (one overload, 5 args, `md5(prosrc)`
> `83f6600412ced085d0876a3c7339ff12`, no `anon`/PUBLIC in `proacl`) and through a real PostgREST call
> in BOTH the 5- and 4-argument shapes — each returned `42501`, not `PGRST202`, proving the API layer
> resolves the new signature and the legacy caller still works. **The frontend half is NOT merged
> yet**, so the defect is still user-visible; DB-first is the required order.
> Everything below the "### Proof observed" heading describes the pre-apply candidate state and the
> "before apply" notes near the end are kept as written, as the record of what was outstanding then —
> they are history, not current status.

### What was wrong

`20260904180000_invoice_season_follows_invoice_date` moved BOTH field-application SAVE bodies onto
the invoice's own season and deliberately left the read-only preview alone. That closed the save side
and **opened** this divergence: before it, both sides read the same UTC clock and agreed while both
being wrong; afterwards the save side is right and the preview is the one that can be wrong.

`preview_field_app_invoice_split` looked the application fee up with `car.season = current_season()`,
which is `compute_season(CURRENT_DATE)` — an independent clock read, UTC on this server. So the
per-acre rate on the Customers-tab breakdown Mason approves could differ from the rate he is billed.

**Severity is display-only. The charge was always correct.** `previewData` is passed to the breakdown
component as a `preview` prop and never feeds the save payload; save recomputes the fee itself. What
was wrong is the number Mason approves beforehand.

**Two windows, and the second is the larger one:**

- ~5 hours a year: 7 pm–midnight America/Chicago on 2026-09-30, when the clock season has rolled and
  the invoice date has not.
- **All year:** reopening any invoice whose season differs from the current clock season — a
  September 2026 invoice edited in November 2026 previewed 2027 rates against a 2026 save. This one
  needs no clock edge case at all.

**It could not be fixed in the frontend.** The live function took four arguments
(`p_locations`, `p_chemicals`, `p_application_service_id`, `p_invoice_id`) and had no date or season
parameter, so the caller had nothing to pass.

### What changed

- **New migration** `supabase/migrations/20260906120000_preview_field_app_season_follows_invoice_date.sql`.
  Signature goes `(jsonb,jsonb,uuid,uuid)` → `(jsonb,jsonb,uuid,uuid,date)`, adding
  `p_invoice_date date DEFAULT NULL`.
  - **DROP+CREATE, not a second overload.** PostgREST resolves by named arguments, so a 4-argument
    and a 5-argument-with-default candidate would both match a 4-argument call and every preview
    would become an ambiguous-function error. Exactly one signature exists before and after.
  - **Both signatures are dropped**, so a replay or a retried apply cannot fail with
    `function ... already exists with same argument types`. Caught by the prover's PHASE 5, not by
    inspection.
  - Body is the live body **byte-faithful** (`md5(prosrc)` = `ca33fb973d86dbf3a2788dc11fbc49a5`, read
    read-only from live on 2026-09-06 and confirmed identical to the repo source at
    `20260630180000_field_app_pricing_unit_fix.sql:670-913`) plus **five** deltas — four additions
    and one substitution. The enumeration exists so a reviewer can confirm nothing unlisted moved,
    so it names the biggest region rather than folding it into "the season setup": (1) the new
    parameter; (2) four declares; (3) the two statements after `derive_customer_shares_from_fields`
    that count the customers and compute `v_new_season`; (4) the per-customer season-resolution
    block **inside the loop**, which is the largest single change in the file; and (5) the
    `customer_application_rates` lookup binding to `v_price_season` **instead of**
    `current_season()` — a substitution, not an addition, and the one line where the old behaviour
    actually lived. Nothing else moves — no pricing, rounding, unit-conversion or ACL behaviour
    changes.
  - **The season rule mirrors save's branch order exactly:** an existing live member of the group, or
    a single-customer edit of `p_invoice_id`, prices at that row's **stored** season; only a genuinely
    new invoice uses `compute_season(COALESCE(p_invoice_date, Chicago today))`. Save never re-seasons
    an existing invoice (`docs/manual/DECISION_LOG.md`, 2026-09-04), so a preview that merely
    recomputed the season from the date it was handed would be wrong again on a reopened invoice
    re-dated across October 1.
  - `v_row_season` is reset every iteration. The hazard is not `SELECT INTO` — PL/pgSQL assigns NULL
    when no row matches — it is that the `IF`/`ELSIF` can take **neither** branch, leaving the
    previous customer's season in place and pricing this customer against the wrong year.
  - **Apply-time guards.** The migration runs in a single transaction, so any guard firing rolls
    the whole file back and changes nothing.
    - `$preflight$`, before anything is dropped: `PREFLIGHT_SEASON_RULE` (the environment really
      does put 2026-09-30 in season 2026 and 2026-10-01 in season 2027 — if that rule ever moves,
      every claim below it is about a different calendar); `PREFLIGHT_MISSING` (the function this
      file REPLACES is actually there — a fresh `CREATE` would skip the body pin entirely);
      `PREFLIGHT_OVERLOAD` (exactly one existing overload); `PREFLIGHT_OWNER` (`postgres`);
      `PREFLIGHT_SIGNATURE` (the exact identity of either the 4-argument predecessor or the
      5-argument candidate, argument names included); `PREFLIGHT_GRANT_DRIFT` (the EXECUTE grantee
      set, on **both** paths — see below); `PREFLIGHT_BODY_DRIFT` (the predecessor's reviewed body
      md5, so an apply over a body another lane changed is refused rather than silently reverting
      it); and, on the replay path only, `PREFLIGHT_REPLAY_BODY_DRIFT`.
    - **That order is deliberate, and the first version had it the other way round.** When the ACL
      check was hoisted above the replay branch (below), it landed *above* the signature check too.
      Review caught what that meant. The realistic way live acquires a wrongly-shaped function is
      another lane running its own `DROP` + `CREATE` — and a fresh `CREATE` re-acquires Supabase's
      default `anon` grant. So the wrong shape and a drifted ACL always arrive **together**, and
      every realistic wrong-shape drift would have been reported as grant drift: fail-closed, but
      pointing the operator at the wrong problem. The identity is now validated first, so the abort
      names the thing that actually changed. The prover's `PREFLIGHT_SIGNATURE` mutant deliberately
      leaves the stub's `anon` grant in place and asserts the signature check still wins — it is the
      regression test for exactly this ordering, not just for the check.
    - **The identity literal was checked against live, not just against the repo.** `md5(prosrc)`
      covers only the text between the `$function$` markers, so it is blind to the whole
      declaration — the same blind spot `POSTFLIGHT_ARGUMENT_DEFAULTS` and `POSTFLIGHT_VOLATILITY`
      exist to cover. Tightening `PREFLIGHT_SIGNATURE` from "four arguments" to an exact identity
      string therefore introduced a way to refuse a correct apply that a body-only read could not
      rule out. Closed on 2026-09-06 by a read-only catalog read of `pg_proc` columns (no catalog
      function calls, so the live-data guard permits it): `pronargs` 4, `proargnames`
      `{p_locations, p_chemicals, p_application_service_id, p_invoice_id}`, `proargtypes`
      `3802 3802 2950 2950` (jsonb, jsonb, uuid, uuid), owner `postgres`, `provolatile` `s`,
      `prorettype` `jsonb`, `prosecdef` true, `proconfig` `{search_path=public, pg_temp}`, `proacl`
      `{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}`. Live renders as
      exactly the expected identity, and its grantee set is exactly the reviewed one, so neither
      new literal will false-abort the intended apply. Recorded in the migration header too.
    - **Why the replay path needs its own body pin.** When the 5-argument candidate is already
      installed, the preflight returns early and the postflight's body pin cannot help: the
      postflight reads `prosrc` *after* `DROP` + `CREATE`, so on a replay it is reading this file's
      own body and would agree with itself no matter what it destroyed. `PREFLIGHT_REPLAY_BODY_DRIFT`
      is the only thing standing between a re-apply and a silent overwrite of a patch another lane
      made to the live 5-argument body — the `batch_apply_prepayments` silent-revert class of
      2026-07-15. The prover asserts not just that it aborts, but that the simulated patch is *still
      there* afterwards.
    - `PREFLIGHT_GRANT_DRIFT` is the same argument one field over. The `DROP` destroys the
      installed ACL just as thoroughly as the body, and the `GRANT`/`REVOKE` block below then
      restores exactly the reviewed set — so a grant another lane added would be reverted and the
      postflight, which only ever sees the reviewed set, would report OK. The prover asserts the
      outside grant SURVIVES the refusal, not merely that the apply aborted.
    - **It guards both paths, and the first version did not.** This check was originally written
      inside the replay branch, on the reasoning above. Review pointed out that the reasoning is
      equally true of the 4-argument predecessor — and live is *on* the 4-argument predecessor, so
      the first and only intended apply took the branch that had no ACL pin, while the rare retry
      got the guard. It now sits above the replay branch and covers both. Both signatures carry the
      same reviewed grantee set (confirmed against live, above), so one literal covers both, and the
      abort names which identity it found so the two paths cannot be confused. The prover proves it
      on each path separately.
    - `POSTFLIGHT_RETURN_TYPE` pins `jsonb`, **and pins that it is not set-returning**. It is the
      last declaration property nothing else in the file could see: the identity rendering omits the
      return type, `pg_get_function_arguments` omits it, and `md5(prosrc)` is blind to the whole
      declaration — so an edit changing the return type would have passed every other check while
      the frontend, which reads `.per_customer` off the result, got something it cannot index. The
      set-returning half was review's addition and is the sharper one: `RETURNS SETOF jsonb` leaves
      `prorettype` as `jsonb` and leaves the identity, the argument rendering, the volatility, the
      `search_path` and `md5(prosrc)` all unchanged — and PostgREST renders a set-returning RPC as
      an **array**, so `.per_customer` becomes unindexable. Pinning only the type would have missed
      exactly the break the check was added to stop.
    - **Ownership is established, not merely asserted.** An `ALTER FUNCTION … OWNER TO postgres`
      follows the `CREATE`. `DROP` + `CREATE` re-owns the function to whoever runs the migration, so
      without that line `POSTFLIGHT_OWNER` would abort a correct apply run by any other role — at
      the very end, after everything appeared to work. Three existing migrations here
      (`20260729125314`, `20260731001654`, `20260826221000`) use the same statement for the same
      reason. Two consequences are recorded rather than left to be discovered: `POSTFLIGHT_OWNER`
      can no longer fail on an unmutated run, because the `ALTER` forces the value it asserts — it
      is now a check on that statement rather than on the applying role, and the prover has to
      mutate the statement to make it fire at all; and the file now succeeds under applying roles it
      would previously have refused, namely any role that may `SET ROLE postgres`. That is the
      intended trade, but it is a real widening, and a role that may *not* `SET ROLE postgres` now
      aborts with PostgreSQL's own "must be able to SET ROLE" instead of `POSTFLIGHT_OWNER`'s
      explanation — same rollback, worse diagnosis.
    - `$postflight$`, reading the catalog back after the replacement: `POSTFLIGHT_OVERLOAD` (exactly
      one signature); `POSTFLIGHT_SIGNATURE`, compared against the full **named** identity
      `preview_field_app_invoice_split(p_locations jsonb, p_chemicals jsonb, p_application_service_id
      uuid, p_invoice_id uuid, p_invoice_date date)` — names, not just types, because PostgREST
      resolves RPCs by argument name, so a rename is a break even when every type matches;
      `POSTFLIGHT_ARGUMENT_DEFAULTS` (the three `DEFAULT NULL`s a 4-argument caller depends on are
      still declared — invisible to the signature check, which does not render defaults);
      `POSTFLIGHT_OWNER`; `POSTFLIGHT_NOT_SECURITY_DEFINER`; `POSTFLIGHT_SEARCH_PATH` (the exact
      string); `POSTFLIGHT_VOLATILITY` (`STABLE`, `plpgsql`, and **not `STRICT`** — all three are
      declaration properties, so `md5(prosrc)` is as blind to them as it is to the DEFAULTs);
      `POSTFLIGHT_RETURN_TYPE` (a single `jsonb` value, not a set); `POSTFLIGHT_BODY` (the installed
      body md5); and the six ACL checks below.
    - **`STRICT` is the sharpest of those, and it was added on review.** `p_invoice_date` is
      `DEFAULT NULL`, so *every* 4-argument caller — the deploy-order fallback this file's own
      header promises — reaches the function with a NULL argument. A `STRICT` function returns NULL
      without executing at all: no error, no wrong price, just nothing, for exactly the callers the
      fallback exists to serve. It is pinned as an OID comparison rather than as text for the same
      reason `POSTFLIGHT_SIGNATURE` avoids `regprocedure`: a text rendering of a type goes through a
      visibility check against the applying session's `search_path`. `proparallel` is deliberately
      **not** pinned — it changes only whether the planner may use a parallel worker, never the
      result, and pinning properties nobody can state a failure for is how a guard list stops being
      read.
    - **ACL checks.** PUBLIC is read straight out of `aclexplode(proacl)` (`grantee = 0`), because
      `has_function_privilege` cannot express PUBLIC — it returns true for every role when PUBLIC
      holds a grant. `anon`, `authenticated` and `service_role` are read with
      `has_function_privilege`, which resolves role *membership*; `aclexplode` sees only direct
      grants and would miss EXECUTE reaching `anon` through a role it belongs to.
      `POSTFLIGHT_GRANT_UNEXPECTED` then refuses any grantee outside the reviewed set
      (`postgres`, `authenticated`, `service_role`) and names it. It is deliberately the **last**
      check in the block: placed earlier, this catch-all would fire first on an `anon` grant and
      make the named `POSTFLIGHT_GRANT_ANON` unreachable — and therefore unfalsifiable, which is how
      a guard comes to look proven while testing nothing.
    - `POSTFLIGHT_ACL_DEFAULT` (a NULL `proacl`) is retained but is **unreachable on this project
      and is not mutation-proven**: Supabase's `ALTER DEFAULT PRIVILEGES` materialises `proacl` on
      every newly created function, so the ACL is never NULL here. Deleting every ACL statement is
      caught by `POSTFLIGHT_GRANT_PUBLIC` instead, which is what the prover asserts. Recorded rather
      than dressed up, so no one later reads it as covered.
  - **The owner pin is load-bearing, not tidiness.** `CREATE OR REPLACE` keeps a function's owner;
    `DROP` + `CREATE` re-owns it to whoever runs the migration. This body does
    `SELECT * FROM application_services`, and `20260729015706` revoked `SELECT` on that table from
    `authenticated` and re-granted only the non-cost columns — safe, by its own comment, only
    because every function reading it is a **postgres-owned** SECURITY DEFINER. A re-owned function
    would either break every preview with `permission denied for column cost_per_acre_cents` or
    widen the SECDEF read surface past what the 2026-07-28 ACL audit signed off on.
  - The legacy 3-argument signature is dropped too. That DROP *clears* a third known shape; it does
    not *prove* the "exactly one signature afterwards" claim, because a DROP list can only remove
    shapes someone thought of. The claim is proven by `POSTFLIGHT_OVERLOAD`, which counts the
    catalog after the replacement and refuses the apply at any count other than one — including a
    shape nobody enumerated. `PREFLIGHT_OVERLOAD` makes the same count *before* the apply and prints
    the unexpected signature so it can be enumerated.
- **Caller** `src/pages/FieldApplicationInvoice.tsx` `handlePreview` now sends `p_invoice_date` — the
  same `transactionDate` it already sends to `save_field_app_invoice`.
- **`src/types/supabase.ts`** RPC `Args` updated for the new parameter.
- **New prover** `scripts/smoke/prove-preview-field-app-season.mjs`.
- **New regression test** in `src/pages/FieldApplicationInvoice.test.tsx` asserting the caller sends
  the date AND that it is the identical value Save stamps the invoice with.

### The ACL trap this had to avoid

A fresh `CREATE FUNCTION` re-acquires **both** a default `PUBLIC` grant and, under Supabase's
`ALTER DEFAULT PRIVILEGES`, an explicit `anon` grant — and `REVOKE ALL ... FROM PUBLIC` does **not**
remove the latter. That is the exact regression `20260624030000` had to correct out of band after
`20260624020000` did this same DROP+CREATE on this same function. Both revokes are present here, and
the prover mutation-tests the `anon` one rather than trusting the comment.

### The `-- STATUS: NOT APPLIED` header is load-bearing, not decoration

The migration's second line carries `-- STATUS: NOT APPLIED`, and it must stay there until the
migration is applied live. `validateParkedMigrationCrossReferences` requires the parked-header set and
the ledger's `LOCAL CANDIDATE` set to be one-to-one **in both directions**, so a file registered as a
candidate without the header fails the guard-hook regression suite — which is what happened on the
first push of this branch: CI went red in two jobs (`Lint, Type Check, Test, Build` and `Phase 3C
Containment (Windows)`), both on the same single assertion, because the ledger row was written before
the header was. The header is not merely advisory: it is half of a cross-check that exists so an
unapplied migration cannot quietly drop out of the candidate registry. Adding it changed the file's
bytes and therefore its sha256, so the pin below and the ledger row were both re-recorded and the
container proof was re-run against the new bytes rather than the pin being edited to match.

### Proof observed

`node scripts/smoke/prove-preview-field-app-season.mjs` → **`PREVIEW_SEASON_PROOF_PASS`**, run against
migration sha256 `3f0860c98a41d857a6af37576140bd4f29aba48d1112d51bf712f934226808c4` and prover sha256
`2100cd4ce2e5c9c01085b4ff2edcdeeb3880da38ebd6b8dabf26ba4062921625` — recorded because a proof minted
against earlier bytes is void, and the apply gate binds the proof to the transmitted file's hash.

**Re-proven 2026-09-08 after the `-- ordering-guard: ahead-of-pending` declaration was added to the
header.** That line changed the file's hash from `8114f85abf5b82f1186447576d4aa92f439444d6d5e56ffd9ab9bcb815649003`
to the `3f0860c9…` above. It is a SQL comment and adds no executable statement, but "a comment cannot
change behaviour" is an argument, not evidence — so the container proof was RE-RUN against the new
bytes rather than the recorded pin being edited to match, and it passed all twenty-seven mutation
phases again (twenty-four refused by a named abort, three caught behaviourally). The two Codex charter
reviews were likewise re-minted against `3f0860c9…`; the proofs bound to `8114f85a…` are void and must
not be cited. In a
network-less `public.ecr.aws/supabase/postgres:17.6.1.143` container. It restores the schema baseline,
replays 58 ordered post-baseline migrations, installs production's byte-exact bodies, and applies
`20260904160000` and `20260904180000`.

**What that does and does not reach.** It reaches production's state **for the two function bodies on
this code path** — the preview function and the field-app save impl — byte-verified. It is not a
general replica: the replay deliberately stops at a marker, so twenty later ledger-selected migrations
are not replayed, four of which are applied live. A green run says nothing about DDL introduced by
those twenty. That is the right scope for this change and the wrong thing to generalise from.

- **Fidelity asserted, not assumed:** the installed preview body must hash to
  `ca33fb973d86dbf3a2788dc11fbc49a5` and present exactly one signature and live's grant posture
  (`anon=false, authenticated=true, service_role=true`, PUBLIC=false) before any later phase counts.
  Stated precisely, because the looser version of this sentence claims more than the container can
  deliver: the preview function is not in the live-bodies fixture, so what the container replays is
  the **repo's** `20260630180000` body. This phase therefore proves the repo source agrees with the
  constant the preflight will enforce — not that live agrees with it. The check that actually binds
  live is `PREFLIGHT_BODY_DRIFT` at apply time, which is fail-closed, and re-reading live's
  `md5(prosrc)` immediately before the apply is the cheap way to confirm the constant is still fresh.
- **Read live's `proacl` in that same breath, for the same reason.** This is new as of the review
  that moved `PREFLIGHT_GRANT_DRIFT` above the replay branch. Before that change the ACL literal
  gated only a retry; now it gates the 4-argument path — the one the real apply takes — so a
  grantee set that drifts between today's read and the apply refuses the migration exactly the way a
  drifted body does. Both are fail-closed, so nothing unsafe happens either way; the point of the
  re-read is to find out *before* the apply rather than from an abort. The single read-only query
  covers both:

  ```sql
  SELECT md5(p.prosrc) AS body_md5, p.proacl
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'preview_field_app_invoice_split';
  ```

  Expected, unchanged from the 2026-09-06 read recorded above: `ca33fb973d86dbf3a2788dc11fbc49a5`
  and `{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}`. Anything else is a
  re-review, not a retry. (Column reads only — no catalog *function* calls, which is what keeps this
  inside what the live-data guard permits.)
- **Control (PHASE 2a):** a same-season invoice dated 2026-09-30 already agreed at 1111c/acre on both
  sides, so a later PASS is not just "everything agrees".
- **Both defects reproduced through the real installed functions:** a new invoice dated 2026-10-01
  previewed **1111c/acre** while save charged **2222c/acre** (totals 11110 vs 22220); reopening an
  invoice filed under season 2027 previewed 1111c while save charged 2222c.
- **After the candidate all cases agree**, on both sides of the boundary, including the settled edge
  case — a season-2026 invoice re-dated 2026-10-01 quotes and charges 1111c/acre, not 2222c.
- **Re-apply is safe:** same single signature, same grants, same behaviour.
- **The invoice-GROUP branch is exercised (PHASE 4e).** Two customers split one field 50/50, so
  save allocates a real `invoice_group_id` and one invoice per customer. The group is created in
  season, then reopened at a next-season date: both members keep their stored season and preview
  quotes each member's stored-season rate. This branch had **no test at all** until review caught it
  — every other probe seeds one customer, so the loop could only ever reach the other two branches.
- **Its first version was weaker than it read, and that was caught too.** It seeded both customers
  identically and saved them in the same season, so the lookup under test returned the same answer
  whether or not either of its join predicates was there. It proved the branch was *reached* and
  returned a real season; it did not prove the branch read the right *row*. The fixture is now
  asymmetric:
  - Member B is stored one season ahead of A and has its own rate in that season, so the two members
    must resolve to different prices. Drop `AND i.customer_id = v_customer_id` and the `LIMIT 1`
    hands one arbitrary member's season to both — whichever row it picks, **two** assertions fail:
    if it picks A's season, B is both mis-quoted against its own save and off its expected rate; if
    it picks B's, A is. A deterministic catch, not a probabilistic one. The measured run: A stored in
    season 2026 quotes 1111c/acre, B stored in season 2027 quotes 3333c/acre, and save charges each
    the same.
  - A soft-deleted sibling row for A, in a third season with a third rate, makes the correct answer
    *depend* on `AND i.deleted_at IS NULL`. Stated honestly: that is not written up as a mutation
    proof of the predicate, because the query has no `ORDER BY`, so deleting the predicate would
    leave the lookup choosing arbitrarily between two rows and a mutant would be caught only about
    half the time. A coin-flip assertion is worse than none.
- **Twenty-seven mutation phases, each of which MUST fail, and each did — twenty-four refused at
  apply time by a named abort, three caught behaviourally.** The distinction is deliberate and worth
  stating plainly: no static guard can see a season-logic regression, so the three behavioural
  mutants install cleanly and are caught only by the parity probes and a grant read. Anyone reading
  this as "the migration refuses a wrong season" would be wrong.
  - **Refused by a named abort:** a wrong preflight body pin → `PREFLIGHT_BODY_DRIFT`; the function
    handed to a different owner → `PREFLIGHT_OWNER`, before anything is dropped; a false rollover
    expectation → `PREFLIGHT_SEASON_RULE`; a pre-existing second overload → `PREFLIGHT_OVERLOAD`,
    with both signatures left exactly as found; nothing installed at all → `PREFLIGHT_MISSING`,
    creating nothing; the live 5-argument body patched by another lane and then re-applied →
    `PREFLIGHT_REPLAY_BODY_DRIFT`, **with the patch still in place afterwards**; an outside grant on
    the installed 5-argument function, and separately on the 4-argument predecessor live actually
    carries → `PREFLIGHT_GRANT_DRIFT` both times, **with that grant still in place afterwards**
    both times, each abort asserted to name the identity it found so the two paths cannot be
    confused; a reviewed grantee **removed** from the 4-argument predecessor → `PREFLIGHT_GRANT_DRIFT`
    again, asserted also **not** to have silently re-granted it (the check is written
    `IS DISTINCT FROM`, which fires in both directions, and until review every mutant tested only
    the extra-grantee direction — the missing-grantee half was carried by the word "DISTINCT" and
    nothing else); a wrong **postflight** body pin on a re-apply → `POSTFLIGHT_BODY`; `p_invoice_date`
    deleted from the `CREATE`, the grant statements and the owner statement → `POSTFLIGHT_SIGNATURE`;
    every `DEFAULT` deleted while the types stay identical → `POSTFLIGHT_ARGUMENT_DEFAULTS`; the
    replacement re-owned → `POSTFLIGHT_OWNER`; `SECURITY INVOKER` →
    `POSTFLIGHT_NOT_SECURITY_DEFINER`; `pg_temp` **prepended** ahead of `public` →
    `POSTFLIGHT_SEARCH_PATH`; `STABLE` flipped to `VOLATILE` → `POSTFLIGHT_VOLATILITY`; the
    4-argument `DROP` neutered so a second overload survives → `POSTFLIGHT_OVERLOAD`; `authenticated`
    revoked → `POSTFLIGHT_GRANT_LOST`; the `anon` REVOKE dropped → `POSTFLIGHT_GRANT_ANON`, rolling
    back completely; every ACL statement deleted → `POSTFLIGHT_GRANT_PUBLIC`; EXECUTE granted to a
    third role → `POSTFLIGHT_GRANT_UNEXPECTED`, naming the grantee; a 4-argument function carrying
    the **wrong argument names** → `PREFLIGHT_SIGNATURE`, asserted also *not* to be reported as body
    drift **and** not as grant drift — the stub's default `anon` grant is deliberately left in
    place, because that is the ordering regression test described above; `RETURNS text` in place of
    `RETURNS jsonb` → `POSTFLIGHT_RETURN_TYPE`; and `STRICT` added to the declaration →
    `POSTFLIGHT_VOLATILITY`, asserted to name `proisstrict=t` rather than just the label.
  - **Caught behaviourally:** the fix removed — still calls `current_season()`, both windows
    mis-price again; `v_price_season := v_new_season`, ignoring the row's stored season —
    re-breaks the edited-across-the-boundary case (2222 vs 1111); the `anon` REVOKE dropped
    **together with** its postflight checks — the apply succeeds and grants empirically become
    `anon=true`. The `POSTFLIGHT_GRANT_ANON` mutant and this one are a pair on purpose: the first
    alone would only show that *something* refused the apply, and this one is what proves the REVOKE
    itself is what closes the grant.
  - **Coverage, stated rather than implied.** The migration carries **twenty-two** distinct abort
    labels and **twenty-one** of them are made to fire by name above. Exactly one is not:
    - `POSTFLIGHT_ACL_DEFAULT` — **unreachable on this project**, not merely untested. Supabase's
      `ALTER DEFAULT PRIVILEGES` materialises `proacl` on every newly created function, so a NULL
      ACL cannot occur. Deleting every ACL statement is caught by `POSTFLIGHT_GRANT_PUBLIC` instead,
      which is what the prover asserts.

    Separately, **four arms** of otherwise-proven labels are unexercised. That is a smaller claim
    than an unproven label and is kept separate for that reason — folding the two together made an
    earlier revision's arithmetic (twenty-one labels minus nineteen equals three) read as an error:
    - `POSTFLIGHT_GRANT_LOST` raises from two places. The `authenticated` arm is proven; the
      `service_role` arm is the same three lines against a different role name.
    - `POSTFLIGHT_RETURN_TYPE` tests two things. The `prorettype` half is proven. The
      **set-returning** half cannot be reached by a mutant that keeps this body: measured in the
      prover's own image on 2026-09-06, PL/pgSQL refuses to compile `RETURN v` inside a
      `RETURNS SETOF` function — *"RETURN cannot have a parameter in function returning set"* — so
      the `CREATE` aborts before the postflight ever runs, and `RETURNS TABLE` carries the same
      restriction. The check is still not decoration: it is what would catch a future rewrite to
      `RETURN NEXT`, which changes nothing else this file pins.
    - `PREFLIGHT_GRANT_DRIFT`'s abort message has a `COALESCE` arm for a NULL `proacl`. Unreachable
      for the same reason as `POSTFLIGHT_ACL_DEFAULT`: on this project `proacl` is always
      materialised, so that wording never prints.
    - `POSTFLIGHT_GRANT_UNEXPECTED`'s `PUBLIC` arm is unreachable **by design**, not by accident:
      `POSTFLIGHT_GRANT_PUBLIC` aborts on `grantee = 0` several checks earlier. It is kept so the
      expression stays byte-identical to the preflight's, and the migration says at that check that
      nobody should try to mutation-prove it.

    `PREFLIGHT_SIGNATURE` was on this list until 2026-09-06, on the grounds that the repo has no
    source for a 4-argument overload with the wrong argument names. It does not need one: a trivial
    stub with the same types and different names is enough, because the check reads the catalog and
    not the body. It is now proven.
  - A measurement worth keeping from that last mutant: simply **deleting** `authenticated` from the
    `GRANT` does not abort, because the same default privileges already grant it. The explicit
    `GRANT` is belt-and-braces on this project rather than the thing conferring the privilege, so
    the mutant that actually tests the guard has to *revoke* the role.
  - No mutant was ever written to `supabase/migrations/`.

  Worth recording because it nearly passed silently: the first version of mutant (c) replaced the
  md5 by bare substring, which hit the **header comment** rather than the preflight's comparison —
  the mutation was a no-op on the property under test and the apply succeeded. The prover now
  asserts the pin appears exactly once as an executable test before mutating it.

Also observed: `npm run typecheck` clean, `npx eslint src scripts supabase` clean, `npm run build`
clean, `npm test` **356 files / 5078 passed, 123 skipped**, and
`npm run check:migration-hard-rules` reports only the one pre-existing 2026-02-21 `rate_limit_log`
failure, untouched by this change.

The frontend regression test was **mutation-checked**: removing `p_invoice_date` from the caller makes
it fail at the `toMatchObject` assertion, and restoring it makes it pass.

### Deploy order — the migration goes first

`handlePreview` now sends a fifth named argument. PostgREST resolves by argument-name set, so against
the currently-live 4-argument function that call returns `PGRST202` and **every** Preview click
fails, not just the season case. So: apply the migration to live **before** the frontend merges and
deploys. The reverse order is safe — an already-deployed 4-argument caller still resolves against
the 5-argument function through the `DEFAULT`.

**How far that is proven.** PHASE 4d calls the installed function with exactly the four argument
NAMES the deployed frontend sends, using PostgreSQL's named notation, and requires it to resolve and
price correctly. That is the closest the SQL layer gets to PostgREST's resolution, and it is the
layer where a renamed or removed argument actually bites — but the container runs no PostgREST, so
the `PGRST202`/`PGRST203` behaviour itself is reasoned from PostgREST's documented name-set
resolution, not observed here. Nothing in this repo enforces the ordering either; it is operator
discipline, and worth converting into a hard gate if this pattern recurs.

### Not verified / still open

- **Not applied live.** The migration has run only in a throwaway container. Applying it needs Mason's
  explicit approval in the conversation immediately beforehand.
- **The apply will be refused until the ordering snapshot is refreshed.**
  `.claude/session-state/applied-migrations.json` was captured 2026-09-04 and the apply guard rejects
  a snapshot older than 24 hours, so `scripts/apply-migration-file.mjs` blocks before the SQL is ever
  transmitted. Fail-closed, so nothing is at risk — but it must be refreshed from a read-only ledger
  read **immediately before** the apply, not now, or it will simply be stale again. Refreshing raises
  the effective high-water to `20260905185938`, which `20260906120000` still clears.
- **`src/types/supabase.ts` was hand-edited.** No CI guard compares that file to the live schema, so
  nothing will fail if it drifts — but the next regeneration must happen *after* the apply, or it
  will revert the `p_invoice_date` entry.
- **Two pre-existing preview/save asymmetries remain**, both display-only and both unchanged by this
  work: preview does not refuse a cleared date (it falls back to the Chicago business date) while
  save does, and preview has neither save's draft/unposted status gate nor its zero-applied-acres
  refusal, so it can price rows save would reject.
- **No exact-SHA Codex proof.** Codex CLI credits are exhausted until 2026-09-11
  (`write-codex-push-proof.mjs` exits 1 with a usage-limit message, which the wrapper reports as "did
  not return a clean verdict" — that is an outage, not a finding). Until then `pr-merge-guard` will
  refuse an agent merge of this diff.
- **Not exercised in a browser.** The changed screen is auth-gated behind live Supabase data; the
  behaviour under test is server-side and is covered by the container prover instead.
- `harness.local/auth-stub.tsx` produces the one `npm run lint` warning. It is gitignored, untracked,
  left over from another session, and outside this change.
