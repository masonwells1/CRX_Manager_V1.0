## 2026-09-03 — Gate the eight `next_*_number` generators behind an active profile and a role (F2)

Closes item **F2** in `docs/manual/KNOWN_ISSUES.md`. One new migration,
`20260903160000_gate_number_generators_active_profile_role.sql`, plus a checked-in disposable
prover. No frontend file changed.

### What was wrong

All eight `SECURITY DEFINER` number generators — `next_application_record_number`,
`next_commission_payment_number`, `next_cycle_count_number`, `next_delivery_number`,
`next_invoice_number`, `next_job_number`, `next_po_number`, `next_return_number` — granted `EXECUTE`
to `authenticated` and checked nothing. Any logged-in principal could call all eight.

Two corrections to the severity recorded on 2026-09-01, both from live read-only introspection on
2026-09-03:

* **`next_invoice_number` is not read-only.** It calls `nextval()` and conditionally `setval()` on
  four invoice sequences (`invoice_number_seq`, `cs_`, `mc_`, `cm_`). An unauthorized caller could
  therefore **advance live invoice numbering**, not merely observe the next value. The prior
  "sequence-number disclosure and advisory-lock contention" framing understates this.
* **There is a real unauthorized population today.** Live `profiles` holds 2 active
  `entity_recipient` (customer-portal) accounts and 1 deactivated `sales_rep`. All three could call
  all eight generators.

### What changed

Each body now gates before it does anything else — including before its advisory lock, so a refused
caller cannot take the lock either:

```
v_actor := auth.uid();
IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
IF NOT EXISTS (SELECT 1 FROM public.profiles
   WHERE id = v_actor AND is_active = true AND role IN (...)) THEN
  RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
```

| Generator | Allowed roles |
|---|---|
| `next_application_record_number`, `next_job_number` | admin, sales_rep, applicator |
| `next_delivery_number`, `next_invoice_number` | admin, sales_rep, driver |
| `next_po_number`, `next_return_number` | admin, sales_rep |
| `next_cycle_count_number`, `next_commission_payment_number` | admin |

Every set excludes deactivated profiles and `entity_recipient`.

**The gate is in the body AND the grants are narrowed.** `src/pages/CycleCounts.tsx:155` and
`src/pages/JobDetail.tsx:1861` call two of these directly from the browser as `authenticated`, so
those two KEEP their grant. Direct `authenticated` EXECUTE is **REVOKED from the other six**
(`next_application_record_number`, `next_commission_payment_number`, `next_delivery_number`,
`next_invoice_number`, `next_po_number`, `next_return_number`) — added on Mason's explicit approval
after adversarial review rated it HIGH. The in-body gate settles WHO may call; it cannot settle
WHERE FROM, and that was the gap: the gate admits `driver` on `next_invoice_number` because
auto-invoice on a driver's ASSIGNED delivery needs it, but a direct RPC call carries no delivery
context, so any active driver could pick any `p_invoice_type` and advance invoice numbering at will.
Safe because all 16 live routines referencing those six are `SECURITY DEFINER` and run as the
postgres owner; `service_role` keeps EXECUTE throughout.

### How the role sets were chosen

Union of (a) the roles that can reach the creating surface in `src/lib/pagePermissions.ts` and
(b) the roles admitted by every live RPC that calls the generator internally. 18 internal
`SECURITY DEFINER` RPCs call these. Load-bearing findings:

* `_complete_delivery_authorized_impl` admits admin, sales_rep, or the delivery's **own assigned**
  driver, and already requires `is_active = true` (verified against live `prosrc`; an earlier
  revision of this line said it "checks authentication but not role", which is false — the real path
  is tighter than that implied, not looser). A driver completing their assigned delivery reaches
  `next_invoice_number` through the auto-invoice path, so `driver` is in the invoice and delivery
  sets. An admin-only gate would have
  broken delivery completion in production.
* `complete_job` admits `applicator`, but its invoice branch runs through `transfer_job_to_invoice`,
  which **already** requires admin/sales_rep. So applicator is deliberately *not* in the invoice set,
  and no path that succeeds today starts failing.
* No Edge Function and no cron job reaches a generator, directly or through a caller — checked
  against all 8 live cron entries and `supabase/functions/`. Gating on `auth.uid()` cannot break a
  background path.

### Proof observed

`node scripts/smoke/prove-number-generator-gates.mjs` → `NUMBER_GENERATOR_GATE_PROOF_PASS`.
Disposable `postgres:17-alpine`, `--network none`, tmpfs; never reads a DB URL. It installs the eight
**current live (ungated)** bodies with the live ACL, then applies the migration file verbatim.

* **Before:** all 7 principals × 8 generators return a number — the hole reproduced, not assumed.
* **After:** the full 7×8 matrix plus the unauthenticated case matches the intended allow table
  exactly. Deactivated admin, deactivated sales_rep and `entity_recipient` get `INSUFFICIENT_ROLE`
  on all eight; no JWT gets `AUTH_REQUIRED` on all eight.
* **ACL shape:** per-function `proacl` captured before and after and asserted against the intended
  shape in both directions — the two browser callers keep `authenticated` EXECUTE, the other six must
  have LOST it, `anon` holds it on none, `service_role` keeps it on all eight. It formerly asserted
  the ACLs were byte-identical; once the revoke existed that check was not merely stale but
  dangerous — it would have passed while the revoke silently did nothing.
* **The driver hole, proven closed:** an active driver calling
  `next_invoice_number('chemical_sale')` directly as `authenticated` returns
  `permission denied for function next_invoice_number`.
* **Browser-shaped call:** `SET LOCAL ROLE authenticated` + JWT claim returns `CC-2026-00001`, the
  exact path `CycleCounts.tsx` uses.
* **Sequence safety:** `invoice_number_seq` advanced 8 → 11 for exactly 3 admitted callers. Refused
  callers advanced nothing.
* **Mutation tests — 9 of them, each confirming a postflight assertion actually fires:** revoking
  `authenticated`'s EXECUTE, granting `anon` EXECUTE, adding a second `next_po_number` overload,
  dropping `search_path`, dropping `SECURITY DEFINER`, removing the gate from a body, placing the
  gate *after* the advisory lock, admitting `entity_recipient`, and dropping the `is_active` check.
  All nine were caught by the intended assertion, and the clean postflight still passes afterwards,
  so the mutations are not a false green.

`npm run typecheck` clean. `npm run lint` clean (0 warnings).
`npm run check:migration-hard-rules` — this migration passes; the single reported failure is the
pre-existing `20260221200000_rate_limiting.sql` RLS finding on `main`, untouched here.

### Not verified

* **Not applied live.** No production database change was made by this repository change. The live
  apply is a separate approval and, per the session queue, sits behind another session's pending
  `20260903150000`.
* Ordering was checked against the live ledger at write time (newest applied authored name
  `20260831235900_serialize_gauntlet_write_boundaries`); it must be re-read immediately before any
  apply, because sibling sessions move it.
* `.claude/schema-registry.json` is unchanged and should be refreshed from live introspection only
  **after** an apply.
* No behavior was exercised against production. The proof is a disposable clone with a minimum
  schema, not a full production-schema replay.
