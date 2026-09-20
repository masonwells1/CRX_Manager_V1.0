## 2026-09-20 — adjust_inventory refuses control-character idempotency keys (LOCAL CANDIDATE, not applied)

New migration `supabase/migrations/20260911130000_refuse_control_character_adjust_inventory_keys.sql`,
**not applied**. It finishes the review round left open when
`20260911120000_bind_adjust_inventory_receipt_to_intent` went live on 2026-09-20 (ledger version
`20260920052149`) and merged as `17826e9c3` — that delivery shipped the body as reviewed, so the two
later `gpt-5.6-sol` LOW findings were never in it.

### What was wrong

The live key check refuses a key only when it carries **no** printable ASCII character:

```
IF p_idempotency_key IS NULL
   OR p_idempotency_key !~ '[^[:space:]]'
   OR p_idempotency_key COLLATE "C" !~ '[!-~]' THEN
```

Its comment claimed it refused "non-printable" keys. It does not. A UUID with a trailing newline
carries 36 printable characters, satisfies the test, and is accepted — so a control character can
reach the receipt table, the error text and the logs.

**This is a hygiene gap, not a live defect, and the migration says so.** Both browser callers derive
the key from `crypto.randomUUID()`, which cannot produce a control character, and by the time this
line runs the caller is already an authenticated active admin. A read-only count on live on
2026-09-20 found **zero** `adjust_inventory` receipts of any kind.

### What changed

One block of the body, and nothing else. A line-level diff of the emitted body against the installed
body shows a single changed hunk: the check gains
`OR p_idempotency_key COLLATE "C" ~ '[[:cntrl:]]'` and the comment is corrected. The fingerprint,
the `check_idempotency_intent` call, the stock math, the ledger row and the bound receipt insert are
reproduced byte-for-byte.

**Scope, stated as measured — and the first draft of this got it wrong.** I originally wrote that C1
controls still pass. They do not. Measured on PostgreSQL 17 and confirmed read-only against live on
2026-09-20, `[[:cntrl:]]` matches 64 code points in two ranges: **U+0001–U+001F, DEL (U+007F), and
the whole C1 block U+0080–U+009F**. So C1 controls ARE refused. What is not refused, and still
passes when the key also carries a printable ASCII character: NBSP (U+00A0), ZWSP (U+200B), BOM
(U+FEFF), U+2028 and the soft hyphen.

That error is worth naming rather than quietly fixing: this migration exists *because* a comment
about this exact check was inaccurate, and the first correction was inaccurate in the other
direction. The smoke chain now pins **both** edges — a U+0085 NEL key must be refused, and an NBSP
key (one code point above the C1 block) must be accepted — so neither version of the mistake can
return silently.

The `COLLATE "C"` is defensive pinning, not the cause of that set: the class matches the same 64
code points under the database default collation, because PostgreSQL hardwires the POSIX class
ranges.

**One test is now redundant, and the body says which one.** `!~ '[^[:space:]]'` is subsumed by
`COLLATE "C" !~ '[!-~]'`, because `[!-~]` excludes the space. A comment marks the subsumed line as
the safe one to delete — removing the `[!-~]` line instead would reopen the hole it closes, a key
made only of non-ASCII text.

**A second finding, postflight only.** The postflight asserted `AUTH_REQUIRED` appears *before* the
receipt lookup by comparing `position()` values. `position()` returns 0 for an absent token, and 0
is never greater than a positive position, so a body that never authenticated at all would have
passed. The new postflight tests presence first, separately.

**No cutover lock, deliberately.** `20260911120000` took
`LOCK TABLE public.idempotency_keys IN ACCESS EXCLUSIVE MODE` because the body it replaced wrote
unbound receipts, and that lock stalls every mutating RPC in the app — all of them are keyed and all
touch that table. Here the installed body already writes bound receipts and the cutover trigger
already exists, so a call in flight during this swap is harmless. **This migration takes no table
lock and does not pause saving in the app.**

**Residual, carried forward unchanged.** A NaN already stored in `inventory.quantity_available` is
not repaired by this migration or by `20260911120000`. Both refuse a NaN or infinite delta going
forward, but the column has no CHECK, so a value written by the pre-2026-09-11 body keeps
propagating. The structural fix is the parked
`scripts/.staging-migrations/20260813030000_reject_non_finite_money_and_quantities.sql`.

### Corrected count: eight `20260914100*` migrations, not seven

PR #704 restamped exactly **seven** files (`20260914100100`, `100200`, `100300`, `100400`, `100500`,
`100600`, `100900`) — confirmed from #704's own file list. The **band** holds **eight**, because PR
#721 later added `20260914100800_bind_transfer_invoice_intent`. Writing the band as the range
`20260914100100`..`20260914100900` while calling it seven undercounts it, and a reader ordering work
by that range would miss `100800`. Corrected in
`docs/changelog.d/2026-09-11-adjust-inventory-receipt-intent-binding.md` and
`docs/manual/CURRENT_STATE.md`. The same loose phrasing survives in three historical entries
(`2026-09-15-create-inventory-hold-receipt-binding-applied-live.md`,
`2026-09-17-schema-registry-refresh-after-restamp.md` twice); those record what those deliveries
proved at the time and are left as history rather than rewritten.

### Stamp: `20260911130000`, deliberately below that band

A first draft stamped this `20260920120000` and claimed that sorting above the band "adds no
ordering constraint of its own." That is backwards, and the migration-drift review caught it.
Sorting **above** the band is exactly what creates a constraint: the pending-set guard in
`.claude/hooks/migration-pending-lib.mjs` refuses an apply while any **older** migration is still
pending, and all eight are. `scripts/apply-migration-file.mjs` — the path this changelog tells you
to use — is precisely the one that would have blocked.

Both escapes were bad. Applying the eight first means waiting on work that is itself blocked. Adding
an `ordering-guard: ahead-of-pending` marker raises the effective high-water and **strands all
eight**, forcing a ninth restamp round — a real cost, for a hygiene fix with zero affected live
receipts.

Stamping below the band needs neither. Measured 2026-09-20: **zero** migrations on disk sort between
`20260911120000` and `20260914100100`, so `20260911130000` lands in an empty gap. It sorts above the
live effective high-water `20260911120000` (so it is discovered, not skipped) and below all eight
(so nothing is stranded, and the band still applies in its own order afterwards). This is the same
technique, for the same reason, as `20260908140000`.

### Proof

`node scripts/smoke/prove-adjust-inventory-control-character-keys.mjs` — network-disabled throwaway
Supabase PostgreSQL 17 container on the checked-in 2026-07-27 baseline plus **97** ordered
post-baseline migrations, ending in `ADJUST_INVENTORY_CONTROL_CHAR_PASS`:

- the replayed `adjust_inventory` body is `9a503e54…`, **byte-identical to what production runs** —
  so the container starts from the real thing, not an approximation;
- **the gap, before:** a key of `'prover-ctrl-' || chr(10)` was ACCEPTED by the installed body and
  moved stock to 105;
- **scope confirmed:** a non-ASCII-only key was ALREADY refused before the candidate, so the
  control-character case is genuinely the only new refusal;
- the chain fails against the installed body (`SMOKE_FAIL: a key carrying a newline was accepted`);
- the candidate REFUSES to apply while an unexpired control-character receipt exists
  (`PREFLIGHT_STRANDED_RECEIPTS`), leaving the body untouched;
- **two mutations, judged from the pre-candidate state** — ordering that matters, because after the
  real apply a mutant is stopped by the preflight body check and never reaches the assertion under
  test: removing the clause is caught by `POSTFLIGHT_BODY_PIN`; removing it *and* recomputing both
  pins so every hash check passes is still caught by `POSTFLIGHT_CONTROL_CHAR`, proving that named
  assertion stands on its own rather than restating the pin;
- **the gap, after:** the same key is refused with `IDEMPOTENCY_KEY_REQUIRED`, stock held, no ledger
  row, no receipt — while an ordinary key still adjusts normally;
- the chain reaches `SMOKE_PASS_ROLLBACK`, the candidate re-applies cleanly via the re-run pin path,
  and the chain still passes.

The prover **exits non-zero on failure**, observed directly: two earlier runs of it failed and
returned exit code 1.

**A correction to a claim this project has repeated more than once.** Earlier notes (including the
brief for this work) said row 930's prover "prints its FAIL token and still exits 0", and a separate
task was opened to fix that. It is not true — that prover sets `process.exitCode = 1` at its line
407, exactly as this one does. The real cause is invocation: `node prover.mjs | tail` reports
**tail's** exit status, not node's, so `$?` reads 0 no matter what the prover did. Measured:
`node -e "process.exitCode = 1"` exits 1; the same command piped to `tail` exits 0. Run a prover
unpiped if you intend to read `$?`. The separate fail-open task is chasing a bug that does not
exist and should be closed.

Still required before any live apply: a fresh exact-SHA `gpt-5.6-sol` review of the final head, and
Mason's explicit approval in chat. Apply through `scripts/apply-migration-file.mjs` (dry run, then
`--confirm`), never MCP `apply_migration`.
