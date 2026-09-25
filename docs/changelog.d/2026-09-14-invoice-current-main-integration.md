## 2026-09-14 - Integrate invoice protection with completed inventory delivery

Bring the isolated invoice-season protection candidate up to actual main after
inventory PR #691 merged as `49727803ddb224d5d621e74815cafb229ae68c8e`.
Preserve the completed inventory runtime, retry identities, smoke registration,
and parked SQL. No runtime source conflict occurred during integration.

Resolve the migration-history entry collision by preserving inventory entry 927
and assigning the four unapplied invoice candidates entries 928 through 931.
Only documentation entry numbers change: SQL filenames and contents are unchanged.
The four invoice migrations and the inventory migration remain unapplied.

Integrated correction checks reproduced a missing hash binding on the newest
invoice correction's history row. Add its verified canonical LF SHA-256 to entry
931, without modifying SQL. Preserve the registry's fail-closed acceptance rules;
improve its mismatch diagnostic to name the unverified file and add a regression
asserting that the named missing candidate is still rejected.

Fresh integrated-source verification, exact-head independent Codex and Claude
reviews, current CI, and authenticated exact-head CodeRabbit approval remain
required before protected delivery. This entry records integration, not review
clearance, live application, or deployment.
