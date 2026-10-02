## 2026-09-30 — owner approval route: Codex GitHub review fixes (PR #845)

- **P1, keep the current-conversation approval.** The Windows Hello signature is required IN
  ADDITION to Mason's explicit yes in the current conversation (AGENTS.md hard gate), never instead
  of it. The following now say that both are needed:
  - DECISION_LOG, OWNER_PLAYBOOK, DATABASE_CHANGE_CHECKLIST and ship.md;
  - the create-migration skill and its Codex mirror;
  - the apply guard's refusal text and the header of `owner-approve-migration.mjs`.

  The gate can verify only the signature; the chat yes stays the agent's obligation.
- **P2, real key rotation.**
  - `owner-approval-hello.ps1` gains a `Replace` mode (`KeyCredentialCreationOption::ReplaceExisting`,
    a Windows Hello prompt).
  - `owner-approval-setup.mjs --new-key` uses it, so a rotation creates a new key instead of
    re-pinning the old one.
  - Without the flag, a key left by an interrupted setup is still reused.
  - Setup still refuses while a key is pinned, and rejects unknown options. Both were run on the PC;
    both refused with no prompt.
