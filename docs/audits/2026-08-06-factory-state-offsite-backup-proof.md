# Factory state off-site backup proof — 2026-08-06

## Scope

This is the non-secret proof that the shared `<git-common-dir>/crx-factory/`
state was added to Mason's existing nightly Personal DR path. The installed
Windows task remains outside the public repository because it also coordinates
machine-local secret backups. Its factory-specific entrypoint is the tracked
[`scripts/windows/stage-factory-state-for-personal-dr.ps1`](../../scripts/windows/stage-factory-state-for-personal-dr.ps1)
runner, which invokes `scripts/backup-factory-state.mjs` from a current CRX
checkout.

## Installed schedule

- Windows task: `Personal DR Backup`
- State observed during setup: enabled and ready
- Trigger: daily at 04:00 America/Chicago
- Installed task script: `C:\Users\mason\Scripts\personal_dr_backup.ps1`
- Permanent tracked-tool checkout:
  `C:\Users\mason\.codex\runtime\crx-factory-backup\CRX_Manager`
- The installed script selects that locked operational worktree first. It uses
  the primary `C:\CRX_Manager` checkout second and discovers another linked
  worktree only as a pre-deployment fallback. The operational worktree is
  created and locked at the reviewed commit before the temporary review
  worktree may be removed.
- Factory staging root: a unique `personal-dr-<timestamp>` directory under the
  operating-system temporary directory
- Destinations: local backup drive when connected, plus the existing
  client-side encrypted and Object-Locked Backblaze Personal DR remote

The installed script fails the run unless the remote copy is downloaded through
the encryption layer and its SHA-256 matches the local archive. Its `finally`
block removes plaintext staging, restore-expansion, and local archive files on
success or failure.

## Real-path proof

The setup run used the live shared factory directory through
`resolveFactoryPaths()` and observed:

- durable files captured: `39`
- durable bytes captured: `531502`
- ledger SHA-256:
  `b0ff0629ebc691789b53746142e4e09956d2454892174e08ce37779d89855adf`
- restored snapshot: factory reducer replay clean, not degraded
- encrypted remote object:
  `factory-state/20260806_051111/crx-factory-state-20260806_051111.zip`
- archive bytes: `115404`
- archive SHA-256 after downloading through the encrypted remote:
  `4f0615b0acb46cd5fff523fc2666a497a8a353f5b0fabf598dca77937ab06cf0`

No existing backup was pruned or overwritten by this proof run.

## Verification gates

- Source capture takes two matching, independently hashed reads before publish.
- Symbolic links, hard-linked files, special files, unsafe paths, unexpected
  restored files, size drift, hash drift, and manifest drift fail closed.
- A missing ledger fails before staging. Stable degraded or torn bytes are preserved
  with `replay_ok: false`, exit `4`, a high-priority alert, and a failed scheduled-task
  result so the forensic copy exists off-site but is never reported as clean.
- A clean ledger at or above 75% of the per-file safety limit returns exit `5`.
  The installed task still verifies and uploads it, then sends a high-priority
  capacity alert and fails instead of allowing the warning to remain hidden in logs.
- Staging is restricted to the operating-system temporary directory.
- The owner-receipt key and receipts are retained because historical replay
  requires them; ephemeral CLI permits and all coordination locks are excluded.
- The restored copy must pass the real factory reducer, not only manifest hashes.
- Governed restore instructions live in
  `docs/workflows/GOVERNED_DELIVERY_PIPELINE.md`; replacing existing shared state is
  intentionally not automated and requires Mason's current explicit approval.
