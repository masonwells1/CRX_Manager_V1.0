## 2026-09-05 - Quick-delivery scheduled date: convert the ARGUMENT default, and make the guard able to see it

**Not applied to production.** `20260905020500` remains parked with the rest of the
`20260905020*` set.

## What was wrong

`20260905020500` converted every `CURRENT_DATE` in the four document-date writers and then
asserted, in its own postflight, that none remained. It re-emitted
`_create_quick_delivery_intent_impl_20260802` with `p_scheduled_date date DEFAULT CURRENT_DATE`
still in the **signature**.

Argument defaults are stored in `pg_proc.proargdefaults`. The postflight scanned `pg_proc.prosrc`,
which holds the function **body only**. So the migration would have installed a UTC `CURRENT_DATE`
and reported success — the guard was not wrong about what it checked, it was wrong about what it
claimed.

Found by the exact-snapshot `gpt-5.6-sol` review of `b4bc0edfb`.

## What changed

- `p_scheduled_date`'s default is now `(now() AT TIME ZONE 'America/Chicago')::date`.
- The postflight reads `pg_get_expr(p.proargdefaults, 0)` alongside `prosrc` and raises
  `POSTFLIGHT_UTC_RESIDUAL_DEFAULT` on a residual.
- The postflight raises `POSTFLIGHT_DEFAULTS_UNREADABLE` when a function declares defaults but the
  reader returns NULL. Without this the check could go dark and pass on NULL: `pg_get_expr`'s
  second argument is the **relation** the expression belongs to, so the obvious
  `pg_get_expr(p.proargdefaults, p.oid)` — mirroring how `prosrc` is read one line above — returns
  NULL for every function, silently. A guard built that way reports clean because it stopped
  looking.
- The migration header now records what this file does **not** close (below).
- The B10 caller-analysis markers the grant block was missing are now present, with each grantee
  set checked against live `pg_proc.proacl`: every `REVOKE`/`GRANT` in that block is a no-op
  reassertion and no caller loses a privilege it holds today.

## What this does NOT close

The public wrapper `public.create_quick_delivery` carries the **same** `CURRENT_DATE` argument
default, and its body resolves `p_scheduled_date` and passes it positionally into the
implementation. The implementation's default can therefore never fire through the wrapper — the
converted default above is dead in the app's real call path, and the wrapper's is the one an
omitting caller reaches.

The wrapper is not one of the four writers this file re-emits, and changing an argument default
requires `CREATE OR REPLACE` of its whole 5,112-byte body — a separate re-emit with its own md5
pin. Tracked as its own change rather than widening a money migration mid-landing.

Live exposure today is nil: the only caller,
`src/components/deliveries/QuickDeliveryModal.tsx:381`, always passes `p_scheduled_date`. It is
seeded from `localToday()`, which reads the **browser** clock rather than the business zone — a
separate frontend defect of the same family, also not fixed here.

## Proof

`node scripts/smoke/prove-document-dates-chicago.mjs` — disposable Postgres, baseline restore plus
58 replayed migrations, **ALL PHASES PASSED**. Three phases are new:

- **PHASE 2b** — the defect reproduces on a clean rebuild: defaults read
  `NULL::uuid, CURRENT_DATE, NULL::text, NULL::uuid, NULL::text, false`.
- **PHASE 4c** — after apply they read
  `NULL::uuid, ((now() AT TIME ZONE 'America/Chicago'::text))::date, NULL::text, NULL::uuid, NULL::text, false`.
- **PHASE 8** — reverting **only** the argument default aborts in
  `POSTFLIGHT_UTC_RESIDUAL_DEFAULT`, and the run asserts the body check stayed silent, so the new
  check is what caught it.
- **PHASE 9** — swapping the reader's second argument from `0` to `p.oid` (which the run first
  demonstrates returns NULL) aborts in `POSTFLIGHT_DEFAULTS_UNREADABLE` instead of passing.
