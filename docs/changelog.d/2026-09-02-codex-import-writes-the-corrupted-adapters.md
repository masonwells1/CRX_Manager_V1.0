## 2026-09-02 — the corrupted `source-command-*` adapters are written by the Codex CLI's `/import`

The 2026-08-31 known issue recorded that a command-to-skill migrator was writing 24 corrupted
`.agents/skills/source-command-<name>/SKILL.md` directories into the worktrees, that a machine-wide
sweep had found 94 artifact files and **no generator script anywhere**, and that the writer was
therefore a CLI/tool feature that remained **unidentified**. It is now identified.

**It is the Codex CLI's "Import from other apps" feature (`/import`).** Not repo code, and
`sync-agent-workflows.mjs` stays exonerated.

Evidence, all read directly from the installed binary and its own state files:

1. **The artifacts' exact template text lives inside `codex.exe`.** Searching
   `…/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`
   returns the two literals the artifacts are built from:

   ```text
   Use this skill when the user asks to run the migrated source command `
   Migrated source command `
   ```

2. **The generating modules are named in the binary's own trace strings:**

   ```text
   core-plugins\src\command_migration\render.rs
   external-agent-migration\src\source_cla.rs      (cla = Claude)
   external-agent-migration\src\source_cur.rs      (cur = Cursor)
   tui\src\external_agent_config_migration\flow.rs
   app-server\src\external_agent_migration\processor.rs
   ```

   and the source enum it selects from is the literal string `claude-codeClaude CodeCursor`.

3. **Its import ledger was written in the same second as the artifacts.** All 24 directories in
   `C:/CRX_Manager/.agents/skills/` carry `SKILL.md` timestamps of `2026-09-02 01:38:50` (spread over
   ~13ms — one process, one burst). `C:/Users/mason/.codex/external_agent_session_imports.json` was
   last modified at `2026-09-02 01:38`. That ledger's records point at
   `C:\Users\mason\.claude\projects\…\*.jsonl` — Claude Code session files — confirming the feature
   was reading the Claude Code configuration at that moment.

4. **It keeps durable state**, so it is a first-class feature rather than a stray one-shot: a SQLite
   table `external_agent_config_imports`, the JSON session ledger above, and telemetry events
   `codex.external_agent_config.detect` / `codex.external_agent_config.import` and
   `codex_onboarding_external_agent_import_complete`.

**Why the content is corrupted.** The importer applies a case-insensitive `claude` → `Codex`
substitution to the instruction body, not only to identifiers. That is what turns
`.claude/hooks/autopilot-arm.mjs` into `.Codex/hooks/autopilot-arm.mjs` in 13 of the 24 files, and
what mangles `source-command-ship`'s copy of the `/ship` autonomy boundary.

**No off-switch was found.** The binary was searched for a disabling configuration key
(`skip_external_agent*`, `disable_external_agent*`, `*import*enabled/disabled/skip`) and none exists;
the only related knobs are the marketplace/plugin entries in `~/.codex/config.toml`. So the trigger
cannot be turned off from our side — the durable fix has to be on ours.

**Why this is not cosmetic.** `sync-agent-workflows.mjs --check` rejects all 24 as "not generated
from `.claude`", which fails the pre-commit workflow-parity gate. Verified live on 2026-09-02: the
check fails in `C:/CRX_Manager`, so **every commit in the main checkout is blocked** while the
directories are present. A `.gitignore` entry does not help — the checker walks the filesystem with
`readdirSync`, not the git index.

**Not done here, and deliberately.** The directories are left in place (Mason's 2026-09-02 decision to
keep them visible rather than mute them), and no fix to the parity checker is included; that is its own
reviewed change. This entry only corrects the record from "the writer is unidentified" to the writer
being named, with the evidence to support it.
