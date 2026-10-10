## 2026-10-09 — Mason approves parked migrations by chat reply instead of Windows Hello

**Why.** Mason works mostly from his phone, and the Windows Hello approval (2026-09-29) needed him at
the PC: "I want to remove the windows hello thing … I don't want more restrictions and hoops, I want
less." He was told the trade-off below and replied "go - i accept the trade off".

**What changed.**
- `scripts/owner-approve-migration.mjs` no longer opens Windows Hello. From the file itself it builds
  the same request as before (migration name and SQL sha256, PR number and exact head, the flagged
  categories, a nonce) plus a 6-digit code and a 24-hour reply deadline. It saves the request in the
  checkout's `.claude/session-state/` and prints the plain-English summary, which ends with the exact
  reply. `--selftest` builds a request that approves nothing, to prove the reply path.
- `.claude/hooks/owner-approval-prompt.mjs` (new, wired in `prompt-router.mjs`): when Mason's WHOLE
  message is `approve <code>`, the pending request with that code, searched in every checkout of the
  repository, becomes an approval file stamped with the reply time. Any other message does nothing.
  A peer session's message (envelope or preamble), a subagent report, a quote, inline code, or a
  sentence around the reply never matches. A code pending in two checkouts approves neither.
- `owner-approval-lib.mjs`: the key, Windows Hello helper and signature checks are gone (purpose
  `…-v2`, so a v1 signed payload is refused). `verifyOwnerApproval` keeps every binding check (project,
  migration, sha256, PR, head, categories and reasons, summary, nonce, single use, live ledger). It
  adds: the reply came after the request and before its deadline, and the apply is within 30 minutes
  of the reply. `OWNER_TRUST_FILES` now lists the reply hook instead of the key and helper.
- `migration-apply-lib.mjs` and `apply-migration-file.mjs`: no key reading; messages describe the
  reply. The 30-minute re-check before transmission counts from the reply.
- Removed: `scripts/owner-approval-setup.mjs`, `.claude/hooks/owner-approval-hello.ps1` and
  `.claude/hooks/owner-approval-key.json` (the review-proof guard blocks agent deletes under
  `.claude/hooks`, so Mason ran that `git rm` himself).
- Docs: OWNER_PLAYBOOK, DATABASE_CHANGE_CHECKLIST, DEPLOYMENT.md, agent-guardrails, ship.md, the
  create-migration, deploy-check and new-rpc skills, and a DECISION_LOG entry that supersedes rule 1
  of the 2026-09-29 entry.

**Residual risk (accepted by Mason).** The reply stops a parked migration being applied by mistake,
on a misread handoff, or on a relayed "Mason said yes". It does not stop an agent that deliberately
writes the approval file itself. Agents run on his PC with his permissions, and only Windows Hello
could rule that out. The file sits in `.claude/session-state`, which the review-proof guard protects
like every other proof.

**Proof observed.**
- `owner-approval-lib.test.mjs`: 125 assertions. They include every verifier refusal, 21 messages
  that must not count as a reply (peer, quoted, code, longer sentences, wrong length), and the reply
  hook run as a real process alone and through `prompt-router.mjs`. In that run the recorded approval
  verifies at the apply, an unknown code is reported, and a peer's relayed reply records nothing.
- `migration-apply-lib.test.mjs`: 295 assertions (291 before). For each of the three kinds a valid
  reply approval passes the apply script's door. The MCP door still refuses, and an approval never
  skips the reviewer proof or the landing gate. An approval 30 minutes after the reply is refused.
- `npm run test:correction-guards` exits 0.

**Not verified here.** Nothing was applied to the live database.
