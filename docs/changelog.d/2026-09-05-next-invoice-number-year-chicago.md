## 2026-09-05 — Invoice numbers take their year from the Chicago business date (WRITTEN AND PARKED)

**This migration is NOT applied. It is written, reviewed, proven in a container, and parked for
Mason to apply himself.** The deadline is 31 December 2026 — months away, not hours.

### The defect

`public.next_invoice_number(p_invoice_type text)` derives the year in an invoice number
(`CS-2026-0007`) from a bare `now()`. The live database clock runs in UTC; the business runs in
America/Chicago. December is CST (UTC-6), so **midnight UTC on 1 January is 6 pm Chicago on 31
December**. For the six hours from 6 pm Chicago until Chicago's own midnight, UTC has already rolled
to the new year while the business day has not.

Verified read-only against live 2026-09-05: `2027-01-01 02:00 UTC` is `2026-12-31 20:00` Chicago —
UTC year **2027**, Chicago year **2026**.

The same `v_year` is used three times in one function:

- the advisory lock key `'invoice_number:CS:<year>'`
- the `MAX()` scan that finds the highest number already issued for that year
- the number returned and stored

**What the defect actually is** — stated precisely, because an earlier version of this entry
overstated it and the exact-SHA review was right to call that out. An invoice created that evening
carries the **wrong business year in its number**: work done on 31 December 2026 is issued as
`CS-2027-0007`. Anything that reads the year out of an invoice number — year-end statements, per-year
filters, an operator scanning a list — files it under the wrong year, and that evening's year-scoped
`MAX()` scan and advisory lock key are wrong too.

**What it is not: a duplicate or colliding number.** The counter is one persistent sequence *per
prefix* (`invoice_number_seq`, `cs_`/`mc_`/`cm_invoice_number_seq` — verified read-only on live
2026-09-05), not a per-year counter that restarts. `nextval()` is atomic and monotonic, and the
reconciliation beneath it only ever *advances* the sequence when it lags that year's `MAX()`; it
never rewinds. So no number is issued twice. The earlier claim that these invoices come from "a
different counter" and "will collide with the real first invoices of 2027" was wrong on both halves,
and is withdrawn.

Same class as `20260904160000` (invoice_date fallbacks) and `20260904180000` (season follows
invoice_date), both applied live 2026-09-04, and the settled ~2026-07-10 rule: a bare
`now()`/`CURRENT_DATE` on live is a bug wherever a business date is meant.

### The change

`supabase/migrations/20260905090000_next_invoice_number_year_chicago.sql` re-emits the body from its
**live installed text** (`pg_proc.prosrc`, read read-only 2026-09-05) with exactly one line changed:

```
  v_year text := extract(year FROM now())::text;
->
  v_year text := extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::text;
```

The active-profile/role gate added by `20260903160000` is carried through unchanged — this is emitted
from the post-gate body, not an earlier one.

**No data is rewritten.** Numbers already issued keep their values; nothing is renumbered or deleted.
No grant moves: `CREATE OR REPLACE` preserves the ACL (`{postgres=X/postgres,service_role=X/postgres}`
— EXECUTE is **not** held by anon or authenticated) and the file contains no `GRANT`/`REVOKE`.

### Scope — the first sweep was wrong, and six sibling generators have the same bug

The original claim here was "all eight `next_%_number` generators were swept on live; only
`next_invoice_number` reads a year from `now()`, the other seven embed no year at all." The first
half is true. **The second half is false**, and the way it is false is the lesson: the sweep searched
for `now()`, so it answered its own question correctly and the wrong conclusion was drawn from it.

Re-swept read-only on live 2026-09-05, `current_setting('TimeZone')` = **UTC**, so `CURRENT_DATE` on
this server *is* the UTC calendar date — the same rollover, the same six-hour window, the same defect:

| generator | how it takes the year |
|---|---|
| `next_application_record_number` | `extract(year FROM current_date)` |
| `next_commission_payment_number` | `to_char(CURRENT_DATE, 'YYYY')` |
| `next_cycle_count_number` | `EXTRACT(YEAR FROM CURRENT_DATE)` |
| `next_job_number` | `extract(year FROM current_date)` |
| `next_po_number` | `extract(year FROM current_date)` |
| `next_return_number` | `extract(year FROM current_date)` |

Only `next_delivery_number` (`DEL-nnnnn`) genuinely embeds no year. Each of the six uses its `v_year`
in the advisory lock key, the `MAX()` scan and the returned number, exactly as `next_invoice_number`
does — so a job created at 7 pm Chicago on 31 December 2026 is numbered `JOB-2027-0001` off a counter
that has not started, and collides with the real first job of 2027.

**They are not fixed by this change** and they carry the same 31 December 2026 deadline. Recorded as a
follow-up in `docs/manual/KNOWN_ISSUES.md`. Do not read this migration as closing the family.

### Pins

Preflight refuses unless the installed body is byte-for-byte the reviewed body **or** this file's own
candidate (so a replay is a no-op, not a failure):

```
live      b53499d077bd84b78a6f8fec142741bc  (length 1458, no CR bytes)
candidate 7cbf50ddfe3abda50cc241f3374e98a3  (length 1497, no CR bytes)
```

Both are md5 of `pg_proc.prosrc` — the stored body text — not of a rendered `CREATE` statement, whose
header formatting is not stable. The live body is LF-only, so there is no CRLF preimage to accept.
The reconstruction used to derive the candidate pin was checked by hashing it and matching the live
md5 exactly before anything was written.

### Proof — `scripts/smoke/prove-next-invoice-number-year-chicago.mjs`

Runs the real migration against a throwaway PostgreSQL 17 container. **35/35 checks pass**
(`NEXT_INVOICE_NUMBER_YEAR_CHICAGO_PROOF_PASS`):

1. the reviewed body reproduces the live md5 — the pin is not fiction
2. the migration applies; result matches the candidate pin; `America/Chicago` present and bare
   `now()` gone
3. SECURITY DEFINER, `search_path = public, pg_temp`, the EXECUTE ACL, and single-overload all survive
4. replay is idempotent
5. a drifted body is **refused** and left untouched (transaction rolls back)
6. at `2027-01-01 02:00 UTC` the old expression yields 2027 and the new one 2026; **outside** the
   window both still agree on 2026, so the fix is narrow

**The container proof earned its keep twice.** It failed on the first run and caught a real bug in
this migration's own postflight assertion: it asserted the divergence at `2026-12-31 23:30 UTC`,
which is still 2026 in UTC — the wrong side of the boundary. The assertion now uses an instant inside
the real window and names both zones explicitly, so it no longer depends on the session `TimeZone` (a
bare `extract(year FROM timestamptz)` renders in it).

### BLOCKER found by review — the re-emit dropped the parameter DEFAULT

Both the `rls-security-reviewer` and the `migration-drift-reviewer` independently found the same
blocker, and it is the most important thing in this entry.

The live declaration is `next_invoice_number(p_invoice_type text DEFAULT 'field_application'::text)`
— confirmed from live `pg_proc`: `pronargs 1, pronargdefaults 1, default 'field_application'::text`.
The first draft wrote `(p_invoice_type text)`, silently dropping the default. PostgreSQL **refuses**
to remove a parameter default via `CREATE OR REPLACE` (`cannot remove parameter defaults from
existing function`), so the migration was **unappliable** — it would have aborted at the `CREATE`,
inside the transaction, in Mason's hands.

The dangerous part is the repair PostgreSQL itself suggests: `DROP FUNCTION` first. That would
(a) get the default `EXECUTE TO PUBLIC` on the fresh `CREATE`, re-opening the anon-EXECUTE class this
function was hardened against, and (b) collide with the `invoices.invoice_number` column default that
depends on this function. Live bodies also call it with **zero arguments**
(`_save_field_app_invoice_impl_20260714`), which is only possible because of that default. The fix is
the one word restored on the declaration; no `DROP` anywhere.

**Why the pins did not catch it, and what now does.** `md5(prosrc)` hashes only the text *between*
the `$fn$` markers. Argument names, types and defaults live in the declaration, outside it — so the
body pin matched perfectly with the default gone. Preflight and postflight now both assert
`pronargs`, `pronargdefaults` and the default expression, which converts this class of drift from
silent to caught.

### My own proof harness was falsely green, and that is worth recording

The first container run passed 15/15 **on a migration that could never have applied**. The reason:
the harness's setup installed the starting function *without* the default too — it reproduced the
same mistake the migration had, so the container agreed with the bug and the mismatch was invisible.
A mock that reproduces the defect under test proves nothing.

The harness now (a) installs the function with the live default, (b) reproduces the
`invoices.invoice_number` column default so a `DROP FUNCTION` repair would fail there exactly as on
production, and (c) runs a **step 0** that asserts the setup's own signature equals the live one
before any other check runs. It also now asserts the signature survives the re-emit and that a
**zero-argument call still resolves**. That took the suite from 15 checks to 19; the ACL mutation
tests below took it to 31.

### Other review findings addressed

- **ACL assertion made rebuild-portable.** It compared `proacl::text` to an exact string containing
  `service_role`, which comes from Supabase's bootstrap default privileges rather than any file in
  this repo — so a database rebuilt from the repo alone would have aborted a correct migration. It now
  asserts the *security property*: no `anon`, no `authenticated`, no `PUBLIC` EXECUTE. That is both
  portable and the thing actually worth catching, since an out-of-band grant is invisible to a body
  hash.

### The rebuild-portable ACL check was itself fail-open (Codex, exact-SHA review)

The adversarial review of the frozen candidate found that the replacement assertion did not actually
assert. Two compounding defects:

1. It was guarded by `IF v_acl IS NOT NULL AND (…)`. A **NULL** `pg_proc.proacl` does not mean "nobody
   has been granted anything" — it means **default privileges**, and PostgreSQL's default for a
   function is `EXECUTE TO PUBLIC`. So the single most open state was the one state the check skipped.
   (It could not have matched anyway: the query coalesced NULL to the literal string `'(null)'`, so
   `v_acl IS NOT NULL` was always true and the `LIKE` arms simply never matched it.)
2. Matching text in the ACL string cannot see EXECUTE that reaches `anon` **indirectly**, through
   membership in some other role that holds it. The string never mentions `anon` at all.

Both are now checked with `has_function_privilege('anon' | 'authenticated', oid, 'EXECUTE')`, which
resolves role membership and NULL-ACL defaults the way PostgreSQL itself does, plus an explicit
refusal on a NULL ACL. `to_regrole(...) IS NOT NULL` keeps the repo-only rebuild passing when those
Supabase roles do not exist, so the portability fix above survives. The literal PUBLIC forms
(`{=X/…`, `,=X/…`) are kept as a belt for that rebuild case.

**Proven by mutation, not by reading.** Proof step 7 now grants EXECUTE to `anon` directly, then
through an intermediate role, then drops the function and recreates it with no grants at all (a
genuine NULL ACL), and watches the migration refuse all three — asserting in the indirect case that
the ACL string does **not** contain `anon`, which is what makes the text match provably insufficient.
It also confirms `anon` really can execute the function in the NULL-ACL state.

### The file could not have been applied through the only sanctioned door (BLOCKER, drift review)

The migration opened its own transaction (`BEGIN;` … `COMMIT;`). `scripts/apply-migration-file.mjs`
calls `assertWrappable()` **before** its gate and refuses any such file, because that path wraps the
migration *and* its `schema_migrations` ledger row in one transaction — a self-committing file can
leave the schema changed with no ledger row. So the parked deliverable was, as written, unappliable
by the one route Mason would use. It is also a convention regression: of 904 migrations only 31 carry
top-level transaction control and the newest is from 2026-07; neither of this file's two direct
precedents has any.

Both lines are removed. The three statements still share one transaction — the applier supplies it —
so a failed preflight or postflight still rolls the `CREATE` back, which steps 5 and 7 verify.

**The proof could not have caught this, and that is the same failure recorded above one layer out.**
The harness applied the file with bare `psql -f`, which executes `BEGIN;…COMMIT;` happily. A harness
that does not reproduce the real channel proves nothing about it. It now calls `assertWrappable()` as
step 0b and applies through the wrapped shape the real applier uses.

### Also from this round

- **Owner is pinned, not assumed.** `CREATE OR REPLACE` cannot change a function's owner, and for a
  `SECURITY DEFINER` body the owner *is* the privilege it runs with — so an owner changed out of band
  would have passed every assertion. Both flights now require `postgres`. The header sentence claiming
  the owner was "re-declared exactly as live" was wrong and is corrected.
- **Security pre-state checked in the preflight.** `prosecdef` and `proconfig` were only checked
  *after* the replace, where the file itself had just set them — so a live function silently
  downgraded to `SECURITY INVOKER`, or stripped of its `search_path`, would have been quietly repaired
  with no signal that live had been tampered with. Now it fails loudly instead.
- **The ACL check no longer claims more than it verifies.** Its message says "only
  postgres/service_role may hold it" while it tested only `anon`, `authenticated` and PUBLIC — a grant
  to any *other* role passed. The ACL is now enumerated and any grantee outside that pair is refused;
  proof step 7d grants to a third-party role that `anon` is provably not a member of and watches the
  refusal name it.
- **The positive direction is asserted too.** Every other check is a refusal; none would have noticed
  drift that *removed* `service_role`'s EXECUTE, leaving a function nobody can call.
- **`.gitattributes` LF pin added for the prover**, not just the migration. It embeds the reviewed
  live body as a template literal and installs it verbatim, so a CRLF smudge on a Windows checkout
  would make the live md5 unreproducible. Both peer provers are pinned; this one was not.

**35/35 checks pass.**
- **`.gitattributes` LF pin added** for this file. Every other md5-pinned migration carries one; on a
  Windows checkout with `core.autocrlf=true` an unpinned file is smudged to CRLF, the body PostgreSQL
  receives carries CR bytes, and the candidate hash can never match.

### Before any apply (still outstanding, not blockers for parking)

- `.claude/session-state/applied-migrations.json` is stale (captured 2026-08-27, missing every
  2026-09 apply). The apply guard hard-refuses above 24h — correct — but a *partial* refresh would
  misclassify three already-applied migrations as pending. Refresh it from a live ledger read first.
- The `20260905090000` stamp is correct today (the effective high-water by NAME is
  `20260904180000`), but a parked file's timestamp perishes. Re-derive it immediately before apply
  and treat renumbering as the expected path.

### Not done here, deliberately

Not applied. Autopilot's standing hands-free migration allowance would technically permit a
non-destructive apply; it is not being used. Mason has not been told this defect existed until now,
he applies migrations himself, and the deadline is months out. Parking it **is** the deliverable.

Before any apply: re-run the container proof, confirm the live body still matches the `b53499d0…`
pin (a drifted body must be re-reviewed, and the file will refuse it anyway), and run the DB
invariant sweeps afterwards.
