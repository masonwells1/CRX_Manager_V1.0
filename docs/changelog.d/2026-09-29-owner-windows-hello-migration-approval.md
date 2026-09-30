## 2026-09-29 — Mason approves parked migrations with Windows Hello

**Why.** The apply gate parks three kinds of migration for Mason: one that deletes data, one that
overwrites existing rows, and one that changes who can access what. Until now nothing could apply
them. Agents had no override, and the only route left to Mason was pasting SQL into the Supabase
Dashboard, which the database checklist forbids. That blocked the field-season install
`20260914101000` (access-change). Mason approved the design on 2026-09-29, "approved all three".

**What changed.**
- `.claude/hooks/owner-approval-lib.mjs` (new) builds and verifies the approval Mason signs:
  - the migration name and the sha256 of its SQL;
  - the PR number and exact head;
  - the flagged categories;
  - a 30-minute window and a nonce;
  - the plain-English summary he is shown, which the verifier recomputes from the signed fields.
  The pinned key must equal the key Windows Hello holds on the PC at that moment.
- `.claude/hooks/owner-approval-hello.ps1` (new) handles Windows Hello: it creates the key, reads its
  public half, and shows the summary before asking for his PIN or fingerprint to sign.
- `.claude/hooks/migration-apply-lib.mjs`:
  - a parked migration now looks for an approval, but only when the caller is the apply script
    (`ownerApprovalDoor`);
  - the approval is verified LAST, after the reviewer proofs, the Sol proof and the landing gate;
  - the three classifiers moved into `parkedCategories` (same reasons, same order).
- `scripts/apply-migration-file.mjs` passes `ownerApprovalDoor` and records the approval as used
  before transmitting.
- New commands:
  - `scripts/owner-approval-setup.mjs`: one time, with a self-test signature;
  - `scripts/owner-approve-migration.mjs`: per migration.
- `codex-push-lib.mjs` `RISKY_PATH_RES` now includes the apply script and both commands.
  `package.json` runs the new test in `test:correction-guards`.
- Docs: the OWNER_PLAYBOOK:90 vs DATABASE_CHANGE_CHECKLIST:139 conflict is resolved. The playbook
  no longer sends Mason to the Dashboard. Also updated: ship.md, DEPLOYMENT.md, the DECISION_LOG
  entry, agent-guardrails, and the create-migration, deploy-check and new-rpc skills. AGENTS.md is
  unchanged: it has no room under its startup-context byte budget, and the guard enforces the rule.

**Proof observed.**
- `owner-approval-lib.test.mjs`: 41 assertions. Each check refuses when broken, including:
  - another key's signature;
  - an edited payload;
  - a pinned key that is not the Windows key;
  - another migration, SQL, PR or head;
  - a category Mason was not shown;
  - a misleading summary;
  - an expired, future-dated, over-long or already-used approval;
  - an already-applied migration.
- `migration-apply-lib.test.mjs`: 290 assertions (270 before).
  - For each of the three kinds, a valid approval is allowed through the apply script's door.
  - The MCP door is still refused.
  - An approval never skips the reviewer proof or the landing gate.
- Mutation check: disabling each of the signature, key-match, expiry, nonce and summary checks, the
  door check and the final verification made the tests fail.
- The Windows Hello helper's PublicKey mode ran on Mason's PC (NotFound before setup).

**Not verified here.** The real Windows Hello key creation and signature need Mason at the PC
(`node scripts/owner-approval-setup.mjs`). Its self-test proves that the signature format matches
the verifier. Nothing was applied to the live database.
