## 2026-09-30 — field-season delivery merges before its four migrations install

Mason, in chat on 2026-09-30: "focus on getting 843 clear and merging then we will do 845".

- The delivery PR now merges FIRST. `CURRENT_STATE.md` and `KNOWN_ISSUES.md` no longer say it
  must stay open until `20260914101000`..`20260914101300` apply.
- **Why it is safe:**
  - The app changes are backward-compatible. They add a client-side filed-season date guard and
    plain-English error mapping, and read only existing columns.
  - The landing gate needs the migration committed at the HEAD of an open, approved, Sol-cleared PR,
    not the PR that introduced it. `20260914100900` was applied that way.
- The four migrations will install from the owner-approval PR's checkout (#845, which carries the
  Windows Hello route that `101000` needs) after main is merged into it.
- Until `20260914101300` is live, no PR adding a new migration may merge or apply. The #800 hold
  stays.
- This branch (lap20) = #843's head `a3acffc80` plus `origin/main` (including the #844 audit fix),
  plus the quiet-database pre-check doc for `101300`. Checks run on it:
  - typecheck, lint, the full vitest suite, `test:correction-guards` and `test:agent-workflows`
    all pass;
  - `npm audit --audit-level=high` passes;
  - `npm run proof:field-app-season` passed before the #844 merge (`PREVIEW_SEASON_PROOF_PASS`,
    `RECEIPT_GATE_NARROWING_PROOF_PASS`).
