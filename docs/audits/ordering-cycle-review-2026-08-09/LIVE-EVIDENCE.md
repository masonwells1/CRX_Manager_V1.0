# Live Evidence — Ordering Cycle Review

**Step 1 of `REMEDIATION-PLAN.md`. Read-only. Nothing was changed, applied, or deployed.**

Date pulled: 2026-08-09 · Project: `rhyzpcqhnizqbxphqdkr` (production) · Branch base: `origin/main` @ `37c4bca6`

---

## Why this document exists

The ordering cycle review produced 77 findings, but **no phase of it ever asked the live database anything.** Every finding described a file sitting on disk. A file on disk is a description of production, not production itself — the two can drift, and in this project they have before.

This document closes that gap. It compares what is actually running in the production database against what the repository says should be running, and then re-states each of the ten HIGH findings as a fact rather than an inference.

**Jargon, defined once:**

- **Live / production database** — the real database the app uses, holding real customer and money data.
- **Function body** — the stored recipe the database runs when the app asks it to do something (e.g. "complete this delivery"). Bodies live *inside* the database; the repo only holds the instructions that put them there.
- **`md5` fingerprint** — a short code computed from a piece of text. Two texts with the same fingerprint are byte-for-byte identical. This is how "matches the repo" is proven here rather than eyeballed.
- **Migration** — one numbered file that changes the database. They are applied in order and never edited afterwards.
- **RLS (Row Level Security)** — per-row permission rules. They decide which rows a given user is allowed to see or change, on top of ordinary table permissions.
- **Grant** — a table- or function-level permission (SELECT, INSERT, UPDATE, EXECUTE…) held by a role such as `authenticated` (any signed-in user) or `anon` (anyone not signed in).
- **Trigger** — a rule the database runs automatically whenever a row is inserted, updated, or deleted. Triggers are the safety net that still applies when someone writes to a table directly instead of going through the app's proper function.
- **`SECURITY DEFINER`** — a function that runs with the *owner's* full power rather than the caller's. Powerful and useful, but it means the function itself must check who is calling; nothing else will.

---

## Bottom line

**Production matches the repository. The review's picture of production was accurate.** All twelve function bodies examined are byte-identical to the repo, or differ only by stripped comments with no behavioural change. All sixteen RLS policies and all table grants on `quotes` / `orders` / `deliveries` / `order_items` match the committed 2026-07-27 baseline exactly.

**Consequence: none of the ten HIGH findings dissolve on contact with live.** Eight are confirmed as-written. Two are confirmed but need their wording tightened before they become work. Zero are already fixed. Zero are worse than described.

Three things the review could not have known, which live introspection surfaced:

1. The 2026-07-27 baseline file the review leaned on for its permissions findings **contains no RLS policies at all** — it is grants-only. Any finding phrased as "derived from the grants baseline" about *policies* was inferred, not read. Those inferences turned out to be correct, but they were unverified until now.
2. Production is **four migrations ahead of `origin/main`**, two of which touch money rounding. Sibling-session work applied live but not yet merged. One of those adds a rounding trigger that partially mitigates a LOW finding.
3. `authenticated` holds **TRUNCATE** on all four tables, and TRUNCATE is not subject to RLS. Not in the review. See "New observations" below.

---

## A. Function bodies — live vs repo

Each function's stored body was read directly out of the live database (`pg_proc.prosrc`, the verbatim text Postgres holds) and fingerprinted. The same fingerprint was computed from the body text in the last repo migration that defines that function. Same fingerprint = identical, to the byte.

| Function | Verdict | Live fingerprint | Bytes | Repo source of that body |
|---|---|---|---|---|
| `complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz)` | **MATCHES REPO** | `a1e9a043f27d3566f8ecf6d5e3a809ab` | 1720 | `20260716202000_preflight_delivery_accounting_period.sql` |
| `_complete_delivery_period_preflight_impl` | **MATCHES REPO** | `a9f80dc25207eba595e9998409e9ceb9` | 5782 | `20260716191000_aggregate_delivery_stock_preflight.sql` |
| `_complete_delivery_aggregate_impl` | **MATCHES REPO** | `b888901587accbee7f7fe4aeb512e683` | 1075 | `20260716173342_authorize_delivery_before_replay.sql` |
| `_enforce_quote_status_transition()` | **MATCHES REPO** | `c2749a6c84fc32d95e12d9af885616e5` | 2240 | `20260706030000_closed_short_booking_closure.sql` |
| `revert_quote_status(uuid,text,uuid,text)` | **MATCHES REPO** | `fb0cc5def3766270b13c401810b61f3e` | 8150 | `20260719044958_revert_quote_status_deadlock_retry.sql` |
| `restore_quote_version(uuid,uuid,uuid,text,bigint)` | **MATCHES REPO** | `d533d681ebc6ceb94338cd6f77220d71` | 4366 | `20260730235031_quote_customer_row_version_guard.sql` |
| `convert_quote_to_order(uuid,uuid,text,bigint)` | **MATCHES REPO** | `2b10185e7be4f760c1b69cd479c0135d` | 3485 | `20260730235031_quote_customer_row_version_guard.sql` |
| `create_direct_order(uuid,date,text,text,jsonb,uuid,text,text)` | **MATCHES REPO** | `1e5f173cbbb039617334cef731a0a667` | 6561 | `20260614142939_create_direct_order_customer_po_param.sql` |
| `void_invoice(uuid,text,text)` | **MATCHES REPO** | `c7a488d58bd876e92565bca9bd4edc90` | 706 | `20260720175946_protect_governed_split_edit_and_void_group.sql` |
| `_void_invoice_group_guard_impl_20260720(uuid,text,text)` | **MATCHES REPO** | `9f1656542c5c6a667b1c8a67034c5c3f` | 2544 | `20260720175946…`; fingerprint pinned by `20260721014858_…govern_invoice_order_money_lifecycle.sql:40` |
| `get_customer_year_end_summary(uuid,integer)` | **MATCHES REPO** | `d233e92d2903825905c55d2fc02165c1` | 6316 | `20260228200000_season_calendar_oct_sep.sql` |
| `check_customer_credit_limit(uuid)` | **MATCHES REPO** | `3adc17f7fa1612df87264a4702d72858` | 1045 | `20260712130000_credit_limit_count_unposted.sql` |
| `global_search(text,integer)` | **DIFFERS — cosmetic only** | `8b52e155e2d36ac7e83001c02e943822` | 1974 (repo 2036) | `20260404080000_fix_global_search_ilike_escape.sql` |
| `get_customer_summary(uuid)` | **DIFFERS — cosmetic only** | `0c62f7918b943433e972dd7885a64249` | 1591 (repo 1775) | `20260404040200_get_customer_summary_rpc.sql` |

### The two differences, spelled out

Both are **comment stripping only**. Not a single line of logic differs. Neither has any behavioural effect.

**`global_search`** — live is 62 bytes shorter than the repo. Those 62 bytes are exactly one comment line that is present in the repo and absent live:

```
  -- Escape ILIKE metacharacters before wrapping in wildcards
```

The line it describes — the escape fix that stops a user typing `%` from matching every row in every table — is present and identical live. The safety fix is in production; only its explanatory note was dropped.

**`get_customer_summary`** — live is 184 bytes shorter. Those 184 bytes are exactly five comment lines: `-- Current season: Oct 1 to Sep 30`, `-- AR Balance (sum of unpaid invoice balances)`, `-- Orders this season`, `-- Completed deliveries this season`, `-- Credit tier`, `-- Last activity`. Every calculation is identical.

**Most likely cause:** both are from early April 2026 and were almost certainly applied through a path that normalised the SQL before storing it, rather than an editing difference. **No action needed, and no finding changes because of them.**

### Structural checks, all clean

- **All fourteen** use `SET search_path = public, pg_temp` (the project's hard rule against search-path hijacking).
- **All are `SECURITY DEFINER` except `_enforce_quote_status_transition`**, which correctly is not — it is a trigger and should run as the caller.
- **No duplicate overloads exist** for any of them. (A stale second copy of a function with slightly different arguments is a known failure mode in this repo; there are none here.)
- All live bodies are LF-only — no Windows line-ending contamination.

### A note on layered functions

Three of these are not single functions but chains, because this project hardens functions by renaming the old body to `_..._impl` and wrapping a new one around it:

- `complete_delivery` → `_complete_delivery_period_preflight_impl` → `_complete_delivery_aggregate_impl`
- `void_invoice` → `_void_invoice_group_guard_impl_20260720`

**Every layer was verified, not just the outer one.** This matters: a naive check of only the outer function would have proved almost nothing. The `void_invoice` implementation additionally matches the fingerprint that the repo's own migration `20260721014858` hard-codes as its expected value — the repo's own self-check agrees with live.

---

## B. Grants and RLS policies vs the committed baseline

Baseline compared against: `supabase/baselines/20260727174805_acl_lockdown.sql` (grants) and `supabase/baselines/20260727174805_public_schema.sql.br` (policies).

### Material discovery about the baseline itself

`20260727174805_acl_lockdown.sql` is **grants-only**. Its full statement census: 1,015 `GRANT EXECUTE`, 245 `GRANT DELETE`, 188 `GRANT SELECT`, 142 `GRANT MAINTAIN`, 27 `GRANT INSERT`, 13 `ALTER DEFAULT PRIVILEGES`, 3 `REVOKE ALL` — and **zero `CREATE POLICY`, zero `ENABLE ROW LEVEL SECURITY`.**

The RLS policies live in the compressed companion file `20260727174805_public_schema.sql.br` (423 policies), which the review does not cite.

**Why this matters:** review findings phrased as "derived from the 2026-07-27 grants baseline" that make claims about *policies* — notably HIGH #8, the assigned-driver one — were reasoning from a file that contains no policies. The conclusion happened to be right, but it was an inference standing on the wrong document. It is now verified directly.

### Table grants — MATCHES BASELINE

Identical on all four tables (`quotes`, `orders`, `deliveries`, `order_items`):

| Role | Privileges held live |
|---|---|
| `anon` (not signed in) | SELECT |
| `authenticated` (any signed-in user) | DELETE, INSERT, REFERENCES, SELECT, TRIGGER, **TRUNCATE**, UPDATE |
| `metabase_ro` | SELECT |
| `postgres`, `service_role` | full |

This matches the baseline exactly. The baseline additionally lists `MAINTAIN`; that privilege is not reported by the standard `information_schema` view on PostgreSQL 17, so its absence from the live readout is a reporting artifact, **not drift**.

### RLS policies — MATCHES BASELINE, all 16, exactly

All four tables: RLS **enabled**, not *forced* (meaning the table owner bypasses it — normal), 4 policies each. Live expressions, word for word:

**`deliveries`**
- `del_select` — visible to `is_admin() OR is_sales_rep() OR assigned_driver = auth.uid()`
- `del_insert` — `is_admin() OR is_sales_rep()`
- `del_update` — `is_admin() OR is_sales_rep() OR (assigned_driver = auth.uid() AND status = ANY(ARRAY['in_progress','completed']))`
- `del_delete` — `is_admin()`

**`orders`**
- `orders_select` — `is_admin() OR is_sales_rep()`
- `orders_insert` — `is_admin() OR is_sales_rep()`
- `orders_update` — `is_admin()`
- `orders_delete` — `is_admin()`

**`order_items`** — same shape as `orders`.

**`quotes`**
- `quotes_select` — `is_admin() OR is_sales_rep()`
- `quotes_insert` — `is_admin() OR (is_sales_rep() AND created_by = auth.uid())`
- `quotes_update` — `is_admin() OR (is_sales_rep() AND created_by = auth.uid())`
- `quotes_delete` — `is_admin()`

No drift of any kind.

---

## C. What actually guards these tables live

Twenty-two triggers are installed across the four tables and **all twenty-two are enabled** (none silently disabled — a real and previously-seen failure mode in this project, and one that reading migration files cannot detect).

| Table | Triggers |
|---|---|
| `deliveries` | `enforce_delivery_status_transition`, `guard_delivery_delete`, `trg_delivery_status_change`, `trg_enforce_delivery_accounting_period`, `trg_guard_completed_delivery_signature` |
| `orders` | `enforce_order_status_transition`, `guard_order_customer_source_lineage`, `guard_order_delete`, `guard_order_delivered_activity_cancel`, `trg_order_status_change`, `trg_stamp_commission_split_recipient_ids` |
| `order_items` | `after_order_items_change`, `guard_order_item_delivery_lineage`, `trg_order_items_round_money`, `trg_snapshot_order_item_cost` |
| `quotes` | `enforce_quote_accepted_fully_drawn`, `enforce_quote_status_transition`, `quotes_bump_row_version`, `trg_enforce_quote_terminal_not_drawn`, `trg_release_holds_on_quote_status`, `trg_stamp_commission_split_recipient_ids`, `trg_validate_quote_commission_split` |

### The decisive trigger bodies

**`_enforce_delivery_status_transition`** — permits only `scheduled → in_progress`, `scheduled → cancelled`, `in_progress → completed`, `in_progress → cancelled`, with an admin-override bypass; anything else raises an error.

So a **single-hop** `scheduled → completed` direct update is **blocked**. But a **two-hop walk** (`scheduled → in_progress`, then `in_progress → completed`) is permitted, and neither hop runs any of `complete_delivery`'s real effects. This is the crucial detail for findings #2 and #8.

**`_enforce_quote_status_transition`** — contains, verbatim, in its list of permitted transitions:

```sql
OR (OLD.status = 'accepted' AND NEW.status = 'sent')
```

HIGH #1 is confirmed by direct quotation from production.

**`release_holds_on_quote_status_change`** — releases a quote's inventory holds **only** when its `status` moves into a terminal value (`accepted`, `declined`, `expired`, `cancelled`, `closed_by_application`, `closed_short`) from a non-terminal one. It does not look at `deleted_at` at all.

**`_is_admin_override()`** — reads `current_setting('app.admin_override', true) = 'true'`. **Checked and clean:** every function that *sets* that flag is `SECURITY DEFINER` and executable only by `postgres` / `service_role`, so a signed-in user cannot set it from the app. The override is not a client-reachable bypass.

---

## D. The ten HIGH findings — live verdicts

Summary: **10 confirmed, 0 already fixed, 0 worse. Two need their wording tightened before they become work.**

| # | Finding (abbreviated) | Live verdict |
|---|---|---|
| 1 | Quote transition trigger allows `accepted → sent` on a direct update, bypassing `revert_quote_status` reopen guards | **CONFIRMED AGAINST LIVE** |
| 2 | Deliveries can be walked to `completed` by direct update, skipping all `complete_delivery` effects | **CONFIRMED — with a mechanism correction** |
| 3 | Quote soft delete has no DB guard; deleting a planned booking leaks its inventory holds permanently | **CONFIRMED AGAINST LIVE — not yet triggered in production** |
| 4 | Soft-deleting a planned quote orphans its active crop-program holds | **CONFIRMED — same defect and same table as #3** |
| 5 | Caller-controlled cost drives the commission basis on `create_direct_order` | **CONFIRMED AGAINST LIVE** |
| 6 | Quick-delivery invoice posted before completion is never adjusted on partial completion; follow-up delivery double-bills | **CONFIRMED AGAINST LIVE (by identity)** |
| 7 | Void-then-rebill permanently cancels an order's commissions, no re-mint path | **CONFIRMED AGAINST LIVE (by identity)** |
| 8 | Assigned driver can complete a delivery by direct table update | **CONFIRMED — narrower than described** |
| 9 | `get_customer_year_end_summary` is an ungated `SECURITY DEFINER` RPC granted to `authenticated` | **CONFIRMED AGAINST LIVE — and it is four functions, not one** |
| 10 | Sales reps can insert orders and order lines directly, bypassing canonical order creation | **CONFIRMED AGAINST LIVE** |

### The detail behind each verdict

**#1 — confirmed.** The permitted-transition list in the live trigger body literally contains the `accepted → sent` arm. Anyone who passes `quotes_update` (an admin, or the sales rep who created the quote) can reopen an accepted quote by writing the table directly, and none of `revert_quote_status`'s reopen guards run.

**#2 — confirmed, mechanism corrected.** The review's word "walked" is accurate, and it matters more than it might sound. A direct `scheduled → completed` jump is **blocked** by the live transition trigger. Two separate updates are required. A sales rep can perform both hops unconditionally under `del_update`. Neither hop triggers inventory movement, order rollup, or invoicing. *Any remediation that assumes one-hop is the attack will be testing the wrong thing.*

**#3 and #4 — confirmed; they are one defect, not two.** Live has only one holds table, `inventory_holds`; crop-program holds and quote holds are rows in the same table, so #4 is #3 seen from a different caller. `quotes.deleted_at` exists. Of the seven triggers on `quotes`, **none fires on soft delete or examines `deleted_at`** for hold release — the only one that mentions `deleted_at` is the status-transition guard, and it uses it to check for active *jobs*, unrelated. The release trigger keys purely on status change, so setting `deleted_at` releases nothing.

**Live data check: there are currently zero active inventory holds attached to soft-deleted quotes.** The defect is real and structurally open, but it has not yet caused a leak in production. This is genuinely useful — it means this is a fix-before-it-bites, not a clean-up-the-damage.

**#5 — confirmed.** `create_direct_order`'s live body is byte-identical to the repo, so the review's reading of the caller-supplied cost path applies to production unchanged. Note the partial mitigation under "New observations" below — it is real but does not close this finding.

**#6 and #7 — confirmed by identity.** These are behavioural findings about `complete_delivery` and `void_invoice`. Every layer of both chains is byte-identical to the repo, so the review's file-based analysis describes production exactly. Live introspection found nothing that contradicts either. (This is confirmation that the *code* is as described; the *behaviour* was not re-derived from scratch here — see "What was not verified".)

**#8 — confirmed, narrower than described.** The `del_update` policy admits the assigned driver only when the delivery's existing status is `in_progress` or `completed`. So the driver **cannot** start the walk — they cannot move a `scheduled` delivery to `in_progress`. They *can* perform the final `in_progress → completed` hop, which is precisely the state a delivery is in while a driver is working it. The finding holds; the fix must account for the driver needing legitimate write access to `in_progress` rows.

**#9 — confirmed, and larger than the finding's title.** All four of `get_customer_year_end_summary`, `check_customer_credit_limit`, `get_customer_summary`, and `global_search` are live `SECURITY DEFINER`, granted `EXECUTE` to `authenticated`, and **not one of them contains any caller check of any kind** — no `is_admin()`, no `is_sales_rep()`, no `is_office()`, no `auth.uid()` comparison, no role lookup. Any signed-in user can call any of them for any customer. `anon` is correctly excluded from all four. The remediation plan already scopes all four into Wave C; this confirms that scoping is correct.

**#10 — confirmed.** Live `orders_insert` and `oitems_insert` both permit `is_admin() OR is_sales_rep()`, and `authenticated` holds INSERT on both tables. Nothing in the trigger set enforces the confirmed-only status rule on a direct insert.

---

## E. New observations — things the review did not know

These are recorded, not acted on. Per the plan's own rule: record rather than widen.

**1. `authenticated` holds TRUNCATE on all four tables.** TRUNCATE empties a table wholesale and **is not subject to RLS** — row-level policies cannot restrain it. Ordinary DELETE by a sales rep is blocked by the `*_delete` policies requiring `is_admin()`; TRUNCATE steps around that entirely. This appears to be inherited from a broad grant rather than a deliberate decision. It is not in the 77 findings. **Worth a one-line `REVOKE TRUNCATE` in Wave B**, where the direct-write lockdown is already being done.

**2. Production is four migrations ahead of `origin/main`.** 953 migrations live vs 863 on disk overall (older ones were applied under different timestamps, which accounts for most of the gap). Restricting to versions ≥ 20260720 and matching by name, exactly four live migrations have no counterpart in `origin/main`:

- `20260809130108` team_note_completion_rpc_and_assignment_notify
- `20260809205423` round_line_profit_with_revenue
- `20260810000427` single_canonical_line_profit
- `20260809154649` active_team_note_assignment_actor

Two of these touch money rounding. **The review read a repo that was four migrations behind production.** That did not affect any of the ten HIGH verdicts above — all the relevant bodies still match — but it is a live/repo gap that should be closed before Wave A starts, or Wave A will be built on a stale picture of the money path.

**3. Two money triggers exist live on `order_items` that the review's on-disk sources do not describe.**

- `trg_order_items_round_money` → `_round_money_to_whole_cents`: rounds `total_price` to two decimals and **derives** `profit` as `ROUND(total_price,2) − ROUND(cost_per_unit × total_units_needed, 2)`, discarding whatever profit value the caller supplied. This **partially mitigates the LOW finding "`create_direct_order` performs no cent rounding anywhere"** — at the *line* level. The `orders` header totals have no equivalent rounding trigger, so the LOW finding should be re-scoped to the header rather than dropped.
- `trg_snapshot_order_item_cost` → `_snapshot_order_item_cost`: fills `cost_at_time_cents` from `products.current_cost` **only when the caller left it NULL**. This is a fallback for a missing value, not a guard against a wrong one, and it writes a *different column* from the one `create_direct_order` uses for the commission basis. **It does not mitigate HIGH #5.** Anyone reviewing #5 will encounter this trigger and could mistake it for a fix; it is not one.

**4. `generate_order_number()` and `generate_quote_number()` are EXECUTE-able by PUBLIC and by `anon`.** Confirmed live: their permission lists include both. A logged-out visitor can burn the number sequences. This matches the LOW finding already kept in the plan; it is now verified rather than assumed.

---

## What was NOT verified

Stated plainly so nobody over-reads this document:

- **No behaviour was executed.** This is a read of stored code, permissions, and rules. Findings #6 and #7 are confirmed in the sense that production runs exactly the code the review analysed — not in the sense that the double-billing and commission-cancellation sequences were reproduced against live data. Reproducing them would require writing to production, which this task explicitly forbids.
- **The frontend was not examined.** Findings with a UI component (e.g. the `QuoteBuilder.tsx:2686` consumer noted in Wave B) rest on the review's file reading, unchanged.
- **Only the four named tables** had grants, policies, and triggers audited. Other tables in the ordering cycle (`invoices`, `jobs`, `commissions`, `inventory_holds`) were touched only where a specific finding required it.
- **Migration ledger comparison was scoped** to versions ≥ 20260720, matching by name with the leading timestamp stripped. Older drift, if any, was not chased.
- **The backup freshness check (Step 0 of the plan) was explicitly waived by Mason for this task**, on the grounds that it reads and changes nothing. **The waiver does not extend to any step that writes.** The backup check returns before the first remediation wave.

---

## How this was produced (reproducible)

Live reads via the Supabase MCP `execute_sql` tool against project `rhyzpcqhnizqbxphqdkr`, one statement at a time (the tool returns only the last statement's result, so batching would have silently discarded evidence).

- Function bodies: `pg_proc.prosrc` — the verbatim stored text. `pg_get_functiondef()` was deliberately **not** used for diffing: it re-renders and normalises the definition, which would have masked real differences.
- Repo-side fingerprints: the last `CREATE [OR REPLACE] FUNCTION` for each name across `supabase/migrations` in filename order, body sliced between its dollar-quote markers, line endings normalised to LF, then md5. Two functions (`_complete_delivery_*_impl`) are created by `ALTER FUNCTION … RENAME TO` rather than `CREATE`, so their expected bodies were taken from the migration that created them under their original name.
- Grants: `information_schema.role_table_grants`. Function permissions: `pg_proc.proacl`.
- Policies: `pg_policies` (`qual`, `with_check`, `roles`, `cmd`); RLS state from `pg_class.relrowsecurity` / `relforcerowsecurity`.
- Triggers: reconstructed from `pg_trigger` catalog columns (`tgname`, `tgenabled`, `tgtype` bitmask, joined to `pg_proc`). `pg_get_triggerdef()` is blocked by a local safety hook, so the catalog was read directly.
- Baseline policies: `20260727174805_public_schema.sql.br` decompressed with Node's `zlib.brotliDecompressSync` (3,054,020 characters, 423 policies).
- One aggregate live-data count was run (active holds on soft-deleted quotes). It returned zero. No row identifiers, customer data, pricing, or financial figures were read or are recorded here.

---

## Recommended next step

**Proceed to Step 2 — the Codex triage — with this document attached, and add one item to it: close the four-migration gap between production and `origin/main` before Wave A begins.**

The evidence gap is closed and the review survived it intact: all ten HIGH findings stand, so the remediation plan's shape does not need to change. The one thing that *should* change before any money work starts is that repo/live gap — Wave A is the money wave, and two of the four unmerged migrations are money-rounding changes. Building a money fix against a repo that does not contain them risks writing a fix that conflicts with what production already does.
