---
tags: [start-here, team]
---

# Working with Taha

← [[Home]] · see also [[How-to-Use-This-Vault|How to Use This Vault]]

How Mason (owner) and Taha K. (developer) work together on CRX Manager. Mason's own words on how he thinks are at the bottom of Goals and Vision (in Mason's private notes, `crx-notes`). Read that first.

## Who does what

| | Mason | Taha |
|---|---|---|
| **Decides** | What the business needs, priorities, money and risk trade-offs | How to build it: the technical approach, code structure, tools |
| **Owns** | The goals, the [[manual/DECISION_LOG\|Decision Log]], pesticide compliance, inventory readiness, opening balances | The code changes he takes on, their tests, and proof that they work |
| **Approves** | Anything that can't be undone (see below) | His own technical choices, within the rules in this vault |

AI agents (Claude and Codex) also build and review much of the code. They follow the same rules, and their work arrives as pull requests too.

## Access

- **GitHub:** outside collaborator with admin access to the `croprxsolutions/CRX_Manager_V1.0` repository (Mason's decision, 2026-10-28).
- **Supabase:** Mason is adding Taha as an Administrator of the organization. Mason stays the Owner. That role covers every project in the organization.
- Turn on two-factor sign-in for both accounts. Admin access can reach the live database and its keys.
- Where every service, key and account lives: [[manual/SERVICES_AND_ACCOUNTS|Services and Accounts]]. It lists names and locations only, never values.

## Your job, and what's in scope

**The job:** stabilize, clean up and prove what already exists. No new features unless Mason asks.

**The deadline:** selling starts in the **second week of December 2026**. By then quoting, pre-booking, delivery, inventory, cost tracking and product pricing must be stable (Mason, 2026-10-16). Chem Man's last bill is 2026-12-31.

| In scope | Not in scope (for now) |
|---|---|
| Customers and the product catalog | Field application jobs and field invoicing, field maps, blend tickets |
| Monthly bulk price updates and price history | Compliance and EPA features |
| Cost tracking and margins | Crop programs, rebates, call lists, extra dashboards |
| Quotes, orders and deliveries | Redesigning accounts payable or commission payments |
| Chemical-sale invoicing | QuickBooks, Stripe, backups |
| Payments, prepay and receivables | |
| Inventory | |
| Core reports: sales, inventory, cost and margin, receivables | |

Field application is out of scope because it's already at Chem Man parity (see Chem Man vs CRX (in Mason's private notes, `crx-notes`)). Don't break it, though.

**Where to start:** the verified bug list Mason shares with you privately (it isn't in this public repo). The items in the December scope come first. Then the [[manual/TO_DO_LIST|To-Do List]].

## Ask Mason first

Admin access makes these possible. Don't do them without Mason's explicit OK in your conversation with him:
- changing the live database outside a reviewed migration, or applying a migration that deletes data;
- deleting any business data;
- deploying an Edge Function or making any production change outside the normal merge;
- changing secrets, logins, permissions, billing, domains or account ownership;
- force-pushing, or anything that rewrites shared history.

Everything else is your call. Mason would rather hear "here's what I did and how I proved it" than be asked about technical details.

## How work flows

1. **Pick work from the [[manual/TO_DO_LIST|To-Do List]].** It's in Mason's approved build order. Say which row you're taking, so you don't collide with an agent session working on the same thing.
2. **Branch from current `main`.** Nobody can push straight to `main`; GitHub blocks it.
3. **Open a pull request.** Write the description in plain English: what changes for the business, what could go wrong, and how you proved it works.
4. **Required checks must be green.** Changes that touch money, invoices, payments, inventory or cost get extra review. The full landing procedure is in `.claude/commands/ship.md` and `AGENTS.md`.
5. **Database changes go in a new migration file.** Never edit one that's already been applied. See [[workflows/DATABASE_CHANGE_CHECKLIST|Database Change Checklist]].
6. **Record what shipped.** Add a dated file in `changelog.d/`, and update [[manual/CURRENT_STATE|Current State]] or [[manual/KNOWN_ISSUES|Known Issues]] if they changed.

## Talking to Mason

- **Lead with the outcome,** in plain English: what's different now for the business.
- **Give one recommendation,** not a menu, unless it's truly his decision.
- **"Done" means you ran it and saw it work,** on the real screen or the real data path. Passing tests alone don't count.
- **Say what isn't verified yet** and what the risk is.
- **Decisions get written down.** When Mason decides something, add it to the [[manual/DECISION_LOG|Decision Log]] so nobody has to ask twice.

## Your first week

1. Get a local copy running: [[SETUP-NEW-MACHINE|Setup on a New Machine]].
2. Read [[manual/AGENT_ONBOARDING|Onboarding]] and [[manual/ARCHITECTURE|Architecture]], then the [[Codebase-Map|Codebase Map]].
3. Learn the business rules: [[workflows/QUOTE_TO_DELIVERY|Quote to Delivery]], [[workflows/INVENTORY_RULES|Inventory Rules]] and [[workflows/RLS_SECURITY_GUIDE|Who can see what]].
4. Read Plans and Roadmap (in Mason's private notes, `crx-notes`) and the [[manual/TO_DO_LIST|To-Do List]] to see what matters before January 1, 2027.
5. Skim the [[manual/DECISION_LOG|Decision Log]] so you don't reopen settled questions.
6. Read [[Lessons-Learned|Lessons Learned]]: the mistakes that already cost CRX time.

## Notes between us

Use this vault for anything you both need to remember. Add a dated note in `plans/`, or a line under a heading here. Questions for Mason can go in the list below, and he answers them in place.

### Open questions for Mason

-
