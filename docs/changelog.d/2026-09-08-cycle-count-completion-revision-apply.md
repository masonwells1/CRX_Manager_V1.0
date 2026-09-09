## 2026-09-08 — Cycle-count completion revision: unblocked, hardened, and applied live

`20260908120000_close_pr535_live_gaps.sql` was written, reviewed and merged on 2026-09-08
but never applied, so the defect it closes was still live. This entry records the apply and
the three additive changes made to the file to get it there.

### The live defect it closes

`public.complete_cycle_count(uuid,uuid,text,bigint)` guarded BOTH of its staleness checks
behind `p_expected_item_revision IS NOT NULL`. A caller that omitted the argument therefore
skipped optimistic concurrency entirely and could apply an inventory variance nobody
reviewed. The migration refuses a null revision outright (`CYCLE_COUNT_REVISION_REQUIRED`)
and removes the `IS NOT NULL` guard on the comparison. Body otherwise byte-identical.

No deploy-ordering break: every shipped caller already sends the revision
(`src/pages/CycleCounts.tsx:589-594` and `:778-783`, both gated to fail closed when the
revision is not a number), `src/lib/db.ts:174` defines the new code, and
`src/pages/CycleCounts.tsx:807-811` maps it to a plain-English reload instruction. All of
that was already on `main` and deployed.

### Why the apply was blocked, and why stepping over is honest

The pending-set guard refused: seven older tracked-but-unapplied migrations
(`20260905090000` next-invoice-number and the six `20260905200000`–`20260905210000`
commission files) would be stranded by advancing the high-water past them.

**The mechanism is real; the premise no longer holds.** Those seven are ALREADY stranded,
independently of this file. `20260906120000_preview_field_app_season_follows_invoice_date`
was applied live on 2026-09-08 (ledger version `20260908045843`) and its stamp is above all
seven. Observed rather than inferred: dry-running the oldest of them
(`20260905200000_commission_history_report_replay_guard`) through
`scripts/apply-migration-file.mjs` is refused by the ordering guard — *"its filename
timestamp is 20260905200000, but 20260906120000 has ALREADY BEEN APPLIED"* — with no
contribution from this migration. `docs/reference/migration-history.md` reaches the same
conclusion independently for `20260905090000`: it "needs its own restamp before it can be
applied."

They need a restamp either way, that restamp is owned by their own lanes and gated on
Mason's approval of their own money/date semantics, and holding a live inventory fix behind
that unrelated renumbering buys nothing. Recorded in the file itself as
`-- ordering-guard: ahead-of-pending …`, the guard's own documented escape hatch.

**Still owed, and not done here:** the seven parked migrations remain unappliable until
someone restamps them. That is unchanged by this work, but it is now the only thing standing
between them and production.

### Two proof gaps closed before applying (both from the rls-security review, MED)

- **Precondition** now pins the SECURITY DEFINER privilege contract — owner, `prosecdef`,
  and `search_path` — alongside the md5 body hash. `CREATE OR REPLACE` preserves all three,
  so a drifted owner would have been carried forward silently while the md5 still matched.
  For a SECURITY DEFINER function the owner *is* the privilege boundary.
  `20260831212415:339-344` pinned `prosecdef`/`proconfig`; this file had dropped both.
- **Postcondition** now proves the two revision-less siblings that reach the same
  inventory-writing path — `_complete_cycle_count_pre_revision_20260831` (the old wrapper,
  still live under a rename, with no revision parameter) and `_complete_cycle_count_impl` —
  are unreachable by `PUBLIC`, `anon` or `authenticated`, using the same paired direct-ACL +
  role-membership check the file already applies to the wrapper. Either being reachable
  would bypass this migration's entire purpose with every other check still green.
  `service_role` is deliberately still permitted on the impl; it holds EXECUTE there today
  and is not a browser-reachable role.

Three LOW items were documented in the file rather than fixed, with the reasoning recorded:
the md5 pin is over the LF-normalized body (the CRLF working-tree hash is
`1d8a95b5ca88348d415b96b08ea0f3fa` and would read as a mismatch); the absence of
`SET LOCAL lock_timeout` is deliberate for a `pg_proc`-only change; and a pre-existing
null-revision idempotency receipt becomes unredeemable, which is the fail-closed direction
and has no money or inventory effect.

### Review and proof

- `migration-drift-reviewer`: **0 blockers, 0 high, 0 med, 4 low**. Independently recomputed
  the body md5 as `6d1cab7c4298de34341d517265499896`, mechanically diffed the two function
  bodies and confirmed exactly the two intended hunks and no third, and traced the full
  seven-migration `complete_cycle_count` lineage to prove a second overload cannot be
  created.
- `rls-security-reviewer`: **0 blockers, 0 high**, the 2 MED above (both fixed), 3 LOW.
- Codex `gpt-5.6-sol` high-effort apply proofs minted against the final file by
  `scripts/write-apply-proofs.mjs`; the wrapper mints nothing without a CLEAN machine
  verdict.

### Live verification, read-only, 2026-09-08 before the apply

Body md5 matched the pin exactly; exactly one `complete_cycle_count` overload; owner
`postgres`, `prosecdef` true, `search_path=public, pg_temp`; grants
`{postgres, authenticated, service_role}` with no `anon` and no `PUBLIC`; both siblings
locked down (`impl` = `{postgres, service_role}`, pre-revision wrapper = `{postgres}`); and
**no other database function calls `complete_cycle_count`** — the only non-frontend caller
anywhere is `scripts/smoke/smoke-cycle-count-concurrency-guards.sql`, which passes the
revision positionally from a `NOT NULL DEFAULT 0` column.

### The apply, and what was observed afterwards

Applied 2026-09-08 via `scripts/apply-migration-file.mjs --confirm` (the MCP `apply_migration`
path is dead against the guard). All five gates passed — ordering, autopilot state,
destructive-content, reviewer proof and Codex gate. `APPLY OK — HTTP 201`. Ledger went from
1000 to **1001 rows**; the row landed as version **`20260909023300`** under the name
`20260908120000_close_pr535_live_gaps`, so the disk filename is kept per the B7 rule.

**Verified from the live catalog, not from the HTTP 201:**

| Check | Result |
|---|---|
| `complete_cycle_count` overloads | 1, and it is the 4-argument form |
| Body md5 | `ad7249f15027bd75084cb0cfbf8b6bab` (was `6d1cab7c4298de34341d517265499896`) |
| `CYCLE_COUNT_REVISION_REQUIRED` present | yes |
| `p_expected_item_revision IS NOT NULL` bypass | **gone** |
| `prosecdef` / `search_path` | true / `public, pg_temp` |
| ACL | `{postgres, authenticated, service_role}` — no `anon`, no `PUBLIC` |
| `trg_bump_cycle_count_item_revision` | present, enabled |

A scoped invariant sweep over all nine `%cycle_count%` functions found **zero** anon-executable
SECDEF functions, **zero** missing `search_path`, and both private implementations
(`_complete_cycle_count_impl`, `_reverse_completed_cycle_count_impl`) plus the renamed
pre-revision wrapper unreachable by `authenticated`. The pre/postcondition blocks also ran inside
the apply transaction, so any failed assertion would have rolled the apply back and left no ledger
row — the row exists, so they passed against live.

**Not verified, stated plainly:** the refusal was not exercised at runtime against production. Doing
so would require an authenticated admin session and would move real inventory, so it was
deliberately not attempted. What is proven is the installed contract — the refusal exists in the
installed body, the bypass does not, and no revision-less sibling is reachable by a browser role.
The full 29-predicate repo-wide invariant sweep was also not run: most of its predicates use
catalog functions the MCP read-guard blocks, and it is a repo-wide audit rather than a check of
this change. The scoped equivalent above covers this migration's surface.
