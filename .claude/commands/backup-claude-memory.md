Snapshot the Claude agent-memory notes to the PRIVATE off-site repo `masonwells1/CRX_Backups`. The memory notes live only on Mason's machine (`~/.claude/projects/<project>/memory/`) — nothing else backs them up, and they are the one artifact that must never land in this repo.

Mason does not type this command name. Run this flow when he says anything like: "back up my memory", "back up your notes", "save the decisions somewhere", "do we have a copy of your memory?". (If he only asks *whether* they're backed up, read `claude-memory/manifest.json` in `CRX_Backups` and report its `completed_at` and `file_count` — no new snapshot needed.)

**Why not this repo:** `CRX_Manager_V1.0` is **PUBLIC**, and the notes carry real commission payouts naming real people (e.g. per-recipient dollar amounts from the H1 commission backfill). `docs/claude-memory/` is gitignored for exactly this reason — never remove that ignore rule. `CRX_Backups` is private and already holds the weekly encrypted DB dump, so it is the right home.

**Read-only guarantee:** the source memory dir is only ever opened for reading, and the notes themselves never leave the machine by any route the script controls — the push is done by the driving session with `git`. The script makes exactly one network call, and it sends nothing: `gh repo view masonwells1/CRX_Backups --json visibility`, to confirm the destination is still private before staging into it. `gh` holds the credential, so the script never sees a token.

## Steps

### 1. Stage and verify the snapshot

```bash
node scripts/backup-claude-memory.mjs --stage <staging-dir>
```

The source dir is auto-discovered under `~/.claude/projects/*/memory` (it picks the CRX one holding `MEMORY.md`); pass `--source <dir>` to override. The script copies every `*.md`, re-reads each file to confirm the copy is byte-identical, prunes staged files the source no longer has (file-by-file — never a recursive delete), and writes `manifest.json` with a per-file sha256.

It **fails** rather than shipping a bad backup if the source is empty, is missing `MEMORY.md`, or if any copy does not match. A failure means the snapshot is wrong — fix the source path, do not push.

The staging directory is checked before anything is written. If it sits inside a git checkout where the files would be committable, then **every push destination in that checkout** must be `masonwells1/CRX_Backups` — the notes may be tracked in exactly one repository, and every other case is refused: a wrong clone, a fork, no remote at all, a second remote pointing elsewhere, or a remote that fetches from the backup but pushes somewhere else (`git remote set-url --push` splits those two, and only the push URL says where a push lands). A path outside git entirely is always fine and skips these checks; so is a path the repo ignores — but **every** file the run will write, including `manifest.json`, has to be ignored, not just one. A repo that ignores `MEMORY.md` and nothing else leaves the remaining notes committable, so it is treated as a tracked destination and validated as one.

A push remote whose URL embeds a credential (`https://<token>@github.com/…`) is refused outright, and the refusal does not reprint the URL — because the verified URL is printed and reused below, a token in it would land in terminal output, transcripts, and shell history. Use the plain SSH or HTTPS URL with a credential helper. A bare `git@` username is the ordinary SSH spelling, not a credential.

When the destination is the backup clone the script also asks GitHub whether that repo is still private, and **refuses unless the answer is `PRIVATE`** — including when `gh` cannot answer at all. Publishing these notes cannot be undone, so an unproven-private destination parks rather than warns: fix the check (`gh auth status`, or reconnect) and re-run, or stage outside the repo if you only wanted a local copy. On success the script prints the exact push URL it verified — that is the destination step 4 pushes to.

### 2. Copy into a clone of the private repo

Clone `masonwells1/CRX_Backups` (private) to a scratch dir, then copy the staged files into `claude-memory/` at its root. Do not touch `backups/` — that is the encrypted DB dump and is managed by the repo's own GitHub Action.

### 3. Re-verify inside the clone before committing

```bash
node scripts/backup-claude-memory.mjs --verify <clone>/claude-memory
```

This re-checks every file against the manifest that travelled with it, **and re-runs every destination check against the clone itself** — which repository it is, where each of its remotes pushes, and whether GitHub still reports that repo private. That matters because the checks in step 1 ran against the staging directory, and staging outside git skips all of them by design. This is the only step that sees the location the notes are actually committed from. Never commit a snapshot that has not passed this check in its final location.

Simplest way to avoid the whole gap: stage directly into `<clone>/claude-memory` in step 1 and skip the copy. Then the directory step 1 validated and the directory step 4 pushes are the same directory, and step 1 prints the verified push URL.

### 4. Commit and push

Commit to `CRX_Backups` with a dated message, then push **to the exact URL the staging step printed** (`Destination verified: this checkout pushes only to …`) rather than to an unqualified default. This is a **private** repo whose entire purpose is receiving backups, so it does not need the branch → PR path that `CRX_Manager_V1.0` requires — commit straight to its default branch.

### 5. Confirm — prove *this* snapshot landed remotely

Do not report success from the local clone. Ask GitHub which snapshot it is now holding:

```bash
gh api repos/masonwells1/CRX_Backups/contents/claude-memory/manifest.json -H "Accept: application/vnd.github.raw" --jq '"\(.completed_at)  \(.file_count) files  \(.total_bytes) bytes"'
```

Then print the same line from the manifest you just committed:

```bash
node -e "const m=require(process.argv[1]);console.log(`${m.completed_at}  ${m.file_count} files  ${m.total_bytes} bytes`)" <clone>/claude-memory/manifest.json
```

**The two lines must be identical, character for character.** `completed_at` is a
millisecond timestamp unique to that staging run, so a match proves the snapshot on
GitHub is the one this run produced — not a previous one. A file count alone does
not: if the push silently failed or landed somewhere else while the previous backup
happened to hold the same number of notes, a count check reports success over a
stale backup (Codex's fifteenth 2026-07-30 review). A 404 on the first command means
nothing landed at all.

As a last cross-check that no note went missing, the remote `.md` count must equal
that same `file_count`:

```bash
gh api repos/masonwells1/CRX_Backups/contents/claude-memory --jq '[.[] | select(.name | endswith(".md"))] | length'
```

Count only the `.md` notes — `manifest.json` lives in that same folder and is **not**
one of the files it counts, so a bare `length` is always one too high and would never
match.

### 6. Report — one line, plain English

> "Backed up N memory notes (X KB) to the private CRX_Backups repo — verified against GitHub."

## Hard rules

- Never commit the memory notes to `CRX_Manager_V1.0`, and never remove `docs/claude-memory/` from `.gitignore`. The repo is public; the notes name real people and real money.
- Never hand-edit `manifest.json` to make a failing verify pass — a faked manifest silences the only check that would tell Mason his backup is corrupt.
- Never delete anything under `backups/` in `CRX_Backups` — that is the DB dump history, pruned by its own workflow.
- If the staging step fails, do not commit and tell Mason exactly what failed. A good old backup beats a broken new one. Staging copies the notes in place, so a run that dies partway leaves the staging directory half-written — it deletes `manifest.json` before it starts, so `--verify` fails closed and a half-written directory can never pass as a good snapshot. Recover the previous snapshot with `git restore -- claude-memory` in the backup clone — that path and nothing else; never a discard-all such as `git checkout -- .`, which would throw away every other uncommitted change in the clone. Then re-run the staging step; never commit a staging directory that has no manifest.
