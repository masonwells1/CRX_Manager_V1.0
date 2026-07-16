# CRM Relationship-Intelligence Loop — Ledger

Mission: `docs/loops/crm-relationship-intelligence-loop-2026-07-16.md` · Branch: `feat/crm-relationship-intelligence-2026-07` (from origin/main @5070fa1f) · Worktree: `C:\CRX_CRM`
Started: 2026-07-16 · Orchestrator: Claude Fable 5 · Advisor: Sol (gpt-5.6-sol, xhigh) · Builders: gpt-5.6-terra / gpt-5.6-luna / Claude subagents (fallback Opus 4.8 / Sonnet 5)

Row format:
`| unit | builder | status | commit | PROOF — Ran: … · Saw: … |`
Statuses: TODO / BUILDING / GATE / DONE / PARKED(reason)

## Phase 1 — Contacts + call logging
| unit | builder | status | commit | proof |
|---|---|---|---|---|
| 1.1 contacts+identities migration | terra | TODO | — | — |
| 1.2 interactions+transcripts migration | terra | TODO | — | — |
| 1.3 types + registry | terra | TODO | — | — |
| 1.4 contacts UI | terra | TODO | — | — |
| 1.5 log-call flow | terra | TODO | — | — |
| 1.6 timeline integration | terra | TODO | — | — |
| 1.G phase gate (Sol → PR → merge → live smoke) | orchestrator | TODO | — | — |

## Phase 2 — Grower intelligence + prep card
| unit | builder | status | commit | proof |
|---|---|---|---|---|
| 2.1 customer_facts migration | terra | TODO | — | — |
| 2.2 facts UI + review queue | luna | TODO | — | — |
| 2.3 prep card | luna | TODO | — | — |
| 2.4 purchase intelligence | terra | TODO | — | — |
| 2.G phase gate | orchestrator | TODO | — | — |

## Phase 3 — Seasonal worklists
| unit | builder | status | commit | proof |
|---|---|---|---|---|
| 3.1 call-list RPCs | terra | TODO | — | — |
| 3.2 Call Lists page | luna | TODO | — | — |
| 3.G phase gate | orchestrator | TODO | — | — |

## Phase 4 — Customer documents
| unit | builder | status | commit | proof |
|---|---|---|---|---|
| 4.1 documents migration + bucket | luna | TODO | — | — |
| 4.2 documents UI | luna | TODO | — | — |
| 4.G phase gate | orchestrator | TODO | — | — |

## Final gauntlet
| step | reviewer | status | verdict |
|---|---|---|---|
| Claude fresh-context review agents (full delta) | compliance / rls-security / types-drift | TODO | — |
| Sol adversarial review (full delta, xhigh) | gpt-5.6-sol | TODO | — |
| Morning report + docs + memory | orchestrator | TODO | — |

## Parked questions (owner decisions — reversible default chosen, keep moving)
_(none yet)_

## Cycle log
_(append-only; one line per dispatch/gate event with timestamp)_
