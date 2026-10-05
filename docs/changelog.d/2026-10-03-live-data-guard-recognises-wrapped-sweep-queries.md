## 2026-10-03 — the live-data guard recognises the sweep runner's own wrapped queries

`npm run db-sweeps` prints each predicate wrapped in an envelope that also reads the reviewed
function contracts (`buildSweepQuery`), and `--adjudicate` rejects any packet without them. The
live-data guard only recognised the BARE predicate files, so it refused all 29 wrapped queries (2 as
`audit-log-write`, 27 as `rpc-via-select` on `predicate()`, `oidvectortypes()` and the like). The
documented Claude/MCP sweep path in `ship.md` Step 5 and `codex-review` Step 2 could never produce
adjudicable packets.

- `.claude/hooks/live-testdata-lib.mjs` now defines the envelope (`renderSweepQuery`,
  `functionContractSql`); `scripts/db-invariant-sweeps/allowlist-match.mjs` imports it instead of
  keeping its own copy, so the template the guard trusts lives on the approval-gated hook surface.
- `isKnownSweepQuery` accepts a query only when the inner text is a fingerprinted predicate, the
  envelope's name is that predicate's own file name, every contract key is a plain
  `public.`/`auth.` identity signature with no quote or backslash, and rebuilding the envelope from
  those parts reproduces the query byte for byte (after the existing line-ending/BOM/trailing-space
  normalisation). Anything else falls through to the unchanged classifier.
- The generated fingerprint block is now a `Map` of fingerprint to file name
  (`KNOWN_SWEEP_PREDICATES`), and it is the ONLY list: `KNOWN_SWEEP_PREDICATE_SHA256` is removed, so
  both allowances and the generator's "overridden" check (hash and file together) read the same
  collection. A derived Set the generator did not watch was caught by Luna round 1.
- Contract keys accept any printable ASCII except `'` and `\` (schema-qualified argument types and
  quoted identifiers are valid identity signatures). The backslash exclusion is the load-bearing one:
  the rebuild doubles a quote but not a backslash.
- New test: no fingerprinted predicate has a line break inside a literal, quoted identifier or
  dollar-quoted body, which is what keeps the existing CRLF folding harmless (it then only touches
  whitespace and comment ends).

Proof observed:

- All 29 printed queries are byte-identical to a fresh `buildSweepQuery`. The reported "7 differ"
  (01, 02, 03, 05, 13, 28, 29) were the 7 predicates with allowlist entries, whose printed blocks are
  followed by `-- candidate exception keys` comment lines that the earlier comparison included.
  `npm run db-sweeps` output is unchanged byte for byte by this refactor.
- `predicate-fingerprints.test.mjs` (490 assertions) covers every wrapped query (LF, CRLF,
  no-contract form) and refuses near misses: an appended or prepended DELETE, trailing text,
  `EXPLAIN ANALYZE`, a spliced statement, one changed token or case, a wrong or unknown name, a
  semicolon left inside, an unknown predicate, hostile contract keys, reordered or repeated keys, and
  a changed contract query. A mutation run removing each of the four checks (rebuild equality, key
  charset, name binding, semicolon) fails the suite every time.
- Live, through the real hook: the wrapped `save-field-actor-binding` query ran via Supabase MCP
  `execute_sql`, and the same query with one alias changed was refused by the guard.
- `npm run test:correction-guards` and `npm run test:agent-workflows` pass.

Not verified here: see the PR for the final full 29-predicate adjudication result.
