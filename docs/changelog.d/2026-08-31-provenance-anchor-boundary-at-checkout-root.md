## 2026-08-31 — the provenance boundary was anchored in the wrong place

Third round on the migration source-provenance gate. The exact-SHA `gpt-5.6-sol`
high-effort review of `6be98280` returned **BLOCKED** with a **High** finding, and it was a
real bypass in code I had already called clean twice.

**The hole.** `resolveMigrationSource()` resolved the migrations directory and the candidate
file, then asked whether the file sat inside the directory. Make
`supabase/migrations` **itself** a symlink or junction pointing at an outside directory and
both sides resolve outside *together* — containment holds, and parked SQL is admitted. The
per-file symlink test I had added covered a link at the *file*, never a redirected
*directory*.

**Worse, the comment defended the hole.** It justified resolving both sides as
junction-tolerance, "because that is how this machine is actually laid out." The tolerance was
real; anchoring it at the directory is what made it exploitable. This is the 2026-08-26
`DECISION_LOG` lesson word for word: *a closed allowlist is only as good as its boundaries,
and the first question is not what the region contains but where the trusted chain actually
begins.*

**The fix.** The chain begins at the **checkout root**. Resolve that — which is what genuinely
absorbs a junctioned worktree, since the junction is on the root where it actually is — then
require the real migrations directory to equal `<real-root>/supabase/migrations` exactly. The
per-file containment check stays, because it covers the case the directory check does not.

**Proof observed.**

- **The redirected-directory case really runs on this machine.** A Windows *junction* needs
  no elevation (unlike a file symlink), so unlike the earlier symlink case this one executes
  rather than skipping.
- **Mutation-checked:** disabling the new root-anchor comparison turns that case red with
  `got allow` — reproducing exactly the bypass Codex described, which is what proves the hole
  was reachable and the fix closes it.
- **The mirror case is load-bearing:** a checkout reached *through* a junction still passes,
  so the rule is not simply refusing every resolved path and breaking the real layout.
- `migration-apply-lib.test.mjs` 163 → **166**; `migration-apply-guard.test.mjs` 107.
- Real path, read-only: a parked wave-A migration is still refused by name, and a pending
  return-credit migration still passes provenance and advances to the ordering gate.

**The review's second finding was a false positive, and is recorded as such.** It reported the
candidate "rolling approved schema evidence backward" — `.claude/schema-registry.json` and
`src/lib/drawDownQuoteIntentBindingMigration.test.ts`. Neither file is touched by any commit
on this branch. PR #531 (`5258b0f22`) landed on `origin/main` after this branch was cut and
changed exactly those files, so the branch was simply one commit behind and the wrapper read
main's newer content as a regression. Verified with `git diff --name-only b5f67fa9d..HEAD`
(ten files, neither of them) against `git diff --name-only b5f67fa9d..origin/main`. The fix is
to rebase, not to "preserve base state" — done here. This is the recorded stale-base trap;
it is worth re-stating because the finding was labelled Blocker and reads convincingly.

**Not verified.** The file-level symlink case still skips on this machine (elevation
required); only the directory-junction path executes here.
