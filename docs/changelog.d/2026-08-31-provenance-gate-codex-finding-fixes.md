## 2026-08-31 — two Codex findings on the provenance gate, and what they teach

Follow-up to `2026-08-31-migration-source-provenance-allowlist.md`. The exact-SHA
`gpt-5.6-sol` high-effort review of `f498c473` returned **CLEAN — no blocker or
high-severity findings**, having verified 2,892 candidate files against their SHA-256
manifests and confirmed no migration, SQL, money, RLS, RPC, grant, or secret change was
added. Both of its minor findings were real. This commit fixes them.

**1. A new gate can make an old test pass for the wrong reason.**

The expired-autopilot and malformed-autopilot cases in `migration-apply-guard.test.mjs`
transmit destructive SQL, but the fixture's migration file still held *benign* SQL. The new
source-provenance rule therefore refused on content-mismatch **before** the autopilot rule
was ever reached. Both cases stayed green — and would have gone on being green straight
through an autopilot regression, because the thing they name was no longer being exercised.

This is the general hazard of inserting a check early in a chain, and it is worth stating
beyond this instance: **every downstream test that does not supply the new precondition
silently stops testing what its name says.** The suite does not get louder when this
happens; it gets quieter, and stays green. The fix is not just to repair these two cases but
to assert the *reason* for the refusal, so a future short-circuit fails loudly instead of
passing.

Both cases now write the destructive SQL to the fixture's migration file and assert the
`LAPSED` message, not merely that a denial occurred.

**2. The evidence claim outran the evidence.**

The previous changelog entry asserted a symlink-escape regression test that did not exist.
Codex checked the claim against the tree and found nothing behind it. The test now exists —
and it **skips on this machine**, because Windows requires Developer Mode or elevation to
create a symlink. It prints `SKIP symlink-escape case` rather than passing silently, so a
case that cannot run is never counted as one that succeeded, and the containment logic it
targets is recorded as **unverified by execution here**. It will run wherever symlink creation
is permitted.

**Superseded description, corrected 2026-08-31 (CodeRabbit, PR #533):** this entry originally
called that logic "`realpathSync` on both the directory and the file". That was the *first*
implementation and it was the bypass Codex found in the next round — a redirected migrations
directory made both sides resolve outside together. The shipped rule resolves the **checkout
root**, requires the real migrations directory to equal `<real-root>/supabase/migrations`, and
then requires the real migration file to sit inside it. See
`2026-08-31-provenance-anchor-boundary-at-checkout-root.md`.

**Proof observed.**

- Mutation check on fix 1: restoring the benign fixture file turns the new `LAPSED`
  assertion red with the provenance message, which is what proves the repaired fixture is
  doing the work rather than passing incidentally.
- `migration-apply-guard.test.mjs` 105 → **107** assertions; `migration-apply-lib.test.mjs`
  163; `guards.test.mjs` 168 — all green.
- The stated suite count in the previous entry (105) is corrected to 107 there.

**Not verified.** The symlink case did not execute on this machine, as described above. The
new head SHA invalidates the `f498c473` proof, so a fresh exact-SHA review is required before
this branch can be pushed; that is the standing rule, not an exception being made here.
