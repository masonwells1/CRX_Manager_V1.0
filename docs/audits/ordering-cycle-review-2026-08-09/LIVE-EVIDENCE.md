# Live Evidence — Ordering Cycle Review

**Step 1 of `REMEDIATION-PLAN.md`. Read-only. Nothing was changed, applied, or deployed.**

Date pulled: 2026-08-09 · Corrected and extended: 2026-08-10 · Project: `rhyzpcqhnizqbxphqdkr` (production) · Branch base: `origin/main` @ `37c4bca6`

> **Correction pass, 2026-08-10.** Review feedback on PR #362 challenged two claims in the first draft. Both challenges were right. The `_is_admin_override()` safety claim was **false as stated** and has been rewritten with the actual reason (§C). Findings #6 and #7 were labelled live-confirmed on the strength of chains that do not contain the code those findings run through; the missing fifteen functions have now been fingerprinted against production (§D). Three further errors — a miscount, a wrong migration list, and an unverified `MAINTAIN` claim — were found and fixed in the same pass. A second round raised a `search_path` disagreement between the repo and production; chasing it produced a **wrong** finding, which a third round caught and which is now **retracted in place** (§A) — there is no drift. The third round also added a fifth ungated year-end RPC to finding #9 (§D), and showed that the admin-override rewrite from round one was *itself* still incomplete — it enumerated callers, and missed a second setter syntax and every wrapper reaching a setter indirectly. §C no longer rests on that enumeration; it now rests on a property that holds for all 26 setters at once. A fourth round challenged two more things, and both were right again: the §C conclusion proved only that the override cannot leak *across* transactions, not that a client cannot reach a bypass *within* one — it is now stated at that narrower width, with `restore_quote_version` named as the case where it matters; and the *private* implementation behind `convert_quote_to_order` had never been fingerprinted, which on inspection did not match production. Chasing that found no drift but something more useful: **production changed underneath this audit**, from a concurrent session's migration that is applied live and not merged. Two rows of §A's table have been re-anchored to it, finding #5 has been re-read against the new body (it still stands), and the whole document now carries an explicit as-of date. **No verdict changed. Every correction is marked in place rather than silently overwritten.**

---

## Why this document exists

The ordering cycle review produced 77 findings, but **no phase of it ever asked the live database anything.** Every finding described a file sitting on disk. A file on disk is a description of production, not production itself — the two can drift, and in this project they have before.

This document closes that gap. It compares what is actually running in the production database against what the repository says should be running, and then re-states each of the ten HIGH findings as a fact rather than an inference.

**Jargon, defined once:**

- **Live / production database** — the real database the app uses, holding real customer and money data.
- **Function body** — the stored recipe the database runs when the app asks it to do something (e.g. "complete this delivery"). Bodies live *inside* the database; the repo only holds the instructions that put them there.
- **`md5` fingerprint** — a short code computed from a piece of text. Change the text by one character and the code changes completely, so it is how "matches the repo" is checked here rather than eyeballed. Two precise caveats, both raised by an automated reviewer and both fair: matching fingerprints mean the two texts are *almost certainly* identical, not provably so — `md5` is a hash, and two different texts can in principle collide — and the comparison here is made **after** the line-ending normalisation described in "A note on line endings" below. Every match reported in this document also has the two lengths agreeing, which a collision would have to reproduce as well. Read a match as "identical to a certainty no manual diff would improve on", not as a mathematical proof.
- **Line ending (`LF` / `CRLF`)** — the invisible character(s) that end each line of text. Windows editors write two (`CRLF`); everything else writes one (`LF`). They change the bytes of a file without changing a single instruction in it.
- **Migration** — one numbered file that changes the database. They are applied in order and never edited afterward.
- **RLS (Row Level Security)** — per-row permission rules. They decide which rows a given user is allowed to see or change, on top of ordinary table permissions.
- **Grant** — a table- or function-level permission (SELECT, INSERT, UPDATE, EXECUTE…) held by a role such as `authenticated` (any signed-in user) or `anon` (anyone not signed in).
- **Trigger** — a rule the database runs automatically whenever a row is inserted, updated, or deleted. Triggers are the safety net that still applies when someone writes to a table directly instead of going through the app's proper function.
- **`SECURITY DEFINER`** — a function that runs with the *owner's* full power rather than the caller's. Powerful and useful, but it means the function itself must check who is calling; nothing else will.

---

## Bottom line

**Production matches its source. The review's picture of production was accurate.** Every function body in the core table survey is identical to the migration that defines it, or differs only by stripped comments or line endings — in no case by a single instruction. A further fifteen function bodies making up the full `complete_delivery`, `post_invoice`, `create_invoice_from_order` and `void_invoice` chains were checked the same way and also match. All sixteen RLS policies and all table grants on `quotes` / `orders` / `deliveries` / `order_items` match the committed 2026-07-27 baseline exactly.

**No unexplained repo/live disagreement survived checking.** Two were investigated and both dissolved. A `search_path` mismatch on `get_customer_year_end_summary` was reported in an earlier revision and has been **withdrawn** — a bulk hardening migration accounts for it, and replaying the committed migrations reproduces production exactly. A 1,257-byte gap in `_convert_quote_to_order_owner_impl`, found while checking a reviewer's challenge, turned out to be a migration applied to production on 2026-08-10 by a concurrent session and **not yet merged to `origin/main`**; production matches that migration byte-for-byte. Both are in §A.

**One caveat applies to everything below.** Production is running four migrations that are not in `origin/main`, and two of them landed *during* this audit — one of which rewrote function bodies this document fingerprints. Nothing here is wrong because of that, but nothing here is permanent either: **these are measurements of production as of 2026-08-10, and any remediation wave must re-take its own baseline immediately before it writes.**

**Consequence: none of the ten HIGH findings dissolve on contact with live.** Eight are confirmed as-written. Two are confirmed but need their wording tightened before they become work. Zero are already fixed. Zero are less serious than described — and **one, #9, is broader**: it names one function, and live introspection found **five** ungated `SECURITY DEFINER` RPCs of the same shape, including a batch endpoint that loops over an arbitrary array of customer IDs. Wave C's scope has to widen by one function. Details in §D.

Three things the review could not have known, which live introspection surfaced:

1. The 2026-07-27 baseline file the review leaned on for its permissions findings **contains no RLS policies at all** — it is grants-only. Any finding phrased as "derived from the grants baseline" about *policies* was inferred, not read. Those inferences turned out to be correct, but they were unverified until now.
2. Production is **four migrations ahead of `origin/main`**, from three concurrent sessions. One repaired stored profit figures on live money rows; another **rewrote two of the function bodies this document fingerprints**, while the audit was being written. See §A "Live moved during the audit" and "New observations" below. The practical consequence: every verdict here is a measurement of production *as of 2026-08-10*, and any remediation wave must re-take its own baseline immediately before it writes.
3. `authenticated` holds **TRUNCATE** on all four tables, and TRUNCATE is not subject to RLS. Not in the review. See "New observations" below.

---

## A. Function bodies — live vs repo

Each function's stored body was read directly out of the live database (`pg_proc.prosrc`, the verbatim text Postgres holds) and fingerprinted. The same fingerprint was computed from the body text in the last repo migration that defines that function. Same fingerprint = identical, to the byte, once both sides are compared under the same line-ending convention (see "A note on line endings" below).

| Function | Verdict | Live fingerprint | Bytes | Repo source of that body |
|---|---|---|---|---|
| `complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz)` | **MATCHES REPO** | `a1e9a043f27d3566f8ecf6d5e3a809ab` | 1720 | `20260716202000_preflight_delivery_accounting_period.sql` |
| `_complete_delivery_period_preflight_impl` | **MATCHES REPO** | `a9f80dc25207eba595e9998409e9ceb9` | 5782 | `20260716191000_aggregate_delivery_stock_preflight.sql` |
| `_complete_delivery_aggregate_impl` | **MATCHES REPO** | `b888901587accbee7f7fe4aeb512e683` | 1075 | `20260716173342_authorize_delivery_before_replay.sql` |
| `_enforce_quote_status_transition()` | **MATCHES REPO** | `c2749a6c84fc32d95e12d9af885616e5` | 2240 | `20260706030000_closed_short_booking_closure.sql` |
| `revert_quote_status(uuid,text,uuid,text)` | **MATCHES REPO** | `fb0cc5def3766270b13c401810b61f3e` | 8150 | `20260719044958_revert_quote_status_deadlock_retry.sql` |
| `restore_quote_version(uuid,uuid,uuid,text,bigint)` | **MATCHES REPO** | `d533d681ebc6ceb94338cd6f77220d71` | 4366 | `20260730235031_quote_customer_row_version_guard.sql` |
| `_restore_quote_version_owner_impl(uuid,uuid,uuid,text,bigint)` | **MATCHES REPO** | `30e9e41e1ca8be8098a325dc8947784e` | 7321 | `20260730235031…` (renamed-under body) |
| `convert_quote_to_order(uuid,uuid,text,bigint)` | **MATCHES REPO** | `2b10185e7be4f760c1b69cd479c0135d` | 3485 | `20260730235031_quote_customer_row_version_guard.sql` |
| `_convert_quote_to_order_owner_impl(uuid,uuid,text)` | **MATCHES LIVE SOURCE — ahead of `main`** | `5e6b8d558bc2fded444e10c7943b399e` | 11590 | `20260810150000_commission_basis_from_canonical_order_header.sql` — applied live, **not yet in `origin/main`**; see "Live moved during the audit" |
| `create_direct_order(uuid,date,text,text,jsonb,uuid,text,text)` | **MATCHES LIVE SOURCE — ahead of `main`** | `c761f4c46dc12ea07efd74af5b2ada54` | 7692 | same migration as the row above. Was `1e5f173cbbb039617334cef731a0a667` / 6561 from `20260614142939_create_direct_order_customer_po_param.sql` when first measured |
| `void_invoice(uuid,text,text)` | **MATCHES REPO** | `c7a488d58bd876e92565bca9bd4edc90` | 706 | `20260720175946_protect_governed_split_edit_and_void_group.sql` |
| `_void_invoice_group_guard_impl_20260720(uuid,text,text)` | **MATCHES REPO** | `9f1656542c5c6a667b1c8a67034c5c3f` | 2544 | `20260720175946…`; fingerprint pinned by `20260721014858_…govern_invoice_order_money_lifecycle.sql:40` |
| `get_customer_year_end_summary(uuid,integer)` | **MATCHES REPO** | `d233e92d2903825905c55d2fc02165c1` | 6316 | `20260228200000_season_calendar_oct_sep.sql` |
| `check_customer_credit_limit(uuid)` | **MATCHES REPO** | `3adc17f7fa1612df87264a4702d72858` | 1045 | `20260712130000_credit_limit_count_unposted.sql` |
| `global_search(text,integer)` | **DIFFERS — cosmetic only** | `8b52e155e2d36ac7e83001c02e943822` | 1974 (repo 2036) | `20260404080000_fix_global_search_ilike_escape.sql` |
| `get_customer_summary(uuid)` | **DIFFERS — cosmetic only** | `0c62f7918b943433e972dd7885a64249` | 1591 (repo 1775) | `20260404040200_get_customer_summary_rpc.sql` |

### The two differences, spelled out

Both are **comment stripping only**. Not a single line of logic differs. Neither has any behavioural effect.

**`global_search`** — live is 62 bytes shorter than the repo. Those 62 bytes are exactly one comment line that is present in the repo and absent live:

```sql
  -- Escape ILIKE metacharacters before wrapping in wildcards
```

The line it describes — the escape fix that stops a user typing `%` from matching every row in every table — is present and identical live. The safety fix is in production; only its explanatory note was dropped.

**`get_customer_summary`** — live is 184 bytes shorter. Those 184 bytes are exactly six comment lines: `-- Current season: Oct 1 to Sep 30`, `-- AR Balance (sum of unpaid invoice balances)`, `-- Orders this season`, `-- Completed deliveries this season`, `-- Credit tier`, `-- Last activity`. Every calculation is identical.

**Most likely cause:** both are from early April 2026 and were almost certainly applied through a path that normalised the SQL before storing it, rather than an editing difference. **No action needed, and no finding changes because of them.**

### Structural checks, all clean

- **All fourteen** use `SET search_path = public, pg_temp` **in production** (the project's hard rule against search-path hijacking), read from `pg_proc.proconfig`. The repository produces the same result once the full migration set is replayed — see the retracted-finding note immediately below.
- **All are `SECURITY DEFINER` except `_enforce_quote_status_transition`**, which correctly is not — it is a trigger and should run as the caller.
- **No duplicate overloads exist** for any of them. (A stale second copy of a function with slightly different arguments is a known failure mode in this repo; there are none here.)

### Retracted: the claimed `search_path` drift on `get_customer_year_end_summary`

**An earlier revision of this document reported a genuine repo/live disagreement here. That report was wrong, and it is withdrawn. There is no drift. Nothing needs fixing in the repo, and nothing needs applying live.**

The claim was that `get_customer_year_end_summary` runs live with `search_path = public, pg_temp` while its committed definition at `20260228200000_season_calendar_oct_sep.sql:850` declares only `public`. Both halves of that are true. The conclusion drawn from them was not, because the search for a later change looked only for another definition of *that function*. There is one, and it is not function-specific:

`20260332800000_fix_pg_temp_search_path_all_functions.sql` walks **every** `SECURITY DEFINER` function in `public` whose `search_path` lacks `pg_temp` and issues `ALTER FUNCTION … SET search_path = public, pg_temp`, then raises an exception if any is left unfixed. The live ledger confirms it applied *after* the migration that creates this function:

| Applied | Migration |
|---|---|
| `20260228121207` | `season_calendar_oct_sep` — creates the function with `search_path = public` |
| `20260316220422` | `batch_year_end_and_cleanup` |
| `20260318182924` | `fix_pg_temp_search_path_all_functions` — hardens both, and everything else |

So replaying the committed migrations from scratch reproduces production's `public, pg_temp` exactly. The repo is not a footgun; it fixes itself two migrations later.

**The lesson worth keeping.** A function has a body and it has *attributes* — `SECURITY DEFINER`, `search_path`, and so on. They are stored separately, and `ALTER FUNCTION … SET search_path` changes the attribute **without touching the body by a single byte**. That cuts both ways: a body fingerprint cannot see attribute drift, *and* reading an attribute off a function's `CREATE` header is not the repo's final answer either. **Attributes have to be replayed across the whole migration set, exactly like bodies** — a bulk `ALTER` migration that names no function individually is invisible to any per-function search. That is the mistake this section records.

*(An automated reviewer raised "the clean verdict is false", correctly identifying the header/live mismatch. The verdict about **live** was correct throughout. Chasing the reviewer's concern produced a wrong intermediate conclusion, corrected here.)*

### Live moved during the audit — two functions in this table were rewritten under it

A reviewer asked for the *private* implementation behind `convert_quote_to_order` to be fingerprinted, not just the public wrapper. Doing that produced a mismatch: live `_convert_quote_to_order_owner_impl` is 11,590 bytes, and replaying this branch's migrations produces 10,333 — **1,257 bytes longer in production**, in a function that supplies the commission basis. That is exactly the shape of a real drift finding, so it was chased to the bottom rather than reported.

**It is not drift. Production is ahead of this branch, and ahead of `origin/main`.** The extra text is a variable named `v_canonical_profit` carrying a `-- DELTA-A` marker, introduced by `20260810150000_commission_basis_from_canonical_order_header.sql` — a migration written and **applied to production on 2026-08-10** by a concurrent session on branch `claude/confident-mclean-7f73d6`. It is not in `origin/main`. Fingerprinting that file's body reproduces production byte-for-byte: `5e6b8d558bc2fded444e10c7943b399e`, 11,590 characters, an exact match.

That migration rewrites **two** functions in the table above — `_convert_quote_to_order_owner_impl` and `create_direct_order` — so `create_direct_order`'s row has moved too, from `1e5f173cbbb039617334cef731a0a667` / 6,561 bytes to `c761f4c46dc12ea07efd74af5b2ada54` / 7,692. Both are still `SECURITY DEFINER` with `search_path = public, pg_temp`, and the signatures are unchanged, so `CREATE OR REPLACE` preserved the existing grants.

Two things are worth noting about it, because they cut in opposite directions:

- **It confirms this audit's method.** That migration's own header pins its pre-change baseline as `1627fcaa5dad2682e26f48cf4819ece9` and `1e5f173cbbb039617334cef731a0a667` — the same two fingerprints this document recorded, arrived at independently. It also cites this review's findings file by line number. Two sessions measuring the same production database got the same answer.
- **It is a reason to re-read the fingerprints before acting on them, not to trust this table as permanent.** Production changed underneath a read-only audit, twice in two days, from work that has not merged. Any remediation wave must re-take its own fingerprints at the moment it runs. The row verdicts above are a statement about production **as of 2026-08-10**, not a standing fact.

**The count of applied-but-unmerged migrations is now four**, not the three recorded earlier in this document: `team_note_completion_rpc_and_assignment_notify`, `20260809154649_active_team_note_assignment_actor`, `20260810022500_backfill_stale_line_profit`, and `20260810150000_commission_basis_from_canonical_order_header`. Every other ledger entry matches a file in `origin/main` — several under a re-issued filename, which is why they must be matched by name and not by timestamp.

What this change does to finding #5 is in §D. Short version: it does not close it.

### A note on line endings

**Live bodies are a mix of LF and CRLF, and this had to be handled before any comparison could be trusted.** Postgres stores whatever bytes the migration file contained. CRX migration files are inconsistently saved — some LF, some CRLF — so a function defined in a CRLF-saved file is stored with CRLF inside the database, forever.

Three practical consequences, all of which shaped how the checks above were run:

1. A fingerprint comparison that normalises only one side reports a false mismatch. Every comparison here was run **both ways** — raw, and with carriage returns stripped from both sides — and is reported as a match only if one of the two agrees exactly.
2. Two functions in the invoice chain (`_post_invoice_idem_impl_20260721`, `_create_invoice_from_order_idem_impl_20260721`) match **only** in raw CRLF form. Both originate from the CRLF-saved file `20260721014858_…govern_invoice_order_money_lifecycle.sql`.
3. One function is stored with **mixed** line endings — see below. That is the single genuine byte-level difference found anywhere in this audit.

**`_void_invoice_split_provenance_impl_20260719` — the one real difference, and it is cosmetic.** Live is 19,052 bytes; the repo's CRLF source body is 19,059. The 7-byte gap was narrowed by binary search on prefix fingerprints to characters 6,951–6,960, and then read directly from both sides. The text is identical; live simply switches from CRLF to LF part-way through the same comment block, losing seven carriage returns:

```text
live: …are unaffected.\r\n  IF v_inv.paid_amount_cents > 0\r\n     OR EXISTS (\n       SELECT 1\n…
repo: …are unaffected.\r\n  IF v_inv.paid_amount_cents > 0\r\n     OR EXISTS (\r\n       SELECT 1\r\n…
```

Strip carriage returns from both and they are identical: `d5ac51bf7ae432e9c8360bc75247c087`, 18,748 characters on each side. **Not one instruction differs. No finding is affected.** It is recorded because a future audit running a naive fingerprint check will hit this and should not treat it as drift.

### A note on layered functions

Several of these are not single functions but chains, because this project hardens functions by renaming the old body to `_..._impl_<date>` and wrapping a new one around it. **Every layer was verified, not just the outer one** — a check of only the outer wrapper would have proved almost nothing, since the wrapper is usually a few hundred bytes of delegation and all the real behaviour lives underneath.

| Chain | Layers verified live |
|---|---|
| `complete_delivery` | `_complete_delivery_period_preflight_impl`, `_complete_delivery_aggregate_impl` |
| `void_invoice` | `_void_invoice_group_guard_impl_20260720`, `_void_invoice_split_provenance_impl_20260719`, `_delete_invoices_split_provenance_impl_20260719`, `_post_deleted_delivery_recovery_invoice_20260719` |
| `create_quick_delivery` | `_create_quick_delivery_intent_impl_20260802` |
| `post_invoice` | `_post_invoice_impl_20260714`, `_post_invoice_public_impl_20260718`, `_post_invoice_customer_scope_impl`, `_post_invoice_idem_impl_20260721` |
| `create_invoice_from_order` | `_create_invoice_from_order_impl_20260718`, `_create_invoice_from_order_idem_impl_20260721` |
| commission minting | `_insert_commissions_for_order`, `_insert_commissions_for_job` |

The `void_invoice` group guard additionally matches the fingerprint that the repo's own migration `20260721014858` hard-codes as its expected value — the repo's own self-check agrees with live.

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

This matches the baseline exactly. The baseline additionally lists `MAINTAIN` (a PostgreSQL 17 privilege covering maintenance commands such as `VACUUM` and `REINDEX`), which the standard `information_schema` view does not report at all — so its absence from a normal grants readout proves nothing either way.

Rather than assume, it was queried directly with `has_table_privilege`, which does report it. On all four tables, `MAINTAIN` is **held** by `anon`, `authenticated`, and `service_role`, and **not held** by `metabase_ro`. That is exactly what the baseline says. The earlier reading of this as a "reporting artifact" was a guess; it is now a measurement. Server version: PostgreSQL 17.6.

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

**`_is_admin_override()`** — reads `current_setting('app.admin_override', true) = 'true'`. This is the escape hatch that lets the transition triggers above be bypassed, so who can set it matters a great deal.

**This paragraph has now been wrong twice, and the second correction is the important one.** The first draft claimed no `authenticated`-executable function sets the flag — false. The second draft corrected that to a list of seven direct setters and rested the safety conclusion partly on having enumerated them. **That enumeration was also incomplete**, for a reason worth recording: it searched for `set_config(`, and the database sets this flag in *two* syntaxes. `SET LOCAL app.admin_override = 'true'` is the other one, and a `set_config`-only search cannot see it. It also counted only functions that set the flag *themselves*, ignoring wrappers that reach a setter through a private callee — `cancel_order` and `convert_quote_to_order` are both `authenticated`-executable and both reach one that way.

**Enumerating callers was the wrong basis for the conclusion.** It is fragile — it has now failed twice — and it is unnecessary, because a single property settles the question for every path at once, direct or transitive, known or missed.

**The whole database contains 26 functions that set this flag. Every one of them sets it transaction-locally. Verified live:**

| How the flag is set | Count | Scope |
|---|---|---|
| `set_config('app.admin_override', …, true)` | 18 | transaction-local (`is_local = true`) |
| `SET LOCAL app.admin_override = …` | 9 | transaction-local by definition |
| `set_config('app.admin_override', …, false)` | **0** | *would* be session-scoped |
| `SET app.admin_override = …` (no `LOCAL`) | **0** | *would* be session-scoped |

(18 + 9 exceeds 26 because one function uses both spellings.)

**Zero session-scoped setters exist.** The override therefore cannot outlive the transaction that set it on *any* code path. It cannot survive into a later statement, and it cannot leak onto a pooled connection reused by another user. That holds without knowing which functions are reachable, which is exactly why it is the claim worth relying on.

The in-function authorisation checks are a real second layer, and they were measured on the eight functions that set the flag directly and are `authenticated`-executable — `assign_job_applicator`, `cancel_delivery`, `cancel_return`, `revert_quote_status`, `transfer_invoice_to_job`, `unapply_credit_memo`, `unpost_invoice`, `void_delivery`. In each, an `AUTH_REQUIRED` / `ACTOR_MISMATCH` / `INSUFFICIENT_ROLE` or explicit role check precedes the override, by 906 characters in the closest case (`assign_job_applicator`) and 5,758 in the widest (`revert_quote_status`). **This is defence in depth, not the load-bearing argument** — the transaction-locality above is.

**What this does and does not prove — the third correction to this section.** Transaction-locality settles one question completely: the override **cannot leak across transactions**. It says nothing about what a caller can do *inside* one. A `SECURITY DEFINER` function that sets the flag and then performs a guarded write in the same transaction has, by construction, bypassed the trigger for that write — and if that function is `authenticated`-executable, a client reaches the bypass by calling it. That is not hypothetical here: `restore_quote_version` is `authenticated`-executable, accepts sales reps, and delegates to an owner implementation that sets the flag and rewrites a quote's status to `revised` — which is itself a MED finding in this same review. The in-function authorisation checks listed above are what actually stand between a client and that class of bypass, so they are **not** merely defence in depth for the in-transaction case; they are the whole defence.

So the correct statement is narrower than the previous draft's: the override is **not a persistent or cross-user bypass**, and it is not reachable *except* through a function that deliberately sets it after its own authorisation check. Whether each of those authorisation checks is the right one is a per-function question this section does not answer, and the `restore_quote_version` finding is the case where the review says it is not.

The property to preserve when hardening any of these functions is the transaction-local scope: a future change that sets this flag with `is_local = false`, or with a bare `SET`, would open a real bypass no grant review would catch. **Worth a guard** — a one-line, mechanically checkable rule, and per the project's own preference for hard scaffolding over prose it belongs in a test rather than in this paragraph. Note what such a guard would and would not cover: it stops a *new* session-scoped setter from being introduced, and it does nothing about the in-transaction class above, which needs per-function review of the authorisation check, not a pattern rule. Recorded for the triage, not acted on here.

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
| 9 | `get_customer_year_end_summary` is an ungated `SECURITY DEFINER` RPC granted to `authenticated` | **CONFIRMED AGAINST LIVE — and it is five functions, not one** |
| 10 | Sales reps can insert orders and order lines directly, bypassing canonical order creation | **CONFIRMED AGAINST LIVE** |

### The detail behind each verdict

**#1 — confirmed.** The permitted-transition list in the live trigger body literally contains the `accepted → sent` arm. Anyone who passes `quotes_update` (an admin, or the sales rep who created the quote) can reopen an accepted quote by writing the table directly, and none of `revert_quote_status`'s reopen guards run.

**#2 — confirmed, mechanism corrected.** The review's word "walked" is accurate, and it matters more than it might sound. A direct `scheduled → completed` jump is **blocked** by the live transition trigger. Two separate updates are required. A sales rep can perform both hops unconditionally under `del_update`. Neither hop triggers inventory movement, order rollup, or invoicing. *Any remediation that assumes one-hop is the attack will be testing the wrong thing.*

**#3 and #4 — confirmed; they are one defect, not two.** Live has only one holds table, `inventory_holds`; crop-program holds and quote holds are rows in the same table, so #4 is #3 seen from a different caller. `quotes.deleted_at` exists.

**The trigger census here was wrong in an earlier revision and is corrected.** It said no trigger on `quotes` fires on a soft delete. One does. Read from `pg_trigger` live: six of the seven are declared `UPDATE OF <one column>` — five on `status` (`enforce_quote_accepted_fully_drawn`, `enforce_quote_status_transition`, `trg_enforce_quote_terminal_not_drawn`, `trg_release_holds_on_quote_status`) and two on `commission_split` (`trg_stamp_commission_split_recipient_ids`, `trg_validate_quote_commission_split`). **`quotes_bump_row_version` has no column list at all**, so it fires on *any* `UPDATE`, including a `deleted_at`-only write, and increments `row_version`. Anyone writing a test for this finding needs to expect that side effect.

**The finding is unchanged, and the corrected census is what supports it.** None of the triggers that fire on a soft delete *releases holds or blocks the deletion* — `quotes_bump_row_version` only stamps a version number. The hold-release trigger is keyed to `UPDATE OF status` and never sees a `deleted_at`-only write, and the one function that mentions `deleted_at` at all is the status-transition guard, which uses it to check for active *jobs*. **Setting `deleted_at` still releases nothing.**

**Live data check: there are currently zero active inventory holds attached to soft-deleted quotes.** The defect is real and structurally open, but it has not yet caused a leak in production. This is genuinely useful — it means this is a fix-before-it-bites, not a clean-up-the-damage.

**#5 — confirmed, and re-checked against a live body that changed mid-audit.** `create_direct_order` was rewritten in production on 2026-08-10 by `20260810150000_commission_basis_from_canonical_order_header.sql` (see §A, "Live moved during the audit"). That migration is aimed squarely at the commission basis, so the finding was re-read against the **new** live body rather than the one originally fingerprinted.

**It does not close #5.** What it changes is where the commission basis is *read from*: instead of a local accumulator captured before the `order_items` triggers run, the function now re-reads `ROUND(COALESCE(orders.total_profit, 0), 2)` from the order it just wrote, so the commission can no longer be attributed to a profit figure the order itself does not report. That is a real fix for a real inconsistency, and it is not this finding.

**The cost that feeds that figure is still whatever the caller sent.** In the new live body the line cost is written as `COALESCE((v_item->>'unit_cost')::numeric, 0)` — taken from the caller's `p_items` payload, defaulting to zero, and never compared against `products.current_cost`. The header's `total_profit` is then derived from that cost, and the commission is derived from the header. So the caller still controls the basis; it now reaches it through one more hop. A caller who sends `unit_cost: 0` still produces a full-price profit and a commission minted on it.

The `_snapshot_order_item_cost` trigger noted under "New observations" fills `cost_at_time_cents` when the caller leaves it NULL, which is a fallback for a *missing* cost, not a check on a *wrong* one — and it writes a different column from the one the profit derivation uses. **The remediation for #5 is unchanged: the server must source the cost, not accept it.**

**#6 and #7 — confirmed by identity, across the full dependency chains.** These are behavioural findings, and an earlier draft of this document rested them on the `complete_delivery` and `void_invoice` chains alone. That was not enough: finding #6 is about a *quick-delivery invoice* and finding #7 is about *commission minting*, and neither of those code paths sits inside the two chains that had been checked. The gap has been closed — the functions those findings actually depend on were fingerprinted against production too:

- **#6 (quick-delivery double-billing):** `create_quick_delivery`, `_create_quick_delivery_intent_impl_20260802`, `post_invoice`, `_post_invoice_impl_20260714`, `_post_invoice_public_impl_20260718`, `_post_invoice_customer_scope_impl`, `_post_invoice_idem_impl_20260721`.
- **#7 (commission cancellation with no re-mint):** `create_invoice_from_order`, `_create_invoice_from_order_impl_20260718`, `_create_invoice_from_order_idem_impl_20260721`, `_insert_commissions_for_order`, `_insert_commissions_for_job`, plus the deeper void layers `_void_invoice_split_provenance_impl_20260719`, `_delete_invoices_split_provenance_impl_20260719`, `_post_deleted_delivery_recovery_invoice_20260719`.

**All match production.** The review's file-based analysis therefore describes production exactly, for the code each finding actually runs through — not merely for the two chains nearest to it. (This confirms the *code* is as described; the *behaviour* was not re-executed — see "What was not verified".)

**#8 — confirmed, narrower than described.** The `del_update` policy admits the assigned driver only when the delivery's existing status is `in_progress` or `completed`. So the driver **cannot** start the walk — they cannot move a `scheduled` delivery to `in_progress`. They *can* perform the final `in_progress → completed` hop, which is precisely the state a delivery is in while a driver is working it. The finding holds; the fix must account for the driver needing legitimate write access to `in_progress` rows.

**#9 — confirmed, and larger than the finding's title. It is five functions, not one.** `get_customer_year_end_summary`, `check_customer_credit_limit`, `get_customer_summary`, `global_search`, and `get_batch_year_end_summaries` are all live `SECURITY DEFINER`, granted `EXECUTE` to `authenticated`, and **not one of them contains any caller check of any kind** — no `is_admin()`, no `is_sales_rep()`, no `is_office()`, no `auth.uid()` comparison, no role lookup. Any signed-in user can call any of them for any customer. `anon` is correctly excluded from all five.

**The fifth one was missed until the third review round, and it is the worst of them.** `get_batch_year_end_summaries(uuid[], integer)` takes an **array** of customer IDs and loops, calling `get_customer_year_end_summary` once per entry and concatenating the results. Its entire live body is thirteen lines with no authorisation anywhere in it. Verified live: `SECURITY DEFINER`, `search_path = public, pg_temp`, `EXECUTE` held by `authenticated` and `service_role`, denied to `anon` and `metabase_ro`, and its body is byte-identical to the repo (`98e8b1de00708a0027103a6fccaf271d`, 357 characters, from `20260316100003_batch_year_end_and_cleanup.sql`).

Why it matters more than the other four: it turns a one-customer-per-call leak into a **bulk export**. Gating `get_customer_year_end_summary` alone would not close it, because the batch function is `SECURITY DEFINER` in its own right — its privileges do not depend on the caller's. **Wave C must gate this function too, and the remediation verification must exercise the batch endpoint, not only the four singles.** The plan's current scope of four is therefore incomplete by one.

*(Raised by an automated reviewer against a revision that listed only four. Verified live and confirmed correct.)*

**#10 — confirmed.** Live `orders_insert` and `oitems_insert` both permit `is_admin() OR is_sales_rep()`, and `authenticated` holds INSERT on both tables. Nothing in the trigger set enforces the confirmed-only status rule on a direct insert.

---

## E. New observations — things the review did not know

These are recorded, not acted on. Per the plan's own rule: record rather than widen.

**1. `authenticated` holds TRUNCATE on all four tables.** TRUNCATE empties a table wholesale and **is not subject to RLS** — row-level policies cannot restrain it. Ordinary DELETE by a sales rep is blocked by the `*_delete` policies requiring `is_admin()`; TRUNCATE steps around that entirely. Re-confirmed live on the corrected pass: `authenticated` holds it on all four tables; `anon` and `metabase_ro` do not. This appears inherited from a broad grant rather than a deliberate decision, and it is not in the 77 findings.

**No exploit path is claimed.** PostgREST — the layer the app talks to — does not expose TRUNCATE, so this is defence-in-depth, not an open door. It is still worth closing, and there is now a direct precedent: a sibling session shipped `20260809170700_revoke_inventory_truncate_and_mark_payments_dead.sql` (live, and merged to `origin/main`) doing exactly this one-line revoke for the `inventory` table, with the same reasoning. **Worth the same one-line `REVOKE TRUNCATE` for these four tables in Wave B**, where the direct-write lockdown is already being done.

**2. Production is four migrations ahead of `origin/main` — and this list is a correction, twice over.** An earlier draft of this document listed four, including `20260809205423 round_line_profit_with_revenue` and `20260810000427 single_canonical_line_profit`. **Both of those are in fact present on `origin/main`**, as `20260809170900_round_line_profit_with_revenue.sql` and `20260809230500_single_canonical_line_profit.sql`. The confusion is a known and recurring trap in this repo: **a migration's version number in the live ledger is the timestamp at which it was applied, not the timestamp in its filename.** Matching the two by number alone produces phantom gaps. These two are documented as re-issued-forward in `docs/reference/migration-history.md`.

Matching by *name* instead, four live migrations genuinely have no counterpart in `origin/main`:

| Live version | Name | Where the file lives |
|---|---|---|
| `20260809130108` | `team_note_completion_rpc_and_assignment_notify` | branch `claude/todo-list-audit-hoxpl5`, PR #351 |
| `20260810010308` | `20260809154649_active_team_note_assignment_actor` | same branch, PR #351 |
| `20260810025159` | `20260810022500_backfill_stale_line_profit` | branch `claude/session-orchestration-setup-d73e6c`, PR #364 |
| `20260810152935` | `20260810150000_commission_basis_from_canonical_order_header` | branch `claude/confident-mclean-7f73d6` |

**The last two are new since this document's evidence was first gathered**, and both landed while this audit was being written. The backfill applied at 02:51 UTC on 2026-08-10 and repaired stored profit figures on existing money rows — so live money *data*, not just live code, moved underneath this document. The commission-basis migration applied at 15:29 UTC the same day and **rewrote two of the function bodies this document fingerprints**; that is covered in §A under "Live moved during the audit".

**The pattern matters more than either individual migration.** Four unmerged migrations are live, from three different concurrent sessions, and two of them changed production during a read-only audit that takes a few hours. Any statement in this document of the form "live matches the repo" is a measurement with a timestamp on it, not a durable property. **Every remediation wave must re-take its own baseline immediately before it writes**, and `origin/main` is not a safe stand-in for what is actually running.

None of this changes any of the ten HIGH verdicts — every body relevant to them still matches. The corrected takeaway is narrower but sharper: **the two money-rounding migrations are no longer a gap, and the remaining money-related item is a data backfill that has already run.** The repo/live gap should still be closed before Wave A, but the reason is now "two unmerged PRs exist", not "the money path on disk is stale".

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
- **This is a snapshot, not a standing guarantee.** Production changed twice while the audit was running, from concurrent sessions applying unmerged migrations — the second time rewriting two function bodies recorded here. Every fingerprint, grant, and policy in this document is as of **2026-08-10**. Nothing here licenses a later wave to skip re-measuring.
- **The four unmerged live migrations were not themselves reviewed.** They are named so the gap is visible; whether each is correct is a separate question this document does not answer.
- **The backup freshness check (Step 0 of the plan) was explicitly waived by Mason for this task**, on the grounds that it reads and changes nothing. **The waiver does not extend to any step that writes.** The backup check returns before the first remediation wave.

---

## How this was produced (reproducible)

Live reads via the Supabase MCP `execute_sql` tool against project `rhyzpcqhnizqbxphqdkr`, one statement at a time (the tool returns only the last statement's result, so batching would have silently discarded evidence).

- Function bodies: `pg_proc.prosrc` — the verbatim stored text. `pg_get_functiondef()` was deliberately **not** used for diffing: it re-renders and normalises the definition, which would have masked real differences.
- Repo-side fingerprints: rather than scanning for the last `CREATE [OR REPLACE] FUNCTION` per name (which misses renamed bodies entirely), the whole migration directory is **replayed** in filename order, maintaining a map of function name → current body and honouring `CREATE OR REPLACE`, `ALTER FUNCTION … RENAME TO`, and `DROP FUNCTION`, with statements applied in their within-file order. This is what makes the `_..._impl_<date>` layers checkable at all: those functions exist only because an older body was renamed under them, so no `CREATE` statement for them exists anywhere. The replay was validated by reproducing ten already-confirmed fingerprints exactly before being trusted for the rest.
- Every fingerprint was computed **twice** — once on the raw file bytes and once with `\r\n` normalised to `\n` — and a function is reported as matching only if one of the two agrees exactly with live. Comparing under a single convention produces false mismatches on this repo (see "A note on line endings").
- **When a replay does not reproduce live, the migration set being replayed may simply be incomplete.** The replay covers this branch's `supabase/migrations/`, which tracks `origin/main`. Production can be ahead of that, because a concurrent session may apply a migration from its own branch before merging. So a mismatch was never treated as drift until the live ledger had been matched **by name** against `origin/main` and the surplus migrations located on disk — in practice by searching every checked-out worktree for the filename. That is how the one apparent drift in this audit was resolved (§A, "Live moved during the audit"). Matching the ledger by version number instead of by name produces phantom gaps, because the ledger's version is the *apply* timestamp, not the filename's.
- Grants: `information_schema.role_table_grants`, plus `has_table_privilege` for `MAINTAIN` and `TRUNCATE`, which that view does not report. Function permissions: `pg_proc.proacl`.
- Function attributes: `pg_proc.proconfig` (`search_path`) and `pg_proc.prosecdef` (`SECURITY DEFINER`). These are stored separately from the body, so they are invisible to a body fingerprint and must be compared on their own. Repo side, the `SET search_path` clause in each function's `CREATE` header is only a *starting* value — bulk `ALTER FUNCTION` migrations that name no function individually change it later, so attributes must be replayed across the whole migration set exactly as bodies are. Reading the header alone produced this audit's one retracted finding (§A). Both the `TO x, y` and `= 'x', 'y'` spellings the repo uses interchangeably are accepted.
- Policies: `pg_policies` (`qual`, `with_check`, `roles`, `cmd`); RLS state from `pg_class.relrowsecurity` / `relforcerowsecurity`.
- Triggers: reconstructed from `pg_trigger` catalog columns (`tgname`, `tgenabled`, `tgtype` bitmask, joined to `pg_proc`). `pg_get_triggerdef()` is blocked by a local safety hook, so the catalog was read directly.
- Baseline policies: `20260727174805_public_schema.sql.br` decompressed with Node's `zlib.brotliDecompressSync` (3,054,020 characters, 423 policies).
- One aggregate live-data count was run (active holds on soft-deleted quotes). It returned zero. No row identifiers, customer data, pricing, or financial figures were read or are recorded here.

---

## Recommended next step

**Proceed to Step 2 — the Codex triage — with this document attached, and add one item to it: get the four unmerged live migrations onto `origin/main` so the repo and production agree before Wave A begins.**

The evidence gap is closed and the review survived it intact: all ten HIGH findings stand, so the remediation plan's shape does not need to change. The remaining repo/live gap is four unmerged migrations from three concurrent sessions — PR #351, PR #364, and the `claude/confident-mclean-7f73d6` commission-basis migration, which has no PR yet. One already changed live money data and another already rewrote a money function. Wave A is the money wave; starting it while production contains changes the repo does not is how a fix ends up conflicting with what production already does.

**Related, and the more durable lesson:** two of those four applied during this audit. Whatever this document says about production is true as of 2026-08-10 and no later, so **each wave must re-take its own fingerprints and grants immediately before it writes** rather than trusting the tables here. That is a process item for the triage, not a finding.

Three smaller items to carry into the triage, none urgent and none requiring a live change:

- **Wave C:** widen the scope from four functions to five. `get_batch_year_end_summaries` (§D, #9) is a `SECURITY DEFINER` bulk loop over an arbitrary array of customer IDs with no caller check, granted to `authenticated`. Gating the four singles leaves it wide open, and the wave's verification must call the batch endpoint.
- **Wave B:** add `REVOKE TRUNCATE` on the four ordering-cycle tables (§E), following the precedent already merged for `inventory`.
- **Any wave, cheap:** add a guard test asserting that no `public` function sets `app.admin_override` session-scoped — no `set_config(…, false)` and no bare `SET app.admin_override`. All 26 setters are transaction-local today (§C), and that is the property the *cross-transaction* half of the override-safety argument rests on. It is one regex over `pg_proc.prosrc` and it turns a paragraph of prose into something that fails loudly. **Be clear about what it does not cover:** it says nothing about a caller reaching a bypass *within* one transaction through an `authenticated`-executable function that sets the flag after its own authorisation check. That class needs per-function review — `restore_quote_version` is the review's example — and no pattern rule substitutes for it.
