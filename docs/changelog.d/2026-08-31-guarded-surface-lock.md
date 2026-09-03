## 2026-08-31 — Lock the enforcement surface instead of prompting for it

Mason asked to stop being prompted for approval on ordinary file edits. The two earlier entries
today established why that could not be done by relaxing the `ask` list: the files he was being
prompted on are the guardrail files, live `execute_sql`/`apply_migration`/pushes are auto-allowed,
and `review-proof-guard.mjs` deliberately permits ordinary hook and settings edits — so dropping
the prompt opened a two-step silent path (rewrite a guard, then run what it gated).

This replaces the prompt with a lock, which is the instrument that actually fits: a prompt is a
thing Mason clicks through at 11pm; a lock is a boundary an agent cannot cross. Because the
boundary is now hard, the prompts on those files could finally be removed — which is the outcome
originally asked for.

**New guard** `.claude/hooks/guarded-surface-lock.mjs` (rule book in `guarded-surface-lib.mjs`)
denies WRITES to the enforcement surface on every channel — native `Write`/`Edit`, MCP path
fields, `apply_patch` destinations, and shell commands — while always allowing READS, since agents
inspect hooks constantly during normal work. The read/write split uses a fail-closed allowlist of
read-only command heads, so unlisted writers (`tee`, `cp`, `mv`, `truncate`, `perl -i`, `python`,
anything invented later) are denied without enumeration. Three routes that never name a guarded
path are matched by shape: `git apply`/`am`/`patch`, `npm|pnpm|yarn install|add|remove|pkg`
(`npm ci` deliberately exempt), and redirects into a guarded target. Obfuscation handling mirrors
`review-proof-guard.mjs` (quote-splitting, dropped backslashes, ANSI-C escapes, glob leads), and
directory-level targets are covered because `rm -rf .claude/hooks` destroys every guard while
naming no guarded file.

**The unlock** `node scripts/guard-unlock.mjs --minutes N` requires an interactive TTY *and* a
typed phrase, so no agent shell can run it — proven in this session: the agent ran it and was
refused. It auto-expires (4h cap), reports `--status`, and re-locks early with `--lock`. The lock
protects `guard-unlock.mjs` and its own rule book, so an agent cannot rewrite the switch either.

**Proof it is real, not decorative:** registering the hook immediately blocked the authoring agent
from editing `.claude/settings.json` mid-task, which is exactly the self-protection property that
makes it worth having. 160 mutation assertions cover every named bypass route plus end-to-end hook
spawns; writing them caught two real defects before ship (anchored path patterns did not match
inside a command string, and `git apply` slipped through entirely).

**Known cost, stated plainly:** changing a guard, a CI workflow, or a dependency now requires Mason
to unlock first. That is the trade — a short deliberate unlock in exchange for no prompts anywhere
else and a boundary that holds while unattended.
