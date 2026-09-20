## 2026-09-20 — merge PR #739, scope the field-invoice cutover claim to `save_invoice`, and track CRX-LIFE-001

Third merge of current main into the field-invoice filed-season candidate, plus the two changes
Mason approved on 2026-09-20 after being briefed on the Codex blocker: narrow what this PR claims
to close, and file the order-pipeline bypass as a tracked known issue instead of fixing it here.

No migration byte changed in this commit. All four guard migrations remain LOCAL CANDIDATES —
NOT APPLIED — and their canonical LF SHA-256 pins are unchanged.

### Merge reconciliation with `origin/main` (`17826e9c3`, PR #739)

`docs/reference/migration-history.md` was the only conflict, and only in its header count. Main
took row **930** for `20260911120000_bind_adjust_inventory_receipt_to_intent`, which collided with
this branch's first candidate row. The four candidates were renumbered **930-933 → 931-934** and the
header moved to `latest entry 934`. Resolution is purely additive over main; no main row was
rewritten, and no row number is now duplicated.

### The ordering boundary moved, and one candidate is now below it

PR #739 applied `20260911120000` to production on 2026-09-20 (ledger version `20260920052149`,
1004 rows). That is a **new effective ordering high-water**, and
`20260908190000_field_app_invoice_cross_season_edit_guard` sorts **below** it.

Two documents asserted the old boundary and had to be corrected, because after the merge they
contradicted main's own body text and would have told a later session the wrong high-water — the
same failure mode that stranded the seven `20260905*` candidates:

- `docs/reference/migration-history.md` — the top block still said "Live-ledger capture 2026-09-17.
  THIS IS THE CURRENT BOUNDARY" with high-water `20260908130000`. Main merged the 2026-09-20 apply
  record without moving that block. It now states the September 20 boundary, explicitly attributed
  to PR #739's apply record rather than to a live read by this branch, with the September 17
  capture demoted to a superseded block that still explains why registry-derived tooling continues
  to compute `20260908130000`.
- `docs/manual/CURRENT_STATE.md` — its top paragraph named `20260908130000` and claimed all four
  guard migrations are stamped above it and need no restamp. Main's own line 58 already said
  `20260911120000` "now holds the boundary", so the merged file disagreed with itself. Corrected,
  including the false "all four" claim.

**`20260908190000` is deliberately NOT restamped**, for three reasons recorded in full at the top
of `migration-history.md`:

1. The two migrations share **no database object**. `20260908190000` replaces
   `preview_field_app_invoice_split`, `_assert_field_app_invoice_date_in_filed_season` and
   `guard_field_app_invoice_season_date`; `20260911120000` replaces `adjust_inventory` and its
   receipt trigger. Neither ordering yields a different end state, including in a from-zero rebuild.
   Verified by listing the `CREATE`/`ALTER`/`DROP` targets of both files — the sets are disjoint.
2. Register-not-restamp is this repository's settled precedent. `20260911120000` was itself a
   candidate below the then-high-water and was registered and applied rather than restamped, as
   were `20260908120000` and `20260914100800`.
3. A restamp changes production apply order — Mason's decision, not this PR's — and would
   invalidate the file's canonical LF SHA-256 pin, forcing another repin round.

**Observed proof that real apply order does not depend on the stamp.** `checkPendingMigrations`
re-run against this merged tree: `20260908190000` **REFUSES** while `20260908140000` is pending;
`20260912165758` **REFUSES** naming three older pending migrations; `20260913040359` **REFUSES**
naming four. The guard admits a candidate only when every older tracked-and-unapplied migration is
gone, and an applied migration is by definition no longer in that set — so sorting below an
*applied* stamp is inert. The guard currently still counts `20260911120000` as pending because it
reads applied names from the un-refreshed registry; that errs in the safe direction.

### Scope narrowing (Mason's 2026-09-20 decision)

The two cutover phases close `public.save_invoice(jsonb,jsonb,text)` and nothing else — both pin,
fence and replace that one function by name and OID. The filenames
`refuse_generic_field_invoice_creation` and `finish_generic_field_invoice_cutover` read broader than
what the SQL does. A scope note now sits in both `docs/reference/migration-history.md` and
`docs/manual/KNOWN_ISSUES.md` stating plainly that "generic field-invoice creation is refused" is
true of `save_invoice` and **not** of the database as a whole, and naming the path that stays open.

### CRX-LIFE-001 filed as a tracked known issue, NOT fixed here

An exact-head `gpt-5.6-sol`/high review found that `create_invoice_from_order` and
`create_split_invoices_from_order` accept a caller-supplied `p_invoice_type text DEFAULT
'chemical_sale'` and insert it unchanged, with no allow-list. Both keep `GRANT EXECUTE` to
`authenticated` and admit admins and sales reps, so a sales rep can pass
`p_invoice_type => 'field_application'` and create an order-backed field-application invoice with
no field, grower-share, job, blend-ticket or season workflow behind it.
`20260620210000_field_app_invoice_type_lock_trigger` misses it — that trigger fires only on
`UPDATE`, never on `INSERT`.

Every claim above was checked against the migration sources before filing, not taken on the
reviewer's word: `20260721145936:108,122`, `20260827041400:157,426`, `20260719044912:382`.

**It is pre-existing on `main` and is not a regression from this PR** — none of the three
implicated migrations is touched here. Closing it means a new migration on the AR money path plus
an INSERT-side provenance check, which belongs in its own reviewed change with its own container
proof. Mason was briefed on 2026-09-20 with both options and chose to ship the scoped season
closure now and document the gap, rather than hold the September 30 season deadline for an
unrelated AR fix. Recorded in `docs/manual/KNOWN_ISSUES.md` with the fix shape and the note that
live exposure has not been measured.

### Still awaiting Mason, unchanged by this commit

The Codex MEDIUM on whether to restamp `20260913152700` ahead of the cutover phases is still open.
It changes production apply order, so it is his call, and it is deliberately not decided here.

Repository merge does not apply any migration or authorize a live SQL or data change.
