Snapshot the Claude agent-memory notes to the PRIVATE off-site repo `masonwells1/CRX_Backups`. The memory notes live only on Mason's machine (`~/.claude/projects/<project>/memory/`) — nothing else backs them up, and they are the one artifact that must never land in this repo.

Mason does not type this command name. Run this flow when he says anything like: "back up my memory", "back up your notes", "save the decisions somewhere", "do we have a copy of your memory?". (If he only asks *whether* they're backed up, read `claude-memory/manifest.json` in `CRX_Backups` and report its `completed_at` and `file_count` — no new snapshot needed.)

**Why not this repo:** `CRX_Manager_V1.0` is **PUBLIC**, and the notes carry real commission payouts naming real people (e.g. per-recipient dollar amounts from the H1 commission backfill). `docs/claude-memory/` is gitignored for exactly this reason — never remove that ignore rule. `CRX_Backups` is private and already holds the weekly encrypted DB dump, so it is the right home.

**Read-only guarantee:** the source memory dir is only ever opened for reading. The script has no network access and never sees a token — the push is done by the driving session with `git`.

## Steps

### 1. Stage and verify the snapshot

```bash
node scripts/backup-claude-memory.mjs --stage <staging-dir>
```

The source dir is auto-discovered under `~/.claude/projects/*/memory` (it picks the CRX one holding `MEMORY.md`); pass `--source <dir>` to override. The script copies every `*.md`, re-reads each file to confirm the copy is byte-identical, prunes staged files the source no longer has (file-by-file — never a recursive delete), and writes `manifest.json` with a per-file sha256.

It **fails** rather than shipping a bad backup if the source is empty, is missing `MEMORY.md`, or if any copy does not match. A failure means the snapshot is wrong — fix the source path, do not push.

### 2. Copy into a clone of the private repo

Clone `masonwells1/CRX_Backups` (private) to a scratch dir, then copy the staged files into `claude-memory/` at its root. Do not touch `backups/` — that is the encrypted DB dump and is managed by the repo's own GitHub Action.

### 3. Re-verify inside the clone before committing

```bash
node scripts/backup-claude-memory.mjs --verify <clone>/claude-memory
```

This re-checks every file against the manifest that travelled with it. Never commit a snapshot that has not passed this check in its final location.

### 4. Commit and push

Commit to `CRX_Backups` with a dated message and push. This is a **private** repo whose entire purpose is receiving backups, so it does not need the branch → PR path that `CRX_Manager_V1.0` requires — commit straight to its default branch.

### 5. Confirm — prove it landed remotely

Do not report success from the local clone. Confirm against GitHub:

```bash
gh api repos/masonwells1/CRX_Backups/contents/claude-memory --jq '[.[] | select(.name | endswith(".md"))] | length'
```

The count must match the `file_count` in the manifest. Count only the `.md`
notes — `manifest.json` lives in that same folder and is **not** one of the
files it counts, so a bare `length` is always one too high and would never
match.

### 6. Report — one line, plain English

> "Backed up N memory notes (X KB) to the private CRX_Backups repo — verified against GitHub."

## Hard rules

- Never commit the memory notes to `CRX_Manager_V1.0`, and never remove `docs/claude-memory/` from `.gitignore`. The repo is public; the notes name real people and real money.
- Never hand-edit `manifest.json` to make a failing verify pass — a faked manifest silences the only check that would tell Mason his backup is corrupt.
- Never delete anything under `backups/` in `CRX_Backups` — that is the DB dump history, pruned by its own workflow.
- If the staging step fails, leave the previous snapshot in place and tell Mason exactly what failed. A good old backup beats a broken new one.
