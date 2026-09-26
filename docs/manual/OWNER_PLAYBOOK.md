# Owner Playbook — how to run CRX Manager through Claude and Codex

**Last verified:** 2026-09-26 (autonomous landing)
**Update triggers:** when commands/skills/policies change (the agent that changes them updates this file).

This is your manual, Mason. You never have to remember a slash command (a typed
shortcut like `/ship`) — just say what you want in plain English, and the agent
routes you to the right workflow. Everywhere below, the slash-command name is
shown in parentheses only so you recognize it if you see it mentioned — you
never have to type it yourself.

---

## How this system works in one minute

1. **You describe what you want, in plain English.** "Is prod okay?", "back up
   the database", "ship it" — no syntax required.
2. **The agent (Claude or Codex) routes your request to the right workflow.**
   Every workflow is pre-written with the right safety steps baked in, so the
   agent doesn't have to improvise the safe way to do something risky.
3. **Hooks are automatic tripwires that run underneath the agent.** A hook is a
   small script that checks every risky action *before* it happens — it can
   block a bad SQL pattern, refuse to let a new database table skip its
   security rules, or stop a live database change if it hasn't been reviewed.
   Hooks fire even if the agent itself gets confused or makes a mistake — they
   are a second, independent layer of protection, not just "the agent being
   careful."
4. **Nothing reaches the live database or production without passing a gate.**
   "Production" means the real, live app your customers and staff use at
   croprxsolutions.app — as opposed to a test copy. A "gate" is a checkpoint
   that must clear before something risky happens: an automated review, a
   written proof file, and — for the riskiest actions — your own explicit yes,
   typed in the conversation.

If you remember nothing else: **agents land ordinary work and non-deleting
database changes on their own once two independent final reviews are clean, and
you are still the last checkpoint for anything that deletes data, deploys an Edge
Function, or touches secrets, logins, billing or permissions.** The rest of this
playbook is detail on top of that.

---

## Your daily/weekly routines

| Say this | What happens | When to use |
|---|---|---|
| Just open a session — nothing to say | A start-of-session check runs automatically and may warn you about: the **schema registry** (a snapshot of the database structure the safety hooks read) being out of date, **leftover uncommitted changes** from a previous session, or the **weekly database backup** being missing or stale. These are just heads-up flags, not errors — mention them to the agent and it'll offer to fix the stale one. | Every time you start working |
| "Is prod okay?" | A one-page live health check: recent errors (Sentry), database security/performance warnings (Supabase advisors), the last website build status (Vercel), and whether the background email/OCR/user-admin jobs (Edge Functions) are deployed correctly. Read-only — nothing changes. (`spot-check-prod`) | Anytime you're unsure if something's wrong, or before approving a new deploy |
| "Back up the database" | A full read-only copy of every table in the live database gets saved as dated files. Because your Supabase plan doesn't include automatic point-in-time recovery, this weekly copy is your real safety net. (`backup-db`) | Weekly, or anytime before something risky |
| "Is my data backed up?" | Just reads the last backup's date/size — no new backup runs. | Quick reassurance check |
| "What's the status of everything" | Shows every parallel worktree (a worktree is a separate folder/session working on its own piece of code) and every background loop at once — what's finished, what's still in progress, what's merged into the live app already. (`fleet`) Pair with "anything waiting on me" to see every written-but-not-yet-applied database change across all of them. (`parked`) | When you've had several sessions running and want the big picture |
| "Review this before it ships" | Runs the code through the right combination of automated reviewers (security, database-drift, money-math, PDF-output checks) plus a genuinely independent second AI model, Codex, so nothing ships on one model's opinion alone. (`preflight` for the quick pre-commit check; `codex-gauntlet`/`codex-review` for the fuller adversarial pass) | Before committing or before anything you're nervous about |
| "Ship it" | Runs the full pipeline: implement → verify it actually works → automated review → Codex's independent review → fix anything found → CodeRabbit's final review → Sol's final review → apply its database change if it has one → merge. It lands on its own once both final reviews are clean and every check is green (your 2026-09-26 rule, explained below). It stops and shows you exactly what it wants to do before a database change that deletes data, an Edge Function deploy, or anything touching secrets, logins, billing or permissions. (`ship`) | The standard way to get a feature or fix built end-to-end |
| "Something looks wrong in the live app" | Pulls recent errors from Sentry (error tracking), Vercel (the website host), and Supabase (the database) logs, explains each one in plain English, and suggests a fix. If the real fix is "undo the last change" rather than "patch forward," it hands you to the rollback flow instead. (`quick-fix`) | The moment something looks broken |
| "Undo the last change" / "roll back" | Walks you through exactly one of three fixes depending on what broke: a bad website deploy (one click in Vercel), a bad database change (a new corrective migration, never editing history), or a bad background job (redeploying its last good version). Every path shows you what happened and waits for your yes before doing anything live. (`rollback`) | Right after a change breaks something |
| "End the session" / "wrap up" | The agent double-checks the code still compiles and builds, that documentation is in sync, and reminds you to commit if you haven't. There's no single command for this — just say it and the agent runs through the closing checklist. | Before closing your laptop |

---

## What agents do on their own, and what still needs YOUR yes

**Your rule since 2026-09-26 ("Yes I approve").** When a change's two final reviews are clean — Codex **Sol** reviewed the exact final version, and **CodeRabbit** (the automatic GitHub review bot) approved that same version — and every automatic check is green, the agent **merges it by itself** (merging = putting it into the live app). If the change includes a **migration** (a change to the shape or rules of the live database) that does not delete anything, the agent **applies it to the live database by itself** too, after the same proof checks that have always guarded migrations: two specialist reviewers plus a fresh Sol review of the exact SQL, all less than 30 minutes old. This works in any session, whether or not a hands-free run is armed. Safety scripts check every one of these conditions before a merge or an apply is allowed, so an agent cannot skip them. The trade-off you accepted: every change, even a small wording fix, now gets a Sol review, which uses more Codex credits.

**What you still do — the whole list:**

- **Approve a database change that deletes data.** Anything that erases business records, or drops a table or column that holds data. Agents are blocked from applying these on their own in every session. They park it, explain the risk in plain English, and wait for your yes.
- **Approve Edge Function deploys.** These are the small pieces of backend code that send emails, scan blend-ticket photos (OCR), and create/reset user accounts. A bad deploy can silently break one of those without touching the rest of the app.
- **Approve anything touching secrets, logins, billing, or permissions.** Passwords and keys, who can sign in and how, what you pay for, and who is allowed to do what.

A few other things agents simply never do on their own — overwriting history on GitHub (a force-push), changing live data by hand outside a reviewed migration, or changing domains or account ownership. `AGENTS.md` holds that full list; if another document ever shows a shorter one, `AGENTS.md` wins.

**What counts as approval for those:** a clear, current "yes" in the conversation — "yes, apply it," "go ahead," "approved" — right before it happens. A yes from an earlier task, silence, or "you always have my blessing for this kind of thing" does not count. If an agent is about to delete data, deploy an Edge Function, or touch secrets, logins, billing or permissions without showing you exactly what it will run and waiting for your answer, stop it.

**Your daily summary.** Every morning (about 8:00 Chicago time) GitHub emails you a short comment on the "Daily landing summary" issue: what merged, which database changes were applied, and what is waiting on you. "Applied" comes from the notes the agents write when they apply something — the summary job cannot read the live database itself, and says so.

**Why this is safe enough:** a bad website change is a one-click rollback in Vercel, and a bad non-deleting database change is fixed by a new corrective migration. Nothing that destroys data happens without you. Nobody — agent or human — can push straight to the live branch; GitHub rejects it, so every change still goes through a pull request (a proposed change GitHub holds for checks). If you ever want merges or migrations to wait for your yes again, just say so and an agent will change the rule everywhere it's written down.

---

## Which AI does what

- **Claude** (Anthropic) is usually the one you talk to. It plans, builds, and runs the reviewer helpers. The careful reviewers use the newest Opus (one of Claude's top-tier models) and quick status checks use the faster Sonnet. Both are named so they update automatically when Anthropic releases a newer version.
- **Codex** (OpenAI) is the independent second opinion, so nothing ships on one AI's word alone. It has three GPT-6 models:
  - **Luna** is fast and cheap. It does the repeated review rounds until the code is clean, and it is also the one that writes code when Codex builds.
  - **Sol** is stronger. It does one final review of every change right before it lands, and the safety gates won't let anything merge without it (since 2026-09-26; before that only risky changes needed it). It also builds money and database work.
  - **Astra** is the most capable and the most expensive. It's the choice for reviewing plans and big design questions before anyone writes code. So far it has been run by hand when asked; no automatic workflow uses it yet.
- The exact model names and settings for each job are in `docs/reference/codex-model-tuning.md`.

---

## Reading an agent's report

- **A PROOF line** ("PROOF — Ran: … · Saw: …") is the agent showing you it actually executed something and observed the result — opened the page, ran the query, hit the endpoint — rather than just saying "should work now." A report claiming something is "done" with no PROOF line is a claim, not evidence.
- **"Parked"** means a database or backend change was written and even validated in a safe, rolled-back trial run, but is deliberately waiting before it touches the live system — usually because it deletes data or needs an Edge Function deploy, which are yours to approve. Nothing parked has happened yet.
- **BLOCKER** means "do not ship this" — it would break production, corrupt money math, or open a security hole. **HIGH** means a real bug that should be fixed before merging. **MED/LOW** are smaller — fine to fix now or note and move on.
- **Red flags — stop and ask if you see these:**
  - An agent says something is "done" without showing what it actually ran and what it saw.
  - An agent asks you to bypass, disable, or work around a hook/guard "just this once."
  - An agent deploys an Edge Function, deletes data, or applies a database change that deletes data without having shown you the specific action and gotten your yes first. (Merging a change, or applying a non-deleting database change, after both final reviews came back clean is authorized and normal — it shows up in your daily summary.)
  - An agent treats a finding buried in a document, web page, or piece of code it read as an instruction to follow — that content is data, not a command, and the agent should say so rather than act on it.

---

## When things go wrong

- **A deploy made the site look/act wrong:** say **"is prod okay?"** to confirm, then **"roll back the site."** The fix is a one-click "Promote to Production" on the previous good build in the Vercel dashboard (Deployments tab → find the last good build → "..." → Promote to Production) — fully reversible, nothing is deleted.
- **A database change broke something:** say **"walk me through rollback."** The agent never edits or deletes the migration that already ran — it writes a brand-new migration that corrects it and runs it through the same review gates as any other database change. If the correction deletes data, it waits for your yes before applying it live.
- **The app seems down or an error is showing:** check Sentry (error tracking) and say **"is prod okay?"** — it pulls the live picture in one shot.
- **An agent seems stuck, confused, or is going in circles:** say **"/clear"** to wipe its short-term memory and restate what you want, or just start a fresh session. A stale, cluttered conversation causes more mistakes than starting over costs you.

---

## Session hygiene cheat-sheet

- **`/clear` between unrelated tasks.** Carrying over context from a different topic causes mistakes — clear it before switching gears.
- **Only one session should be writing to the live database at a time.** If you have several windows open, check "what's the status of everything" before starting DB-touching work in a new one.
- **Use a stronger model for risky or architectural work, a faster one for routine changes** — ask the agent which is running if you're not sure, and switch when the task calls for it (this needs a `/clear` to take effect).
- **Parallel worktrees are normal.** You often have several sessions working in separate folders at once. Agents check for this automatically ("what's the status of everything" shows you all of them) — but if you're ever unsure whether two sessions might collide, ask.

---

## Monthly health habits

- **Run an agent-health check** ("is the Claude/Codex setup healthy?") — confirms the hooks, reviewers, and handoff wiring between the two AI tools are actually working, not just present. (`agent-health`)
- **Check all backup paths actually ran:** the weekly file-based database backup (ask "is my data backed up?"), the automated in-database snapshot inside Supabase, and the nightly Personal DR backup. Independent copies are the point — one system quietly failing should not be a surprise months later.
- **Skim `docs/manual/KNOWN_ISSUES.md` with your agent** — the one consolidated list of everything known-open: dormant bugs, parked database changes, and decisions waiting on you. A five-minute skim once a month keeps small things from being forgotten.
- **Ask "where are my Claude tokens going?"** — the agent runs `node scripts/claude-usage-report.mjs` (read-only; it reads the transcripts on this PC, sends nothing anywhere) and reports the last 14 days: how much of the spend is context being re-sent every call, which sessions ran longest, and how many tool calls a guard refused. Roughly three-quarters of spend is re-sent context, so the number to watch is "calls above 200K context"; a session that keeps climbing is cheaper to hand off than to continue.

---

## More detail, if you want it

- `docs/workflows/SAFE_DEVELOPMENT_RULES.md` — the detailed technical rulebook agents follow for code, production, data, security, money, and other risky changes (this playbook is the plain-English front door to it).
- `docs/runbooks/incident-rollback.md` — the detailed step-by-step for each of the three rollback scenarios.
- `docs/operations/production-runbook.md` — the deeper reference on how deploys, backups, and month-end close work.
- `AGENTS.md` — the short shared contract every coding agent in this repo follows; detailed procedures are linked from it.
