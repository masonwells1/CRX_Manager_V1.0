## 2026-09-24 — a same-name ledger row is spent before a bare-stamp row, so it cannot vouch for a file it is no evidence for

PR #792 review round (CodeRabbit: one Major, nothing else). Addressed. No migration SQL and no
product code changed.

## Major — the bare row was consumed first, freeing the same-name row to vouch elsewhere

`matchStampEvidence()` built each file's candidate rows in ledger order and mixed two kinds of
evidence in one list: a row whose slug NAMES the file, and a bare-stamp row that merely shares its
14-digit number. Order decides which row the file spends, and spending the bare row leaves the
same-name row unspent — still counted in `slugCounts` — so the slug fallback then vouches for a
DIFFERENT file that row is no evidence for at all.

Measured on CodeRabbit's own input, ledger rows `20260905100000` (bare) and
`20260910000000_20260905100000_shared` (renumbered, carries the earlier stamp AND the slug):

```
row0: stamps=["20260905100000"]                    slug="20260905100000"  identifying=""
row1: stamps=["20260910000000","20260905100000"]   slug="shared"          identifying="shared"
slugCounts: [["20260905100000",1],["shared",1]]
```

`20260905100000_shared.sql` took **row0**. Row1's `shared` budget stayed unspent, so
`20260905200000_shared.sql` — which neither row carries a stamp for — was treated as applied. Through
the real guard, with a later candidate so the unevidenced file is genuinely in the way:

```
BEFORE  candidate 20260906000000_next.sql   ok=true   pending=[]
AFTER   candidate 20260906000000_next.sql   ok=false  pending=["20260905200000_shared"]
```

That is the stranding this module exists to prevent, reached through the module's own attribution.
Same family as the #791 Major (one row settling two files) and its predecessors: each time, evidence
that was *compatible* with a file was accepted as evidence *for* it.

Exact-slug edges are now always offered before bare-stamp edges. The edge SET is unchanged, so the
matching's cardinality is unchanged and the fix cannot over-abstain — only which row a file spends
changes, and with it which slug budget is correctly charged. When a bare row is the only evidence, it
still settles the file.

`.claude/hooks/migration-pending-lib.test.mjs`: **70 assertions** (was 66). Proven backwards by
installing the pre-fix order as a mutant — `const edges = [...bare, ...exact]` — and observing the new
assertion fail by name:

```
AssertionError: a file spends the row that NAMES it, not the bare-stamp row that merely shares its number
```

CodeRabbit also noted that `src/lib/rpcContracts.test.ts` exercises this helper. It does — verified,
and it is one of the three importers alongside `.claude/hooks/migration-apply-lib.mjs`, the real
production consumer. The full vitest suite covers it.

## Proof

- `.claude/hooks/migration-pending-lib.test.mjs` — **70 assertions**; Major proven backwards through
  `checkPendingMigrations()`, plus a mutant that fails the new assertion.
- The #791 fix re-proven live at this head against the real function, not a summary:
  `PREV ok=true pending=[]` → `NOW ok=false pending=["20260905200000_shared"]`, control `two rows -> ok=true`.
- `ACTOR_ALLOWLIST_MATCH_PASS` — **548 assertions**.
- `typecheck`, `lint`, `npx vitest run` (**5,448 passed** / 123 skipped, 381 files), `build`,
  `test:predicate-fingerprints`, `test:agent-workflows` (37 Codex adapters synced), `check:docs` all green.

## Live impact

**None.** All four field-season candidates remain LOCAL CANDIDATE / UNAPPLIED. The change makes a
local pre-apply guard refuse in a case where it previously waved work through.
