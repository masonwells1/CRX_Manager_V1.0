## 2026-09-06 — the field-application invoice PREVIEW prices at the invoice's season, not the server clock (CRX-SEC-001)

Closes the open `preview_field_app_invoice_split` entry in `docs/manual/KNOWN_ISSUES.md`, raised as a
P1 by the Codex GitHub App on PR #599 and the sole HIGH finding in that PR's 2026-09-05 push-proof.

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
    `20260630180000_field_app_pricing_unit_fix.sql:676-912`) plus four additive deltas: the new
    parameter, four declares, the season setup after `derive_customer_shares_from_fields`, and the
    `customer_application_rates` lookup binding to `v_price_season`. Nothing else moves — no pricing,
    rounding, unit-conversion or ACL behaviour changes.
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
      every claim below it is about a different calendar); `PREFLIGHT_OVERLOAD` (exactly one
      existing overload); `PREFLIGHT_OWNER` (`postgres`); `PREFLIGHT_SIGNATURE` (either the
      4-argument predecessor or the 5-argument candidate); `PREFLIGHT_BODY_DRIFT` (the predecessor's
      reviewed body md5, so an apply over a body another lane changed is refused rather than
      silently reverting it); and, on the replay path only, `PREFLIGHT_REPLAY_BODY_DRIFT`.
    - **Why the replay path needs its own body pin.** When the 5-argument candidate is already
      installed, the preflight returns early and the postflight's body pin cannot help: the
      postflight reads `prosrc` *after* `DROP` + `CREATE`, so on a replay it is reading this file's
      own body and would agree with itself no matter what it destroyed. `PREFLIGHT_REPLAY_BODY_DRIFT`
      is the only thing standing between a re-apply and a silent overwrite of a patch another lane
      made to the live 5-argument body — the `batch_apply_prepayments` silent-revert class of
      2026-07-15. The prover asserts not just that it aborts, but that the simulated patch is *still
      there* afterwards.
    - `$postflight$`, reading the catalog back after the replacement: `POSTFLIGHT_OVERLOAD` (exactly
      one signature); `POSTFLIGHT_SIGNATURE`, compared against the full **named** identity
      `preview_field_app_invoice_split(p_locations jsonb, p_chemicals jsonb, p_application_service_id
      uuid, p_invoice_id uuid, p_invoice_date date)` — names, not just types, because PostgREST
      resolves RPCs by argument name, so a rename is a break even when every type matches;
      `POSTFLIGHT_ARGUMENT_DEFAULTS` (the three `DEFAULT NULL`s a 4-argument caller depends on are
      still declared — invisible to the signature check, which does not render defaults);
      `POSTFLIGHT_OWNER`; `POSTFLIGHT_SECDEF`; the exact `search_path` string; `POSTFLIGHT_BODY`
      (the installed body md5); and the four ACL checks below.
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

### Proof observed

`node scripts/smoke/prove-preview-field-app-season.mjs` → **`PREVIEW_SEASON_PROOF_PASS`**, run against
migration sha256 `7053128623f26835b4c9503d1bf1e2775a35f1591dd807470bd9f8f8ecc4e895` and prover sha256
`b0650094106926157d8854c9f4ce19040812bf45405f4f6c849c6ddcddeda3d7` — recorded because a proof minted
against earlier bytes is void, and the apply gate binds the proof to the transmitted file's hash. In a
network-less `public.ecr.aws/supabase/postgres:17.6.1.143` container. It restores the schema baseline,
replays 58 ordered post-baseline migrations, installs production's byte-exact bodies, and applies
`20260904160000` and `20260904180000` to reach the state production is in now.

- **Fidelity asserted, not assumed:** the installed preview body must hash to live's
  `ca33fb973d86dbf3a2788dc11fbc49a5` and present exactly live's one signature and grant posture
  (`anon=false, authenticated=true, service_role=true`, PUBLIC=false) before any later phase counts.
- **Control (PHASE 2a):** a same-season invoice dated 2026-09-30 already agreed at 1111c/acre on both
  sides, so a later PASS is not just "everything agrees".
- **Both defects reproduced through the real installed functions:** a new invoice dated 2026-10-01
  previewed **1111c/acre** while save charged **2222c/acre** (totals 11110 vs 22220); reopening an
  invoice filed under season 2027 previewed 1111c while save charged 2222c.
- **After the candidate all cases agree**, on both sides of the boundary, including the settled edge
  case — a season-2026 invoice re-dated 2026-10-01 quotes and charges 1111c/acre, not 2222c.
- **Re-apply is safe:** same single signature, same grants, same behaviour.
- **Thirteen mutants, each of which MUST fail, and each did — ten refused at apply time by a named
  abort, three caught behaviourally.** The distinction is deliberate and worth stating plainly: no
  static guard can see a season-logic regression, so the three behavioural mutants install cleanly
  and are caught only by the parity probes and a grant read. Anyone reading this as "the migration
  refuses a wrong season" would be wrong.
  - **Refused by a named abort:** (a) a wrong preflight body pin → `PREFLIGHT_BODY_DRIFT`;
    (b) the function handed to a different owner → `PREFLIGHT_OWNER`, before anything is dropped;
    (c) a wrong **postflight** body pin on a re-apply → `POSTFLIGHT_BODY`; (d) `p_invoice_date`
    deleted from the `CREATE` and from the grant statements → `POSTFLIGHT_SIGNATURE`; (e) every
    `DEFAULT` deleted while the types stay identical → `POSTFLIGHT_ARGUMENT_DEFAULTS`; (f) the live
    5-argument body patched by another lane and then re-applied → `PREFLIGHT_REPLAY_BODY_DRIFT`,
    **with the patch still in place afterwards**; (g) the 4-argument `DROP` neutered so a second
    overload survives the apply → `POSTFLIGHT_OVERLOAD`; (h) the `anon` REVOKE dropped →
    `POSTFLIGHT_GRANT_ANON`, rolling back completely; (i) every ACL statement deleted →
    `POSTFLIGHT_GRANT_PUBLIC`; (j) EXECUTE granted to a third role → `POSTFLIGHT_GRANT_UNEXPECTED`,
    naming the grantee.
  - **Caught behaviourally:** (k) the fix removed — still calls `current_season()`, both windows
    mis-price again; (l) `v_price_season := v_new_season`, ignoring the row's stored season —
    re-breaks the edited-across-the-boundary case (2222 vs 1111); (m) the `anon` REVOKE dropped
    **together with** its postflight checks — the apply succeeds and grants empirically become
    `anon=true`. (h) and (m) are a pair on purpose: (h) alone would only show that *something*
    refused the apply, and (m) is what proves the REVOKE itself is what closes the grant.
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

### Not verified / still open

- **Not applied live.** The migration has run only in a throwaway container. Applying it needs Mason's
  explicit approval in the conversation immediately beforehand.
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
