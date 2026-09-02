## 2026-09-02 — CI's dependency audit failed only on CRITICAL, so a live HIGH sat on main with a green pipeline

`npm audit --audit-level=critical` in the "Check for vulnerable dependencies" step meant a
**high**-severity advisory passed the gate silently. This was not theoretical: on the morning of
2026-09-02, `browserslist <=4.28.6` (GHSA-c83g-rgw3-j3cx, unbounded memory growth → OOM; plus
GHSA-73wf-gq98-2v4g, prototype write via untrusted `browserslist-stats.json`) was live on `main`
with CI green. Every `git push` printed
`GitHub found 2 vulnerabilities on masonwells1/CRX_Manager_V1.0's default branch (1 high, 1 low)`
while the CI step that exists to catch exactly that reported success.

Raised to `--audit-level=high` on Mason's approval.

**Sequenced so there is no red window.** The raise was deliberately not made while the high advisory
was outstanding — that would have red-lined every open PR. Dependabot PR #554
(`bump browserslist from 4.28.6 to 4.28.8`) merged first and carries the fix. Verified against
current `main` (`91353629`) after `npm ci`: `npm audit --audit-level=high` exits 0, with a single
**moderate** advisory remaining (`@humanfs/node <0.16.8`, GHSA-p498-v437-472g) which the new
threshold correctly ignores.

The step comment records the rule this is meant to enforce: if a future PR goes red here, bump the
dependency or let the Dependabot PR land — do not lower the threshold back to `critical` to get green.

**Scope note.** This raises the floor from critical to high. Moderate and low advisories still pass,
which is deliberate — `@humanfs/node` is an ESLint transitive dev dependency and blocking the fleet
on it was not the ask. Dependabot security updates remain enabled, so those fixes still arrive as
their own PRs.

Unrelated to the merge-gate work in the same pull request; both came out of one audit of what GitHub
actually gates on a CRX pull request.
