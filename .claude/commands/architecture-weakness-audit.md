Run the **architecture-weakness audit** — a read-only review that walks **every connection** in the app-workflow-map and judges each for **fragility** (not consistency, not correctness): single points of failure, double-submit gaps, silent failures, race conditions, non-atomic flows, missing reversals, and missing defensive wiring.

It is **read-only**: it analyzes and writes ONE report file. It does not edit code, apply migrations, deploy, or commit.

## The single source of truth

The full, canonical instructions live in **`docs/audits/architecture-weakness-audit-prompt.md`** — read that file and execute it exactly. Do NOT paraphrase or duplicate its steps here (a second copy would drift).

In summary, that prompt makes you walk the map's full node + connection inventory (regenerated each run — counts come from the map, not from here) as a worklist and run **7 weakness passes** against the live DB (project `rhyzpcqhnizqbxphqdkr`) + `src/`:

1. SPOFs (fan-in blast radius) · 2. double-submit / idempotency · 3. silent failures · 4. race / concurrency · 5. atomicity of multi-write flows · 6. missing reversals · 7. missing defensive connections.

- Every finding states a **concrete failure scenario** ("if two reps click X within a second…") + a hard citation, and must survive an **adversarial verify-before-report gate** (try to refute it against live first).
- Write ONE dated report: `docs/audits/<YYYY-MM-DD>-architecture-weakness-audit.md` (real clock for the date — never fabricate).

## Hard rules (from the prompt)

- **Read-only.** No `Edit`/`Write` except the one report file. No `apply_migration`, deploy, or `git commit`.
- **A clean / "ROBUST" result is valid** — do not manufacture findings.
- **Stay on FRAGILITY.** Consistency (map-vs-reality) is `/map-drift-audit`; correctness/stranded-entities is `/review-workflow`. Don't re-run those here.

## After the report

Give Mason a 5-line summary — verdict, counts by severity, the single most dangerous weakness (or "robust"), and the suggested next step — and remind him nothing was changed (read-only). If the top finding is a money double-submit or a missing reversal, say so plainly.
