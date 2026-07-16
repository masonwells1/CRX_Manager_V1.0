# Claude's disposition of the Codex cross-review — CRX nightly-debug mission

**Date:** 2026-06-16 · **Branch:** `claude/priceless-austin-0d3ccd` · **Reviewer:** Codex (gpt-5.5, xhigh) via `codex review --base main`
**Scope reviewed:** the whole nightly-debug branch — 5 applied green fixes, 7 parked fixes (PARKED-01…07), and the findings ledger.

## Verdict
Codex did **not** dispute the 39 findings or the core parked remediations (PARKED-01/02/03/05/06 — implicitly
endorsed). It raised **4 defects in the audit artifacts themselves** (the crawl harness + two parked docs). Claude
**agrees with all 4**; all are fixed on the branch (nothing prod-facing — the crawl never ran and the parked fixes
were never applied).

| # | Codex | Claude disposition | Fix |
|---|---|---|---|
| P1 | Crawl isn't read-only — `/quotes/new` reserves a quote number on mount (`nextval('quote_number_seq')`). | **Agree.** Real safety-model violation. | Removed all 7 creation/"new" form routes from `tests/crawl/route-crawl.spec.ts` (54→47 routes); added a comment explaining why. |
| P1 | PARKED-07's `config.toml` example pins `seed-admin` `verify_jwt = false` — copying it after the harden step keeps it unauthenticated. | **Agree.** Footgun. | Changed the example to `verify_jwt = true` with an explicit "do not pin false / delete-and-omit" warning. |
| P2 | Crawl mis-reports an allowed route that redirects away as `ok`. | **Agree.** | Added an `unexpected-redirect` status for allowed-but-redirected routes (+ type + summary). |
| P2 | PARKED-04 order-share guard: not `SECURITY DEFINER` (RLS can under-count) and no per-order lock (concurrent inserts both pass). | **Agree — strong catch.** | Made `_validate_order_shares_total()` `SECURITY DEFINER` + added `PERFORM 1 FROM orders WHERE id = NEW.order_id FOR UPDATE` to serialize. Re-validated (compiles, rolled back). |

## Net
The 7 parked fixes are now Codex-reviewed. PARKED-01/02/03/05/06 stand as-is; PARKED-04 and PARKED-07 were
corrected per Codex; the crawl harness is now genuinely read-only and won't false-pass broken pages. Remediation
(applying the parked fixes to the live DB) still awaits Mason's go, one at a time through `/migration-review` + `/ship`.
