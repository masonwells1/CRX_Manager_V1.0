# CRM Relationship-Intelligence Loop — Ledger

Mission: `docs/loops/crm-relationship-intelligence-loop-2026-07-16.md` · Branch: `feat/crm-relationship-intelligence-2026-07` (from origin/main @5070fa1f) · Worktree: `C:\CRX_CRM`
Started: 2026-07-16 · Orchestrator: Claude Fable 5 · Advisor: Sol (gpt-5.6-sol, xhigh) · Builders: gpt-5.6-terra / gpt-5.6-luna / Claude subagents (fallback Opus 4.8 / Sonnet 5)

Row format:
`| unit | builder | status | commit | PROOF — Ran: … · Saw: … |`
Statuses: TODO / BUILDING / GATE / DONE / PARKED(reason)

## Phase 1 — Contacts + call logging
| unit | builder | status | commit | proof |
|---|---|---|---|---|
| 1.1 contacts+identities migration | terra | DONE | 762d04dc (pre-rebase 425e4c4b) | PROOF — Ran: full gauntlet (RLS CLEAN ×2 incl. final-bytes delta, drift CLEAN ×2, Codex APPROVE round 3) then LIVE apply via migration-apply-guard w/ hash-bound proofs · Saw: {success:true}; 134/153 customers backfilled primary contacts, 39 phones E.164-normalized, RLS on ×4 tables; live trigger test on [E2E] Farm Beta: legacy phone edit → contact card synced + normalized to +15551234567, restore synced back, ambiguous 555-0002 correctly left NULL |
| 1.2 interactions+transcripts migration | terra | DONE | fb5f483a (pre-rebase 41732267) | PROOF — Ran: same gauntlet (Codex APPROVE round 2 after provenance-freeze fix) then LIVE apply · Saw: {success:true}; tables live w/ RLS; provenance immutability + rep source='rep' pinning in force |
| 1.3 types + registry | terra | DONE | b96fb1dc (pre-rebase d072750e) | PROOF — Ran: npm run typecheck (myself, not just builder claim) · Saw: tsc clean; 76 lines, 4 interfaces + 6 unions matching live schema exactly (phone_e164 spot-checked); registry refresh from live introspection delegated, in flight |
| 1.4 contacts UI | terra + opus fallback | DONE | e498c921+6b2f4b2b | PROOF — Ran: lint 0 err + typecheck + 3503 vitest + build (orchestrator-run, not builder claim) · Saw: green; promotion routed through set_primary_customer_contact RPC (applied live 20260716170559, smoke: [E2E] promote/restore round-trip w/ legacy sync verified); typed queries after supabase.ts regen |
| 1.5 log-call flow | terra + opus fallback | DONE | e498c921+6b2f4b2b | PROOF — same gate · Saw: green; RLS pins satisfied (created_by=self, source='rep', provider NULL — verified vs live policy); occurred_at validated pre-write; interaction-first ordering; partial-success path |
| 1.6 timeline integration | terra + opus fallback | DONE | e498c921+6b2f4b2b | PROOF — same gate · Saw: green; onLogged refresh wired; header wraps at 375px |
| 1.G phase gate (Sol → PR → merge → live smoke) | orchestrator | DONE | 41576653 (main) | PROOF — Ran: Sol r1 BLOCK (5 findings→fixed) → r2 BLOCK (2 narrow→fixed: typed RPC after 2nd types regen; ledger rebase provenance) → r3 **APPROVE**; PR #145 all checks green, squash-merged 2026-07-16T17:55:34Z · Saw: prod deploy dpl_URLkko5 READY; deployed chunk CustomerDetail-syS5-JLa.js on croprxsolutions.app contains set_primary_customer_contact (grep=1) — live users are served Phase 1 |

## Phase 2 — Grower intelligence + prep card
| unit | builder | status | commit | proof |
|---|---|---|---|---|
| 2.1 customer_facts migration | terra | GATE | staged | PROOF — Ran: lint+typecheck+build+full vitest (terra) · Saw: green; 20260716181306_crm_customer_facts.sql; gauntlet next |
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
- **Top-products ranking metric** — default chosen: invoiced revenue; Mason may prefer quantity for chemistry-volume thinking. (Sol, Phase 2 sign-off)
- **Web-store facts: must every one cite a customer_interaction?** — deferred to Phase 5 design (may need a second immutable external-event reference).
- **save_customer lets ANY sales rep edit ANY customer (incl. credit limit / finance / commission fields)** — pre-existing live gap found by Codex during the Phase-1 gate, NOT created by this loop. Default chosen: left unchanged here (changing a live SECDEF RPC's authorization is its own reviewed change); a task chip was spawned for a dedicated fix session. Mason decides: should non-assigned reps be allowed to edit customers at all (office-manager workflow), or restrict to assigned rep + admin?
- **Default phone region for E.164 normalization** — default chosen: US (+1). (Sol, Phase 1 sign-off)
- **Recording/AI-disclosure wording** — default: standard "this call may be recorded" + AI self-ID; Mason to approve final wording before the voice vendor goes live (Phase 5, out of this loop).
- **Transcript/recording retention + purge procedure** — default: `retention_expires_at` column exists but NO auto-purge is built in this loop; purge design deferred.

## Phase 5 design notes (carry forward)
- Provenance guard trigger fires for service role too (auth.uid() NULL → is_admin() false). The AI-intake endpoint must INSERT provenance (provider/external_call_id) with the row and never UPDATE it afterward — or Phase 5 adds a service-role bypass to the guard. (RLS re-verify note, 2026-07-16.)

## Cycle log
- 2026-07-16 ~18:1x — **PHASE 1 SHIPPED**: PR #145 merged (squash 41576653), prod deploy verified by chunk grep. Phase 2 branch feat/crm-phase2-grower-intel cut from merged main (squash-orphan gotcha avoided). Sol Phase 2 sign-off: **VERDICT: AMEND** — 8 amendments adopted: facts get supersession history (never edit verified rows; UNIQUE current-verified per (customer, category, fact_key)); reviewed_by/at replaces verified_* (rejected rows need attribution too); status transitions pending→verified|rejected only; reps CAN verify facts (admin+assigned-rep pattern; direct UPDATE revoked, review via idempotent RPCs); provenance-immutability trigger (no admin rewrite escape); composite FK so facts can't cite another customer's interaction; purchase intel = STABLE SECDEF RPCs w/ in-body authz (match get_customer_statement, NOT get_customer_summary), invoices posted|paid|overdue non-credit only, stored season, no new indexes; one get_customer_prep_card RPC.
- 2026-07-16 ~17:0x — Sol PHASE GATE (1.G round 1): **BLOCK** — 2 HIGH (primary-promotion partial-commit w/ false-fail; interaction+follow-up partial-commit/orphan) + 3 MED (stale generated types w/ casts; timeline not refreshed after log; 375px header overflow). All 5 accepted. Types refreshed from live (+4 CRM tables, typecheck clean). Codex builder hit persistent sandbox write-denial on files a prior codex session created (my shell writes fine — codex-specific quirk) → mission fallback invoked: Opus subagent builds the fix set incl. new set_primary_customer_contact migration (atomic promotion, SECURITY INVOKER).
- 2026-07-16 ~15:4x — Codex gauntlet round 1 (at abbcd02f (pre-rebase cac6652c)): BLOCK ×2. File 2 provenance forgery = real gap → FIXED (fb5f483a (pre-rebase 41732267)). File 1 block = PRE-EXISTING save_customer ownership gap (any rep can edit any customer incl. credit fields via SECDEF RPC) → confirmed live, spawned separate remediation task (task chip) + parked question below; counter-analysis sent to Codex round 2. RLS+drift re-verify of final bytes dispatched in parallel.
- 2026-07-16 ~13:xx — RLS reviewer CLEAN (0 blockers; H1/M1 recs implemented); drift reviewer CLEAN (0 blockers; M2 rec implemented). Live pre-apply checks green (ordering vs gauntlet_* migrations, zero object collisions, customers_update policy compatible with sync triggers). Hard-guard catch: rpcContracts fail-closed test forced classification of the two sync trigger fns.
- 2026-07-16 ~12:3x — Sol Phase 1 design sign-off: **VERDICT: AMEND** (8 amendments — role-scoped RLS incl. driver/applicator exclusion from notes/transcripts; contact integrity constraints + single-primary partial unique; E.164 validate-or-NULL; external_identities narrowed to provider-issued IDs (`provider`, `verified_at/by`, composite FK); backfill skips blanks/never aborts + pre-apply aggregate; legacy-field sync = guarded bidirectional DB triggers (UI-only sync unsafe — bulk import writes customers directly); interactions get created_by/CHECKs, follow_up_note_id CUT in favor of team_notes linked_entity; transcripts unique per interaction, raw payload jsonb CUT for now, granular consent fields). All adopted into unit briefs. No money-engine touchpoint.
