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
  - **Apply-time guards.** A `$preflight$` block asserts one existing overload, `postgres`
    ownership, the expected signature (with a replay path for the already-installed candidate), and
    the reviewed body md5 — so an apply over a body another lane changed is refused rather than
    silently reverting it. A `$postflight$` block reads the catalog back after the replacement and
    asserts one signature, `postgres` ownership, `SECURITY DEFINER`, the pinned `search_path`, a
    non-NULL ACL, and — via `aclexplode`, not inferred from the statements above it — that PUBLIC
    and `anon` hold no EXECUTE while `authenticated` and `service_role` do. The migration runs in a
    single transaction, so either guard firing rolls the whole file back.
  - **The owner pin is load-bearing, not tidiness.** `CREATE OR REPLACE` keeps a function's owner;
    `DROP` + `CREATE` re-owns it to whoever runs the migration. This body does
    `SELECT * FROM application_services`, and `20260729015706` revoked `SELECT` on that table from
    `authenticated` and re-granted only the non-cost columns — safe, by its own comment, only
    because every function reading it is a **postgres-owned** SECURITY DEFINER. A re-owned function
    would either break every preview with `permission denied for column cost_per_acre_cents` or
    widen the SECDEF read surface past what the 2026-07-28 ACL audit signed off on.
  - The legacy 3-argument signature is dropped too, so "exactly one signature afterwards" covers
    all three known shapes rather than the two this file otherwise names.
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
migration sha256 `96e8d6f6401e88edbea599a5bf3e6242568a03cb49ca803143ec3cd318ae0a83` and prover sha256
`7001c167d94f3e2039ae571bfc9a2682ce8e7effee4e245dee17f1cdaaf1fa8b` — recorded because a proof minted
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
- **Eight mutants, each of which MUST fail by a NAMED abort, and each did:** (a) the fix removed —
  still calls `current_season()`, both windows mis-price again; (b) `v_price_season := v_new_season`,
  ignoring the row's stored season — re-breaks the edited-across-the-boundary case (2222 vs 1111);
  (c) the body pin pointed at a wrong md5 — the apply aborts at `PREFLIGHT_BODY_DRIFT` and changes
  nothing; (d) the function handed to a different owner — the apply aborts at `PREFLIGHT_OWNER`
  before dropping anything; (e) a wrong **postflight** body pin on a re-apply — aborts at
  `POSTFLIGHT_BODY`, which matters because the replay path deliberately skips the preflight's pin,
  so this is the only thing stopping a re-apply from overwriting a body another lane patched;
  (f) `p_invoice_date` deleted from the `CREATE` and from the grant statements, so the migration
  installs the old 4-argument shape while claiming to be this file — aborts at
  `POSTFLIGHT_SIGNATURE`, which is what stops a silently-reverted signature from being reported as a
  successful apply; (g) the `anon` REVOKE dropped — the apply aborts at `POSTFLIGHT_GRANT_ANON` and
  rolls back completely, leaving live's access surface intact; (h) the `anon` REVOKE dropped
  **together with** its postflight check — the apply succeeds and grants empirically become
  `anon=true`. (g) and (h) are a pair on purpose: (g) alone would only show that *something* refused
  the apply, and (h) is what proves the REVOKE itself is what closes the grant. No mutant was ever
  written to `supabase/migrations/`.

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
