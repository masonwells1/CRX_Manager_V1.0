## 2026-09-07 — replaying the hold migration could silently revert a later security hotfix

Second finding from the independent `gpt-5.6-sol` review of PR #624, verified in source and then
by execution against a real PostgreSQL container.

### The defect

`20260908130000_bind_create_inventory_hold_receipt_to_intent.sql` is deliberately re-runnable.
On a re-run its preflight decided "the wrapper is already installed" by looking for the string
`check_idempotency_intent` in the live function body — a **marker**, not the body itself — and
then hashed only the *private implementation*. The file then unconditionally
`CREATE OR REPLACE FUNCTION`s the public wrapper.

So any later hotfix to the wrapper — a tightened role gate, an actor-binding fix, another force
or idempotency correction — would keep calling `check_idempotency_intent`, satisfy the marker
check, and be **silently reverted** by replaying this file. The preflight would report success
while undoing a security fix.

This is the same class the repo already accepted and fixed once: migration-history row 873's
"silent-clobber on replay", fixed there by pinning both ends.

### The fix

On the re-run path only, pin the wrapper's exact body:

- `v_wrapper_pin` holds the sha256 of this file's own wrapper body. The constant lives in the
  preflight block, **not** inside the wrapper body, so declaring it does not change the value it
  pins.
- The comparison hashes `replace(prosrc, E'\r\n', E'\n')`, so a CRLF checkout and an LF checkout
  produce the same digest. That deliberately avoids the EOL fragility that forced several earlier
  migrations into `.gitattributes` LF pins.
- A mismatch raises `PREFLIGHT_WRAPPER_DRIFT` naming both digests, and refuses rather than
  replacing.

First-time apply is untouched — the pin is only consulted when the private implementation already
exists, which is exactly the replay case.

### Proof observed — three container runs

`scripts/smoke/prove-create-inventory-hold-intent-binding-real-schema.mjs`, network-disabled
PostgreSQL 17 from the 2026-07-27 production baseline plus 76 replayed migrations:

1. **Correct pin** — `CREATE_INVENTORY_HOLD_INTENT_REAL_SCHEMA_PASS … rerun=PASS`. The pin
   validates against the body Postgres actually stored, EOL handling included, so it is verified
   against reality rather than recomputed from the same file that wrote it.
2. **Installed body ≠ pin** (the hotfix case, simulated by pinning a digest the installed body
   does not carry) — the replay refuses:
   `PREFLIGHT_WRAPPER_DRIFT: create_inventory_hold is the intent wrapper but its body is
   3089caa0…, not the deadbeef… this file emits.` The first apply still succeeded in that same
   run, confirming the guard gates replay only.
3. **Correct pin restored** — `REAL_SCHEMA_PASS … rerun=PASS` again.

Static mutation coverage in `src/lib/createInventoryHoldIntentBinding.test.ts` fails the contract
if either the pin comparison or the `PREFLIGHT_WRAPPER_DRIFT` raise is downgraded.

### One review finding deliberately NOT actioned

The same review reported a MEDIUM claiming this branch downgrades Supabase auth, Sentry, Playwright
and lint/build dependencies and rolls back 46 lockfile entries. **That was a false positive caused
by review staleness, not a defect.** This branch changes no dependency file: `git diff
origin/main...HEAD -- package.json package-lock.json` is empty. `main` merged the dependency bump
(#628) while the ~25-minute review was running, so the reviewer compared a newer base against this
slightly older tree and read the age gap as a rollback. `main` has since been merged again and the
dependency files are now identical to it.

The same mechanism produced the previous round's HIGH about `.claude/hooks/autopilot-lib.mjs`
"reverting" the armed-mode parser: that fix (#607) landed on `main` mid-review, this branch never
touched the file, and merging `main` resolved it. **When a review flags a file the diff does not
touch, check whether `main` moved before treating it as a regression.**

### Not verified

The live apply and everything downstream. The migration is still **NOT applied**. Its body changed
again in this entry, so the 2026-09-06 read-only production preflight is older than the current
file and must be re-read immediately before any apply.
