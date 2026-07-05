# Rotate the two exposed access tokens (owner task, ~5 minutes)

**Why:** Two live credentials sat in plain text in `C:\Users\mason\.claude\settings.json`
(and have appeared in session transcripts): a **Supabase personal access token** (`sbp_...`)
and a **GitHub fine-grained personal access token** (`github_pat_...`). Anyone with either
token can act as you — the Supabase one can read/write the live database's management API,
the GitHub one can push code. Rotating = issuing fresh ones and killing the old ones.
The config has already been tidied (the Supabase token now passes via an env block, not a
visible command-line argument), but **rotation is the real fix and only you can do it.**

## 1. Supabase token (2 minutes)

1. Open https://supabase.com/dashboard/account/tokens (log in as usual).
2. Find the existing token (likely named something like "Claude MCP") → **Revoke** it.
3. Click **Generate new token**, name it `claude-mcp-2026-07`, copy it (starts `sbp_`).
4. Tell Claude: *"here's the new Supabase token: sbp_..."* — Claude will put it in the
   right place in settings and confirm the Supabase connection still works.

## 2. GitHub token (3 minutes)

1. Open https://github.com/settings/personal-access-tokens (Fine-grained tokens).
2. Find the existing token used for the GitHub MCP → **Delete** it.
3. **Generate new token**: name `claude-mcp-2026-07`, scope it to **only the
   `masonwells1/CRX_Manager_V1.0` repository**, with Contents + Pull requests +
   Issues + Actions read/write. 90-day expiry is fine (rotate again when it expires).
4. Tell Claude: *"here's the new GitHub token: github_pat_..."* — Claude updates settings
   and verifies with a read-only API call.

## After both

Say **"verify the tokens"** — Claude will confirm both MCP connections work with the new
credentials and that the old values no longer appear anywhere in settings.

> Going forward: never paste tokens into chat unless you're replacing one on purpose,
> and expect a fresh rotation roughly twice a year (Claude's weekly housekeeping report
> will nag when a token is older than ~6 months if an expiry is set).
