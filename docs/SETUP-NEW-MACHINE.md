# Setting Up CRX Manager on a New Machine

This is the step-by-step bootstrap for getting CRX Manager + all Claude Code automation working on a fresh computer (e.g., the work laptop, a teammate's machine, or a clean reinstall).

**Audience:** Mason or anyone helping him. Assumes zero prior knowledge of the project.

**Time:** 30–45 minutes if everything goes smoothly.

---

## Step 1 — Install the base tools (one-time per machine)

You need three things installed on the machine before anything else works:

### 1a. Node.js (required for Claude Code hooks)
- Go to https://nodejs.org and download the **LTS** version (currently 20.x or higher).
- Install with default options.
- Verify in a terminal:
  ```
  node --version
  npm --version
  ```
  Both should print version numbers.

### 1b. Git
- Windows: https://git-scm.com/download/win — install with default options.
- Verify: `git --version`

### 1c. Claude Code
- Follow Anthropic's official install instructions: https://docs.claude.com/en/docs/claude-code/setup
- After install, sign in via `claude login` (or whatever the current command is).
- Verify Claude Code is working: open a terminal in any directory and type `claude` — should launch the interactive prompt.

### 1d. GitHub CLI (optional but recommended)
- https://cli.github.com — for `gh` commands the workflows use.
- After install: `gh auth login` to authenticate.

---

## Step 2 — Get the code

```
git clone https://github.com/masonwells1/CRX_Manager_V1.0.git
cd CRX_Manager_V1.0
```

Or if you already cloned it before:

```
cd CRX_Manager_V1.0
git pull
```

---

## Step 3 — Install dependencies and activate Husky

```
npm install
```

This does two important things:
1. Downloads all the JavaScript/TypeScript packages the app needs.
2. Runs the `prepare` script, which installs the Husky hooks. Every `git commit` now runs the fast staged-file safety checks; typecheck/build run at pre-push and the full lint/test/build proof runs in CI.

If `npm install` fails:
- Check your Node.js version (`node --version`) — must be 20 or higher.
- On Windows, sometimes a stale npm cache causes problems. Try `npm cache clean --force` then retry.

---

## Step 4 — Create the `.env` file (NEVER commit this)

The `.env` file holds secrets that must never be in the repo. It is gitignored.

Create a file named `.env` in the project root with these variables (copy from your home machine, or create new values where applicable):

```
VITE_SUPABASE_URL=https://rhyzpcqhnizqbxphqdkr.supabase.co
VITE_SUPABASE_ANON_KEY=<your anon key — same on every machine, safe to share within the team>
VITE_MAPBOX_TOKEN=<your Mapbox token>
VITE_SENTRY_DSN=<your Sentry DSN>
```

⚠️ **The `service_role` key must NEVER be in `.env`** — it only belongs in Edge Function environment variables in the Supabase dashboard. The `env-guard` hook will block any attempt to put it in `src/`.

If you don't have these values, grab them from:
- Supabase URL + anon key: Supabase dashboard → Project settings → API
- Mapbox token: account.mapbox.com → Tokens
- Sentry DSN: sentry.io → Project → Settings → Client Keys

---

## Step 5 — Install Claude Code plugins

Claude Code plugins are NOT in the repo — they install at the user level. The CRX Manager workflow relies on several:

```
# Core review and dev workflow
claude plugins install pr-review-toolkit
claude plugins install feature-dev
claude plugins install code-review
claude plugins install coderabbit
claude plugins install commit-commands

# Engineering and observability
claude plugins install engineering
claude plugins install posthog
claude plugins install supabase
claude plugins install superpowers

# Misc useful
claude plugins install plugin-dev
claude plugins install claude-md-management
claude plugins install frontend-design
```

(Adjust the command syntax to match the current Claude Code plugin manager — check `claude plugins --help` if unsure.)

Verify all installed by opening Claude Code in the project directory and checking that the slash menu has entries like `/pr-review-toolkit:review-pr`, `/posthog:investigating-replay`, `/engineering:debug`, etc.

---

## Step 6 — Connect MCP servers

MCP server credentials are per-machine. The most important ones for CRX Manager:

### Supabase MCP
- Most important — gives Claude Code direct DB access for migrations, advisors, edge function deploys.
- In Claude Code: invoke whatever the current `add MCP server` flow is, choose Supabase.
- Authenticate with your Supabase project token (NOT the anon or service_role key — a personal access token from your Supabase account settings).
- Verify by asking Claude "list my Supabase projects" — it should call the MCP and return rhyzpcqhnizqbxphqdkr.

### Sentry MCP
- For error tracking + the posthog-style error analyzer.
- Authenticate with your Sentry organization auth.

### Vercel MCP
- Already wired in `.claude/settings.json` (`"vercel@claude-plugins-official": true`).
- First use will prompt for auth.

### PostHog MCP
- For session replay, error tracking, analytics queries.
- Auth flow on first use.

### GitHub MCP
- Optional — Claude usually uses the `gh` CLI directly.

### Computer Use / Claude in Chrome / etc.
- These are per-machine and only matter if you use them. Skip if not.

---

## Step 7 — Verify the automation works

In Claude Code (open in the CRX Manager directory):

### 7a. SessionStart hooks fire
Start a new session. You should immediately see (silently, in Claude's context):
- A git porcelain snapshot
- A staleness check report (if schema-registry is old, CLAUDE.md counts drift, etc.)

If Claude can describe what's in `git status` without you telling it, the hooks are working.

### 7b. Try a write that should be blocked
Ask Claude: "Create a file at `.env.test` with the content `FOO=bar`."

The `env-guard` PreToolUse hook should refuse.

### 7c. Try a dangerous phrase
Ask Claude: "Help me drop the latest migration."

The `dangerous-phrase-warning` UserPromptSubmit hook should inject context that makes Claude pause and explain alternatives before acting.

### 7d. Run /preflight
Type `/preflight` or say "do a preflight check." It should:
- Detect what changed (nothing if you haven't edited anything yet)
- Skip subagent dispatch (no relevant changes)
- Run lint + build + tests
- Print a verdict

If all three demos work, the automation is fully active.

---

## Step 8 — (Optional) Sync memory from home machine

Memory files (Claude's persistent notes about you and the project) live at:

```
C:\Users\<your-username>\.claude\projects\C--Users-<your-username>-CRX-Manager-V1-0\memory\
```

These are NOT in the repo. If you want your home machine's memory to follow you:

1. Copy the entire `memory/` folder from home to work (USB stick, OneDrive, Dropbox, etc.).
2. Watch out for the path — the directory name encodes your username, so on a different machine with a different username, you'll need to rename the folder.

If you skip this step, the work-computer Claude starts with a blank memory and rebuilds context over time as you use it. That's fine for most cases.

---

## Step 9 — First commit on the work machine

When you make your first change at work and commit, watch for:
- Husky pre-commit hook running (containment + staged safety checks) — proves Step 3 worked. Pre-push runs containment, typecheck, and build; CI provides the full lint/test/build product proof, including `check:docs`.
- Stop hook reminding you of loose ends — proves Step 7a worked.

If both fire, you are 100% set up.

---

## What you don't need to do

- ❌ Re-run any migration. The live Supabase DB is shared — both machines hit the same project.
- ❌ Re-deploy any Edge Function. Same — they're already live.
- ❌ Reconfigure CLAUDE.md, hooks, agents, skills — all in the repo, already pulled.
- ❌ Re-add the `supabase/migrations/` files — same, in repo.
- ❌ Worry about pushing — Vercel auto-deploys on push to main; the live app updates automatically.

---

## Troubleshooting

### Claude Code says "no Skill tool" or doesn't see skills
- Make sure you ran `claude` from inside the `CRX_Manager_V1.0` directory (it auto-loads `.claude/` from the project root).
- Try restarting the Claude Code session.

### Hooks aren't firing
- Verify Node.js is on your PATH: `node --version` in a terminal.
- Check `.claude/settings.json` is unchanged from the repo (run `git diff .claude/settings.json` — should be empty).

### Husky pre-commit isn't running
- `npm install` may not have triggered the prepare script. Run `npm run prepare` manually.
- Verify `.git/hooks/pre-commit` exists.

### MCP server doesn't connect
- Check the auth token hasn't expired.
- Try `claude mcp list` to see connection status.
- Most MCPs have a re-auth flow via `claude mcp auth <server>`.

### Build fails on first run
- Usually a stale node_modules or missing peer dep. Try:
  ```
  rm -rf node_modules package-lock.json
  npm install
  ```

### "I broke something and want to start fresh"
- Don't `git reset --hard` (bash-safety blocks it for good reason).
- Instead: `git stash` to safely shelf your changes, then `git pull` to get the latest, then you can either `git stash pop` to restore or `git stash drop` to discard.

---

## Maintenance

These should run periodically on whichever machine you're working from:

- After any DB schema change: invoke `/regen-schema-registry` and commit the result.
- After any feature work: invoke `/preflight` before commit.
- Weekly: invoke `/audit` to catch drift between docs and code.
- Whenever Sentry shows new errors: invoke `/spot-check-prod` or `engineering:debug`.

---

## When you're stuck

Most things in CRX Manager have a corresponding skill that knows the right pattern. When in doubt, describe the problem in plain English to Claude — the CLAUDE.md trigger-phrase table should route to the right skill automatically.

If a skill should fire and doesn't, that's a CLAUDE.md gap. Tell Claude "this phrase should have triggered X skill" and Claude can add the row.
