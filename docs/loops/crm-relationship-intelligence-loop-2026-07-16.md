# CRM Relationship-Intelligence Loop — 2026-07-16

Mason's goal (2026-07-16, in-chat): build the native CRM module — contacts, call logging + follow-ups,
grower knowledge (facts), purchase intelligence, seasonal worklists, documents — designed so the future
AI voice receptionist and the WooCommerce store bolt in later as intake channels with zero rework.
Design settled in memory `project_crm-relationship-intelligence-design-2026-07-16` (+ `crm-woocommerce-future-channel`).
Phase 5 (AI intake endpoints) and all WooCommerce sync are OUT of this loop by Mason's decision.

## Harness slots

- **Driver:** Claude Fable 5 orchestrates (judgment only — delegate heavy reads to subagents; run orchestration
  at high effort, reserve max effort for the final adversarial gauntlet). **Sol advises**: Codex CLI
  `codex exec --cd C:/CRX_CRM -m gpt-5.6-sol -c model_reasoning_effort="xhigh" --sandbox read-only` at every
  phase boundary — design sign-off BEFORE each phase's first migration is written, adversarial verdict AFTER the
  phase lands. **Builders:** Codex `gpt-5.6-terra` (`--sandbox workspace-write`) for schema/RPC/matching-logic
  units; `gpt-5.6-luna` or Sonnet 5 subagents for lighter UI units. Fallback (Mason-approved pattern from prior
  loops): Codex credit/quota failure → Opus 4.8 / Sonnet 5 subagents build under the same contract; do not stop
  the loop. Next cycle triggers automatically when the previous unit's gate is green and its ledger row is written.
- **Granularity:** one unit = one committed, gate-green change set (one migration, or one UI feature slice).
  Every migration is its own unit with its own review gate. No unit spans phases.
- **Worktree:** `C:\CRX_CRM`, branch `feat/crm-relationship-intelligence-2026-07` (from origin/main @5070fa1f).
  No other tree, no other branch. Step 0 below prepares it.
- **Definition of done:**
  - *Per unit:* `npm run typecheck` + lint + full vitest + production build green in C:\CRX_CRM; Codex builder
    self-reviews its own diff; ledger row with `PROOF — Ran: … · Saw: …`.
  - *Per phase:* migrations applied LIVE through the full gate (below); phase PR opened → Vercel check green →
    squash-merged to main; live smoke proof (open the deployed page or SELECT the new row / call the new RPC —
    tests alone are never proof); `regen-schema-registry` refreshed after any DDL apply; ledger phase block complete.
  - *Loop:* Phases 1–4 all DONE (or explicitly PARKED with reason) + the **final double adversarial gauntlet**
    passed — (a) fresh-context Claude review agents (compliance-reviewer, rls-security-reviewer on the full delta,
    typescript-types-drift-reviewer) AND (b) Sol at xhigh independently reviewing the whole diff vs 5070fa1f —
    every BLOCKER/HIGH fixed and re-reviewed by BOTH before the loop may be declared finished; then morning
    report + memory update.
- **Delivery gate:** Mason approved (2026-07-16, in-chat, AskUserQuestion): **fully live, armed.**
  - Live migration applies are hands-free ONLY through migration-apply-guard's full proof gate: `/migration-review`
    verdict (rls-security-reviewer + migration-drift-reviewer named in a hash-bound proof) + hash-bound
    `codex-review-mig-<name>.json`, both fresh ≤30min, per the settled 2026-07-13 policy. **Additive DDL only；
    a DESTRUCTIVE migration (DROP/TRUNCATE/DELETE/data rewrite) never applies in this loop — park it.**
  - Land on main ONLY via branch → PR → Vercel check → merge (branch protection; never push main directly).
  - NO edge-function deploys (none are needed for Phases 1–4; if one becomes necessary, PARK that unit for Mason).
  - NO live-data deletion or mutation of existing rows; live writes only additive and only via applied migrations.
  - Stop/pause from Mason = hard halt: checkpoint ledger, stop.

## Step 0 — Worktree prep (once, before cycle 1)

1. `npm ci` in C:\CRX_CRM (pre-commit hooks fail without local node_modules — environmental, never `--no-verify`).
2. Commit this mission doc + ledger as the branch's first commit (also proves pre-commit works; if CRLF-stale
   adapter failures appear, fix via `.gitattributes` eol=lf / `--write` — never bypass).
3. `node .claude/hooks/autopilot-arm.mjs --hours 10` and verify `--status` shows ON (3-state flag: stale/expired
   parks ALL applies — if it lapses mid-loop, park remaining live applies and continue building/committing).
4. `node scripts/validate-mission-doc.mjs docs/loops/crm-relationship-intelligence-loop-2026-07-16.md` → must exit 0.

## Per-cycle protocol (every unit)

1. Orchestrator writes the unit brief (files, contract, done-criteria) → dispatch builder (terra/luna/subagent).
   Parallel builders only with strictly disjoint file lists; one combined gate run after they land.
   Codex runs in background (600s bash cap kills foreground builds); stall watchdog: no rollout file + ~0 CPU
   + no edits within 4 min → kill and re-dispatch.
2. Gate run: typecheck + lint + vitest + build. Red → return to builder (max 2 retries, then orchestrator fixes or parks).
3. Migration units additionally: rls-security-reviewer + migration-drift-reviewer agents, `/migration-review`
   flow, Codex migration verdict, THEN live apply through migration-apply-guard, THEN post-apply smoke
   (single-statement SELECTs — Supabase MCP runs only the LAST statement) + `regen-schema-registry`.
4. Commit the green unit (`git commit --only <paths>` if the tree is shared mid-flight), write the ledger row with PROOF.
5. Phase boundary: Sol advisory (design sign-off for next phase / adversarial verdict on landed phase) →
   open phase PR → Vercel check → merge → live smoke on production → ledger phase block.

## Worklist

### Phase 1 — Contacts + call logging (builder: terra)
- **1.1** Migration `crm_contacts_identities`: `customer_contacts` (customer_id, name, role, phone_e164,
  phone_display, email, preferred_contact_method, is_primary, can_place_orders, is_decision_maker,
  is_billing_contact, is_active, notes) + `external_identities` (customer_id, contact_id nullable, source
  ['phone','email','woo','voice_provider',…], external_id, verified, unique(source, external_id)) — E.164
  normalization helper (IMMUTABLE SQL fn), backfill one contact per existing customer from
  customers.contact_name/phone/email, RLS (authenticated per existing policy patterns), updated_at triggers, indexes
  (phone_e164, email lower).
- **1.2** Migration `crm_interactions`: `customer_interactions` (customer_id, contact_id, type
  ['call','visit','meeting','text','email','voicemail'], direction, source ['rep','ai_receptionist','system','web_store'],
  occurred_at, duration_seconds, outcome, summary, owner_user_id, external provider + external_call_id with
  UNIQUE(provider, external_call_id) partial index, consent/disclosure fields, follow_up_note_id → team_notes)
  + `interaction_transcripts` (interaction_id, provider payload jsonb, transcript, ai_summary, extraction jsonb,
  recording_path, retention_expires_at). RLS both. Additive only.
- **1.3** Types + registry: extend `src/types/index.ts`; run typescript-types-drift-reviewer; refresh schema registry.
- **1.4** UI — Contacts: CustomerDetail "contacts" section/tab (list, add, edit, primary/role flags, click-to-call
  `tel:` links); customer create/edit keeps legacy fields in sync with the primary contact.
- **1.5** UI — Log call: 30-second flow, mobile-first (modal from CustomerDetail + a global "Log call" on the
  interactions page): contact picker (default primary), type/direction/outcome chips, note field, optional
  follow-up (creates team_notes todo w/ assignee+due date, linked), writes customer_interactions + activity_feed
  via existing logActivity pattern.
- **1.6** UI — Timeline integration: interactions render on the CustomerDetail timeline tab; an "Interactions"
  history list with filters (type, outcome, owner, date).
- **1.G** Phase gate: Sol verdict → PR → Vercel → merge → live smoke (log a real [E2E] call against an [E2E] test
  customer on production, then verify the row + timeline entry).

### Phase 2 — Grower intelligence + prep card (design sign-off by Sol first; builder: terra, UI: luna)
- **2.1** Migration `crm_customer_facts`: customer_facts (customer_id, category — CONTROLLED list:
  product_preference, constraint, operating_preference, agronomy, relationship, communication — key, value_text,
  value_json, status ['verified','pending_review','rejected'], confidence, source ['rep','ai_receptionist','system','web_store'],
  source_interaction_id, entered_by, verified_by, verified_at, expires_at), RLS, indexes.
- **2.2** UI — Facts on CustomerDetail: add/verify/reject/edit; verified facts prominent, pending clearly marked;
  plus a small global "pending review" queue view (empty until AI arrives — proves the review pattern).
- **2.3** UI — Prep card: compact top-of-CustomerDetail card + mobile view: who to call (primary contact, preferred
  method), acres/crops/tier, balance/credit flag, last purchase, last conversation, open quote/order/delivery,
  top 3–6 verified facts, open follow-ups, one-tap call.
- **2.4** Purchase intelligence: read-only SQL views/RPCs (season purchase summary per customer; bought-last-season-
  not-this-season; top products by customer) + "Purchases" intelligence section on CustomerDetail. NO changes to
  existing money RPCs/tables.
- **2.G** Phase gate (as 1.G).

### Phase 3 — Seasonal worklists (builder: terra for RPCs, luna for UI)
- **3.1** Read-only call-list RPCs: prepay prospects (prior-season spend, no current prepay), no-contact-since-X
  (per rep/territory), expiring/stale quotes, lapsed-product accounts, unassigned/new accounts. All SECURITY INVOKER
  or SECDEF-with-search_path per project rules; revoke anon.
- **3.2** UI — Call Lists page (new page: lazy route, Sidebar "Customers & Fields" group, mobile nav check,
  user_page_permissions registration): list picker + filters (rep, tier, crop, last-contact), each row → prep-card
  peek + one-tap call + Phase-1 log-call flow.
- **3.G** Phase gate (as 1.G).

### Phase 4 — Customer documents (builder: luna/Sonnet)
- **4.1** Migration `crm_customer_documents`: metadata table (customer_id, contact_id nullable, document_type
  controlled list, storage_path, filename, mime_type, size_bytes, uploaded_by, source, effective_date,
  expiration_date) + private Supabase Storage bucket `customer-documents` with owner-scoped storage policies
  (bucket/policy DDL additive; if bucket creation cannot be done via migration/MCP without a gated action, PARK 4.1).
- **4.2** UI — Documents tab on CustomerDetail: upload (size/type limits), list, download via signed URLs, delete =
  soft-delete flag only (no hard deletes in this loop).
- **4.G** Phase gate (as 1.G).

### Final gauntlet (loop close)
- Full-delta double adversarial review (Definition of done, *Loop* bullet). BLOCKER/HIGH → fix unit → BOTH
  reviewers re-verdict. Then: morning report in `docs/loops/crm-relationship-intelligence-morning-report.md`
  (plain English for Mason: what shipped, what's parked, proof links, owner decisions), update
  `docs/CHANGELOG.md` + relevant `docs/manual/` files, save auto-memory status update.

## Build rules (all builders; goes into every dispatch prompt)
- Money in cents; `assertRpcResult`/`checkMutationResult` on every RPC/mutation; no `confirm()`/`alert()`;
  Sentry from lib; logActivity shape per `src/lib/activityLogger.ts`; no `@ts-ignore`/`any`; no service_role in
  frontend; `&mdash;` in JSX; store-cents/edit-dollars pattern where money renders.
- New tables ALWAYS: RLS enabled + policies, updated_at trigger (project convention), created_at/updated_at.
- New SECDEF functions: `SET search_path`, REVOKE from anon/PUBLIC (bit us before — memory `codex-driven-debug-loop`).
- Additive-only DDL. Never edit existing money/inventory RPC bodies. Grep other PENDING migrations before
  re-emitting any function (pending-overlap clobber gotcha).
- Reuse `activity_feed` + `team_notes`; build NO second activity or task system. No new deps without parking the unit.
- Live-DB smoke tests: only [E2E]-prefixed fake entities; single-statement SQL via MCP.

## Parked-question policy
Any decision needing Mason: write it in the ledger under "Parked questions", choose the reversible default, keep
moving. Never park the whole loop for a preference question; DO park (not improvise) anything touching the hard
gate list.
