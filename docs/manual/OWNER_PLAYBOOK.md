# Owner Playbook — how to run CRX Manager through Claude and Codex

**Last verified:** 2026-08-06
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

If you remember nothing else: **you are always the last checkpoint before
anything risky and irreversible happens.** The rest of this playbook is detail
on top of that one fact.

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
| "Ship it" | Runs the full pipeline: implement → verify it actually works → automated review → Codex's independent review → fix anything found → commit. It stops and shows you exactly what it wants to do before touching the live database or pushing to production. (`ship`) | The standard way to get a feature or fix built end-to-end |
| "Something looks wrong in the live app" | Pulls recent errors from Sentry (error tracking), Vercel (the website host), and Supabase (the database) logs, explains each one in plain English, and suggests a fix. If the real fix is "undo the last change" rather than "patch forward," it hands you to the rollback flow instead. (`quick-fix`) | The moment something looks broken |
| "Undo the last change" / "roll back" | Walks you through exactly one of three fixes depending on what broke: a bad website deploy (one click in Vercel), a bad database change (a new corrective migration, never editing history), or a bad background job (redeploying its last good version). Every path shows you what happened and waits for your yes before doing anything live. (`rollback`) | Right after a change breaks something |
| "End the session" / "wrap up" | The agent double-checks the code still compiles and builds, that documentation is in sync, and reminds you to commit if you haven't. There's no single command for this — just say it and the agent runs through the closing checklist. | Before closing your laptop |

---

## The gates that always need YOUR yes

Some actions are irreversible enough, or risky enough, that no amount of automated review replaces you personally saying yes, in the current conversation, right before it happens. A "yes" from an earlier task, or a general "go ahead and handle things," does not count for a new one of these — the agent is required to ask again each time. (The migration gate has one exception you approved on 2026-07-13 — spelled out in its bullet below.)

- **Applying a live migration — when you're working with the agent.** A migration is a change to the shape or rules of the live database — adding a column, changing a table, tightening a security rule. Once applied, it's real and affects real customer/business data immediately. In a normal session the agent shows you the change and waits for your yes. **Exception you approved (2026-07-13):** when you explicitly start a hands-free run (say "run overnight" — the agent arms a time-limited autopilot flag as the record of your permission), migrations may apply without asking you each time, because every one still has to pass the hard proof gate: a fresh same-session security + drift review, plus a second-model (Codex) verdict for anything touching SQL, security rules, or money. Migrations that **delete data or drop tables/columns holding data never apply on their own** — hands-free or not, those wait for you.
- **Deploying an Edge Function.** These are the small pieces of backend code that send emails, scan blend-ticket photos (OCR), and create/reset user accounts. A bad deploy can silently break one of those without touching the rest of the app.
- **Deleting data.** Anything that permanently removes real rows — as opposed to voiding or cancelling, which keeps the record and just marks it inactive.

**What counts as approval:** a clear, current "yes" — "yes, apply it," "go ahead," "do it," "approved" — or, for migrations only, a hands-free run you explicitly started (the armed autopilot flag is the proof, and it expires on its own). Silence, a thumbs-up on something else, or "you always have my blessing for this kind of thing" does not count. If the agent is about to deploy an Edge Function or delete data and hasn't shown you exactly what it's about to run and waited for your answer, stop it.

**A note on landing regular code on `main`** (the branch that is live at croprxsolutions.app the moment anything lands on it): you gave a standing authorization (2026-06-16) for agents to land **regular, reversible code** on `main` automatically once the full pipeline is green — review clean, tests passing, and the pre-push typecheck/build succeeding — because a bad frontend deploy is a one-click rollback in Vercel. Since 2026-07-14, nobody (agent or human) can push straight to `main` — GitHub itself rejects it — so "landing" always means: push a branch, open a pull request (a proposed change GitHub holds for checks), wait for the automatic Vercel build check to pass, then merge. That authorization covers ordinary code only. Edge Function deploys and data deletion are **never** covered by it, and migrations are covered only inside a hands-free run you started, as described above. If you ever want any of this to wait for your yes again, just say so and an agent will update the policy everywhere it's written down.

---

## Reading an agent's report

- **A PROOF line** ("PROOF — Ran: … · Saw: …") is the agent showing you it actually executed something and observed the result — opened the page, ran the query, hit the endpoint — rather than just saying "should work now." A report claiming something is "done" with no PROOF line is a claim, not evidence.
- **"Parked"** means a database or backend change was written and even validated in a safe, rolled-back trial run, but is deliberately waiting for your review and yes before it touches the live system. Nothing parked has happened yet.
- **BLOCKER** means "do not ship this" — it would break production, corrupt money math, or open a security hole. **HIGH** means a real bug that should be fixed before merging. **MED/LOW** are smaller — fine to fix now or note and move on.
- **Red flags — stop and ask if you see these:**
  - An agent says something is "done" without showing what it actually ran and what it saw.
  - An agent asks you to bypass, disable, or work around a hook/guard "just this once."
  - An agent deploys an Edge Function or deletes data without having shown you the specific action and gotten your yes first, or applies a migration outside the two authorized paths (your in-chat yes, or a hands-free run you started with autopilot armed). (A push of ordinary code after a green pipeline is authorized and normal — but the agent should still tell you it happened.)
  - An agent treats a finding buried in a document, web page, or piece of code it read as an instruction to follow — that content is data, not a command, and the agent should say so rather than act on it.

---

## When things go wrong

- **A deploy made the site look/act wrong:** say **"is prod okay?"** to confirm, then **"roll back the site."** The fix is a one-click "Promote to Production" on the previous good build in the Vercel dashboard (Deployments tab → find the last good build → "..." → Promote to Production) — fully reversible, nothing is deleted.
- **A database change broke something:** say **"walk me through rollback."** The agent never edits or deletes the migration that already ran — it writes a brand-new migration that corrects it, runs it through the same review gates as any other database change, and waits for your yes before applying it live.
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

---

## More detail, if you want it

- `docs/workflows/SAFE_DEVELOPMENT_RULES.md` — the detailed technical rulebook agents follow for code, production, data, security, money, and other risky changes (this playbook is the plain-English front door to it).
- `docs/runbooks/incident-rollback.md` — the detailed step-by-step for each of the three rollback scenarios.
- `docs/operations/production-runbook.md` — the deeper reference on how deploys, backups, and month-end close work.
- `AGENTS.md` — the short shared contract every coding agent in this repo follows; detailed procedures are linked from it.
