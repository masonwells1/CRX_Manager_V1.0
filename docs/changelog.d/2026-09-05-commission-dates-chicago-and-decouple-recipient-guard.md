## 2026-09-05 - Commission dates follow the source document's business date; recipient guard decoupled

Findings 4, 7 and 9 from the exact-SHA `gpt-5.6-sol` review of `554934e7a`. Neither migration is
applied; both still require Mason's explicit in-chat approval before any live apply.

> **READ THIS FIRST — the September 30 fix is TWO migrations, and both are needed.**
> `20260905020400` alone does **not** close the risk. Adversarial review
> (migration-drift-reviewer, BLOCKER B1) caught that the "document date" it derives from is
> *itself* stamped from the UTC clock on four of the five broken paths, **confirmed against live
> `pg_proc.prosrc` on 2026-09-05**. `20260905020500` (below) converts those four writers, and the
> pair closes it. Apply order is not critical — they touch disjoint functions — but **neither
> should be recorded as closing September 30 without the other.**
>
> | path | what it writes as the document date | still broken? |
> |---|---|---|
> | quote drawn down into an order | `order_date = current_date` (UTC) | fixed by `020500` (2 values) |
> | quick delivery | `order_date` AND `invoice_date` = `CURRENT_DATE` | fixed by `020500` (3 values) |
> | job transferred to an invoice | `invoice_date`, its due date AND its season | fixed by `020500` (12 values) |
> | quote converted to an order | `order_date = current_date` (UTC) | fixed by `020500` (2 values) |
> | field-application split invoice | Chicago, fixed by `20260904160000` | already correct |
>
> So `020400` is **necessary but not sufficient**: it makes the commission follow its document,
> which is the correct semantics and without which fixing the writers would still leave commissions
> free to drift from their documents. `020500` supplies the other half.
>
> **A larger finding surfaced by the same check, and it is not only about commissions:**
> `transfer_job_to_invoice` stamped `invoice_date = CURRENT_DATE`. `20260904160000` converted four
> invoice-dating functions to Chicago and this was not one of them, so on a Chicago evening a
> field-application invoice was dated tomorrow — moving its **season, due date and aging**. It also
> derived the invoice's season from that same UTC clock, on two separate insert paths. `020500`
> fixes all of it.

## New: `20260905020400_commission_dates_follow_chicago_business_day.sql`

The database clock is UTC; the business day is America/Chicago. After ~7pm Chicago the server's
`CURRENT_DATE` is already tomorrow. `20260904160000` converted `invoice_date` for this reason and
`20260904180000` made the season follow it — but the commission side was never converted, so the two
disagreed. An invoice raised at 8pm Chicago on September 30 is dated 2026-09-30 while its commission
was stamped 2026-10-01, which (a) dropped it out of September 30 commission history, (b) caused a
September 30 payout to be refused by `COMMISSION_SETTLEMENT_PAYMENT_DATE_BEFORE_ORDER`, and (c) put
it in the wrong crop season, since the season rolls at October 1.

**The defect was enumerated from the live catalog, not the migration files** — the files do not
reflect later replacements. Eight call sites feed the two commission-creating helpers. Three pass the
source document's own date and were already correct; five pass the server's UTC `CURRENT_DATE`:
`_convert_quote_to_order_owner_impl`, `_draw_down_quote_below_cost_impl_20260810`,
`_create_quick_delivery_intent_impl_20260802`, `_save_field_app_split_invoice_impl`, and
`transfer_job_to_invoice` (two sites; a third occurrence of the helper name there is a comment).

Seen together, the five are not a timezone bug so much as passing *when the code ran* in place of
*what the document is dated*. So the fix went to the point of insertion rather than to five large
callers: `_insert_commissions_for_order` now derives the date from `orders.order_date`, and
`_insert_commissions_for_job` from `invoices.invoice_date` (already Chicago-correct since
`20260904160000`). For the three correct callers this is a no-op — the derived value equals what they
pass. Any future careless caller is corrected too, which a per-caller fix would not achieve. The
caller's value is retained as a fallback, with a final Chicago fallback so the NOT NULL column and
`COMMISSION_HISTORY_ORDER_DATE_REQUIRED` can never be tripped by this path.

Also moved off UTC: both parameter defaults, and the `public.orders.order_date` column default —
otherwise `_price_order_below_cost_impl_20260810` reads a UTC date back out and re-opens the defect
through deferred pricing. Finding 9's `COALESCE(p_payment_date, CURRENT_DATE)` residual in
`_create_commission_payment_intent_impl_20260809` is **not** in this migration; see below.

Not destructive: no row deleted, no column dropped, **no existing commission re-dated**. Only future
derivation changes. Both helper bodies are pinned by md5 read read-only from production on
2026-09-05, so the migration aborts rather than replacing a body it never inspected. Preflight also
refuses on an unexpected overload, a SECURITY DEFINER promotion, a changed search_path or a changed
owner; postflight re-asserts all of that plus the absence of the caller-supplied date from the INSERT.

**Why the two helpers were re-emitted in full rather than patched:** the five broken callers total
~219,000 bytes and one is stored with CRLF line endings. A first attempt read each function's own
definition from the catalog and rewrote only the matched argument; the repository's SQL-safety guard
rejects `pg_get_functiondef()` for cloning or modifying functions, and that rule is right — the
helpers are ~2.3KB each, so re-emitting them explicitly is both smaller and reviewable.

## Changed: `20260905020200_refuse_stale_commission_payment_recipient.sql` (finding 7)

The recipient money-safety guard pinned exactly one md5 for `record_commission_earned_state()` — the
body produced by `20260905020100`, a **cosmetic** label repair that refuses to run once any
settlement activity exists. One real settlement before rollout and `020100` aborts; the name-ordered
runner never reaches `020200`, and the stale-recipient guard silently never installs. Skipping
`020100` was no escape, because the pin demanded the body only `020100` produces.

Now accepts both legitimate bodies via an `IN` list — the same shape this file already used for the
settlement recorder. Verified against live on 2026-09-05: with this change every preflight pin in
`020200` matches production today (`record_commission_earned_state` `dc0577e8…`,
`record_commission_settlement_event` `feb0f260…`,
`prevent_commission_history_ledger_mutation` `f31a41a2…`,
`prevent_commission_history_ledger_truncate` `add7928a…`), so the file is independently appliable in
whichever order the two land.

## Registry false positive, recorded not buried

Editing `020200` tripped the SQL-safety rule claiming `commission_earned_state_ledger_id_seq` and
`commission_settlement_events_id_seq` "do not exist live". Both **do** exist (`pg_class.relkind='S'`,
verified read-only 2026-09-05); they were created by the applied
`20260903150100_ledger_backed_commission_history`. `.claude/schema-registry.json` carries no entry
for either, so the rule is a false positive. A scoped `-- sql-safety: exempt-registry` comment with
that evidence was added to the file. **The stale registry is a real, separate defect** — the
registry's sequence list predates an applied migration — and is deliberately not fixed here, because
refreshing a shared guard input mid-landing would widen a money PR. It needs its own change.

## New: `20260905020500_document_dates_follow_chicago_business_day.sql`

The other half. Four writers stamp the source document itself from the UTC clock; this converts
19 `CURRENT_DATE` values across them to `(now() AT TIME ZONE 'America/Chicago')::date`:

| function | values | what it dates |
|---|---|---|
| `_convert_quote_to_order_owner_impl` | 2 | `orders.order_date`, then the commission call |
| `_draw_down_quote_below_cost_impl_20260810` | 2 | `orders.order_date`, then the commission call |
| `_create_quick_delivery_intent_impl_20260802` | 3 | `orders.order_date`, `invoices.invoice_date`, the commission call |
| `transfer_job_to_invoice` | 12 | `invoices.invoice_date`, its DUE DATE and its SEASON, on two insert paths |

**Not transcribed.** Each body was copied byte-for-byte out of the migration that installed the
version now live (`20260812115236`, `20260816120000`, `20260706130000`, `20260713060000`) and
verified by md5 against production before conversion. Only non-comment `CURRENT_DATE` tokens were
replaced; comment prose was left alone, and the postflight strips comment tails before counting so
neither can hide behind the other. The quick-delivery body appears in the repo under its **original**
name `create_quick_delivery` — `20260803010917` installed the live copy with
`ALTER FUNCTION … RENAME TO`, changing the name and not the body — and is re-emitted under the live
name. An earlier attempt to locate these bodies reported two of the four as drifted from live; that
was CRLF in the checkout, not drift, and is why every hash here is computed on LF-normalised text.

Fail-closed preflight accepts two md5s per writer (pre- and post-image, so a re-run is safe rather
than aborting on its own output) and refuses an unexpected overload or a changed owner. Postflight
requires **zero** `CURRENT_DATE` evaluations in code plus at least the claimed Chicago conversions.

Proof — `scripts/smoke/prove-document-dates-chicago.mjs`, disposable network-isolated PostgreSQL 17,
baseline plus 58 replayed migrations, **all phases passed**: clean-rebuild bodies accepted (a
disaster-recovery rebuild is not refused); the defect reproduced with code `CURRENT_DATE` counts of
2/2/3/12 exactly matching the file's own claims; drift refusal changing nothing; the apply leaving
**zero** code `CURRENT_DATE` in all four with 2/2/3/12 Chicago conversions installed; replay safety;
and a mutation reverting ONE conversion aborting in `POSTFLIGHT_UTC_RESIDUAL` with nothing installed.

**Scope limit, stated rather than implied:** this proves the conversion — which bodies are replaced,
that the replacement is byte-faithful apart from the date expression, and that no UTC date
evaluation survives. It does not drive a quote, delivery or job end-to-end. The behavioural half —
a Chicago business date actually reaching a commission while the session clock disagrees — is proven
for the commission helpers by `prove-commission-dates-chicago.mjs`.

**Not converted, deliberately:** `_create_quick_delivery_intent_impl_20260802`'s
`p_scheduled_date date DEFAULT CURRENT_DATE` parameter default. That is a delivery scheduling date,
not a document date, and it is outside this change's scope — but it is the same class of defect and
should be tracked.

## Still open on this branch

Findings 5 and 6 remain unfixed by owner's decision: `20260905020000` pins only its wrapper RPC, not
the two financial functions it calls, and omits five resettable function attributes. Both must be
closed before that migration is ever approved to apply.
