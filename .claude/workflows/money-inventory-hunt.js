export const meta = {
  name: 'money-inventory-hunt',
  description:
    '2026-07-10 night variant of the overnight bug hunt, re-aimed at the money + inventory + workflow surface built since 2026-06-20 (Layer 2 job reservations, U7 split invoicing, U8 job commissions, credit-memo apply, U16 batch posting, A5/D2 unit conversions, U14-U20 workflow waves). Each cycle fans out one Opus agent per subsystem to hunt the 8 recurring bug classes against the live DB, then adversarially refutes every finding before it counts. Read-only — never mutates the DB or edits files. The command layer adds the Codex finding-gate, the fix, and the Codex fix-gate on top.',
  whenToUse:
    'The find+verify core of the 2026-07-10 money/inventory night hunt. Phase 1 = money engine + new-surface. Phase 2 = inventory + workflow wiring. Pass args = { phase: 1 } or { phase: 2 } or { only: ["invoices-core", ...] } to slice one cycle.',
  phases: [
    { title: 'Find', detail: 'One agent per subsystem — deep hunt for the 8 bug classes across code + live DB' },
    { title: 'Verify', detail: 'Adversarially refute each finding against the live DB / current code' },
  ],
}

// ===========================================================================
// The 8 recurring bug classes — distilled from ~90 fix commits in the last 20
// days. Every finder hunts THESE CLASSES, not just "read this file". This is
// what makes the hunt find new instances instead of re-reading old fixes.
// ===========================================================================
const BUG_CLASSES = [
  '1. IDEMPOTENCY — a mutating RPC that (a) reads/writes idempotency_keys with the wrong columns (correct: idempotency_key / operation / result; NEVER key / entity_type / entity_id / result_id), (b) does an UNSCOPED lookup not filtered by operation=\'<this_rpc>\' (returns another op\'s cached row — the restore_quote_version bug class), (c) DECLARES p_idempotency_key but the body never uses it, or (d) has no p_idempotency_key at all on a money/inventory write.',
  '2. FORGEABLE ACTOR — a mutating financial/inventory RPC that trusts a p_performed_by / p_actor param instead of binding to auth.uid() and rejecting a mismatch with ACTOR_MISMATCH (canonical: v_actor := auth.uid(); IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE ...). A forged actor into financial_audit_log is a BLOCKER.',
  '3. MONEY-CENTS — parseFloat/float math on a *_cents value; dollars-vs-cents mixups; penny-drift where each share/line is round()\'d independently so the parts don\'t sum to the whole (commission splits, payment allocation, split invoices, per-acre machine fees, recipe per-unit pricing); any UPDATE that writes invoices.balance_cents (GENERATED ALWAYS — writing it is a bug). (Accepted: commissions.commission_amount is numeric dollars by design.)',
  '4. CONCURRENCY — a read-modify-write on inventory / holds / prebooked / a balance / a number-reservation with NO `FOR UPDATE` row lock (or no advisory lock), so two concurrent calls race (double-release, double-spend, duplicate number). cancel_delivery/void_delivery/quick-delivery release paths are the known hot spot.',
  '5. STALE-DERIVED-STATE — an edit path (update_order_items, recipe/job edit, field-invoice edit, same-product order edit) that recomputes one total but leaves a sibling derived value stale: total_profit / net_margin_pct / commissions / total_cost_cents / invoices.total_cost_cents / a report-feeding per-line column. These feed get_sales_detail_report and commissions and DON\'T throw — they\'re silently wrong.',
  '6. LIFECYCLE / SEGREGATION — a status string written by frontend or RPC that is NOT in the live CHECK constraint for that table (the void/voided class — read pg_constraint and compare); a documented lifecycle transition that no trigger/RPC actually enforces; an invoice-type leak (field_application rows showing in chemical-sales lists, or vice-versa); a route/edit-lock that can be bypassed by direct URL or once status is past the editable point.',
  '7. UNCHECKED-ERRORS / TYPE-GUARDS — a supabase .update()/.delete() not followed by checkMutationResult(); an RPC result used without assertRpcResult(); a Supabase { error } ignored; an untyped cast / select(*) that silently tolerates a renamed column; a page that throws blank on a null.',
  '8. AUDIT-LOG-COMPLETENESS — a mutating money RPC (invoice create/void, payment, write-off, credit memo, commission payout) that does NOT write the matching financial_audit_log row, so the append-only ledger is incomplete. Compare each money mutator against create_invoice_from_order as the reference.',
].join('\n')

// ===========================================================================
// KNOWN — already found + dispositioned by the 2026-06-15/16 nightly-debug
// mission, or accepted-by-design. Finders DROP these (report only NEW signal).
// Sourced from docs/audits/nightly-debug/{LEDGER,accepted-findings}.json.
// ===========================================================================
const KNOWN_DROP = [
  'ACCEPTED BY DESIGN (never report): profile_public_view uses SECURITY DEFINER semantics by design; the ~53 anon-executable SECURITY DEFINER functions are accepted inert grant-debt (each self-gates on auth.uid()/require_admin as its first statement); commissions.commission_amount is numeric dollars by design; reportPdf.ts columnStyles uses the one allowed `any`; customer RLS is intentionally lower-bound-only; the leaked-password toggle is an owner dashboard item; invoices has NO order_id-OR-blend CHECK by design (RPC convention; credit memos exempt).',
  'ALREADY FIXED LIVE by nightly-debug (do NOT re-report): save_quote canonical idempotency + transition-map trim (20260616204400); void_delivery canonical idempotency rich-replay (20260616201800); blend-ticket + field-app invoice_created audit rows (20260616191740); delete_invoices admin-only audited soft-delete (20260617031416); the invoice paid-status dead-end guard (20260616120604); allocate_payment sum<=total guard (20260616121105); order_shares aggregate-100% guard (20260616121521); quote terminal-not-drawn \'expired\' guard (20260616115308); create_quick_delivery stamps invoice.delivery_id; complete_delivery partial re-bill joins on order_item_id; void_order logs void_delivery_reversal; cancel_delivery prebook-release + lock-order-before-quick-cancel; update_order_items same-product per-line profit/margin refresh (20260617123503); blend-ticket link/unlink actor bound to auth.uid() (a3ba49c); commission recompute on order-item edit (4b93cdc).',
  'KNOWN-PARKED / KNOWN-DEFERRED (do NOT re-surface as new — reference the artifact if you find a NEW angle): delivery_items terminal-states-unlocked lock (PARKED-05, folded into update_order_items rewrite); create_split_invoices_from_order multi-field per-line rounding (needs field-aware redesign, dormant on live); draw_down_quote weighted-avg price is an accepted v1 simplification; create_prepay_credit was DROPPED live 2026-07-03 (mig 20260702180000) — do not report it as unused OR as missing; the freeform-vs-SCREAMING_SNAKE auth-error token sweep is a deferred owner decision.',
  'KNOWN AS OF 2026-07-10 (also drop): the 13 built-but-unapplied fix migrations 20260620120000–20260620240000 are PARKED awaiting Mason (do not re-report their underlying findings as new — they are in docs/audits/overnight-bug-hunt/LEDGER.json); D3 blend-path commission mint is dormant-by-owner-decision; jobs.commission_split RLS visibility is an owner call; the dispatch backfill is parked (0 rows live); per-field $/acre overrides on multi-owner spray jobs are refused by design (SPLIT_OVERRIDE_UNSUPPORTED); auto-invoice-on-completion and the label-rate hard-block ship OFF/warn by design; the U18/U18c morning cron + close-period guards were freshly fixed for UTC-vs-Chicago on 2026-07-10 — verify against the LIVE function bodies before claiming a timezone bug; ~105/204 stored EPA reg numbers are known-wrong (Waves 4-5 backfill parked) — not a new finding.',
].join('\n')

const PREAMBLE = [
  'You are hunting REAL bugs and flawed logic in the CRX Manager codebase (React 18 + TypeScript + Vite + Supabase + Tailwind) at the repo root of THIS worktree. It is a production agricultural-retail ERP. Money is stored as bigint cents (display ÷100).',
  '',
  'GROUND TRUTH: Use the actual repo on disk AND the LIVE Supabase database (production project id rhyzpcqhnizqbxphqdkr). The Supabase MCP tools are available — load them with ToolSearch (e.g. query "execute_sql"). You MAY run read-only SQL (SELECT, pg_catalog, information_schema, pg_get_functiondef) to ground every finding. The live DB reflects `main`; this worktree is based on `main`, so code and live DB are coherent.',
  '',
  'HARD RULES (do not violate):',
  '- READ-ONLY. NEVER call apply_migration. NEVER run mutating SQL (no INSERT/UPDATE/DELETE/DDL). SELECT + introspection only.',
  '- Do NOT edit, write, or delete any file. This workflow only FINDS; the command layer fixes.',
  '- Cite hard evidence for every finding: a file:line, a table/function name, or the exact read-only SQL you ran and what it returned. A finding with no concrete evidence is not a finding.',
  '- Read CLAUDE.md + the relevant docs/reference/* for the project\'s own documented rules and ACCEPTED exceptions before flagging anything.',
  '- Prefer precision over volume. Report only what you can substantiate. NO style/naming nits, NO defensive-coding-for-impossible-inputs, NO speculative flexibility. Correctness bugs and Hard-Red-Line / lifecycle / money / RLS / idempotency violations ONLY. At most your 8 most significant findings.',
  '',
  'THE 8 BUG CLASSES YOU ARE HUNTING (find NEW instances of these — this is the whole point):',
  BUG_CLASSES,
  '',
  'DO NOT RE-REPORT THE KNOWN SET:',
  KNOWN_DROP,
  '',
  'For each finding also set:',
  '- dedupeKey: a stable "area:object:one-word-symptom" slug (e.g. "money:transfer_job_to_invoice:per-acre-fee-rounding") so the ledger can dedupe across cycles.',
  '- fixKind: the kind of change a fix would require — one of frontend-only | migration | edge-fn | data | docs-or-test. (This drives the safety tier: frontend-only/docs-or-test = auto-fixable to the branch; migration/edge-fn/data = PARKED for Mason.)',
].join('\n')

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dimension: { type: 'string' },
    summary: { type: 'string', description: 'One short paragraph: what you checked and the overall health of this subsystem.' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          dedupeKey: { type: 'string', description: 'Stable area:object:symptom slug for cross-cycle dedupe.' },
          bugClass: { type: 'string', enum: ['idempotency', 'forgeable-actor', 'money-cents', 'concurrency', 'stale-derived-state', 'lifecycle-segregation', 'unchecked-errors', 'audit-log', 'other'] },
          severity: { type: 'string', enum: ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW'] },
          fixKind: { type: 'string', enum: ['frontend-only', 'migration', 'edge-fn', 'data', 'docs-or-test'] },
          area: { type: 'string', description: 'Subsystem, e.g. "rpc:transfer_job_to_invoice", "page:FieldApplicationInvoice".' },
          file: { type: 'string', description: 'file:line, or table/function name, or the SQL object affected.' },
          evidence: { type: 'string', description: 'What you observed — quote the code or the SQL result.' },
          impact: { type: 'string', description: 'The wrong real-world outcome (wrong money, lost audit row, race, blank page).' },
          recommendation: { type: 'string', description: 'The concrete fix.' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['title', 'dedupeKey', 'bugClass', 'severity', 'fixKind', 'area', 'file', 'evidence', 'impact', 'recommendation', 'confidence'],
      },
    },
  },
  required: ['dimension', 'summary', 'findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    isReal: { type: 'boolean', description: 'true ONLY if independently confirmed with concrete evidence.' },
    revisedSeverity: { type: 'string', enum: ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW', 'FALSE_POSITIVE'] },
    reasoning: { type: 'string' },
    verifiedAgainst: { type: 'string', description: 'Exactly what you checked — the read-only SQL you ran, or the file:line you read.' },
  },
  required: ['isReal', 'revisedSeverity', 'reasoning', 'verifiedAgainst'],
}

// ===========================================================================
// PHASE 1 — the money/billing engine (where the last 20 days of bugs lived).
// PHASE 2 — broad whole-app sweep, run once Phase 1 is drained.
// ===========================================================================
const DIMENSIONS = [
  // ---- Phase 1: the money engine, weighted to the post-2026-06-20 surface ----
  {
    key: 'invoices-core', phase: 1,
    prompt:
      'Hunt the INVOICE CORE + BATCH POSTING. RPCs: post_invoice (incl. the A8 due-date stamping), post_invoice_group (U16 split-group-atomic tray postAll), the U16 batch-post per-invoice client loop + bill-next + Ready-to-Post + chemical Unpost, create_invoice_from_order, save_invoice, void/cancel invoice, delete_invoices, finance charges, close_accounting_period (A9 whole-calendar-month + America/Chicago business-clock guards, mig 20260711000000) + check_period_open on backdated posts. Read each body via live pg_proc. Hunt all 8 classes but especially: idempotency correctness, forgeable actor, the financial_audit_log row on every money mutation (class 8), any UPDATE touching the GENERATED balance_cents, status values vs the live invoices CHECK constraint, and partial-failure holes in the batch/group posting paths (one member fails mid-loop — what state is the group left in?).',
  },
  {
    key: 'credit-memo-ar', phase: 1,
    prompt:
      'Hunt CREDIT MEMOS + AR LEVERS. The credit-memo apply feature shipped ~2026-07-08/10 (issue_return_credit + the credit-memo apply/consume RPCs — find them via live pg_proc). KNOWN CRITICAL CLASS: an invoice balance is moved by MULTIPLE levers (payments, prepay applications, write-offs, credit-memo applications, reconciliation, mark_overdue, record_invoice_payment, void_payment, allocate_payment) — any consumer that computes "amount still owed" inline from a SUBSET of levers is silently wrong. Enumerate every RPC that reads or derives an invoice balance and verify each accounts for ALL levers (invoices.balance_cents is the GENERATED source of truth — flag any inline re-derivation). Also: credit_memo invoice_type exemptions (order_id may be NULL), voiding a credit memo that is partially applied, negative/over-apply guards, prepay_balance_cents exposure in AR aging + reminder candidates, write-off idempotency + audit rows.',
  },
  {
    key: 'jobs-to-billing', phase: 1,
    prompt:
      'Hunt JOBS → BILLING incl. the U7 SPLIT-INVOICE GROUP path. transfer_job_to_invoice now creates a per-owner invoice GROUP for multi-owner spray jobs (one field_application invoice per field_billing_defaults customer via invoices.invoice_group_id; chemical price/cost split penny-exact via calculate_billing_splits; per-member commission via _insert_commissions_for_job). void_invoice / delete_invoices / transfer_invoice_to_job are group-aware (release the job only on last-member void; re-point jobs.invoice_id off a voided anchor; refuse JOB_BILLED_AS_GROUP member reverse). Also: the job-mix 3-way quantity calculator, recipe per-unit pricing, per-acre machine fees, save_job_applied_record idempotency (table-native idempotency_key + partial unique index, mig 20260711020000), auto-invoice-on-completion (auto-DRAFT, OFF by default). Read each via live pg_proc + src/pages/JobDetail.tsx. Especially class 3 (penny-exactness across group members — do the member invoices sum EXACTLY to the single-owner total? cost splits too), class 4 (two concurrent transfer/void calls on one group), class 5 (stale totals after recipe/quantity edit post-transfer), and lifecycle holes (job released while a member invoice still stands).',
  },
  {
    key: 'commissions', phase: 1,
    prompt:
      'Hunt COMMISSIONS incl. the U8 APPLICATION CHANNEL (jobs now mint chemical-line-profit commissions at transfer_job_to_invoice, with generation-precise reversal on void/cancel/transfer-back/delete/payout-void; splits snapshot at job creation). Also the order channel: commission_split JSONB (splits sum to 100), per-order records (pending→paid→cancelled), recompute-on-edit paths, commission_payments batch (unposted→posted→voided), void_commission_payment, the voided-commissions tab wiring. Read save_customer split validation + _insert_commissions_for_job + the reversal paths via live pg_proc. Especially class 5 (an order-item/price/recipe edit AFTER mint — are paid commissions flagged, not silently mutated? does a group-member void reverse ONLY that member\'s generation?), class 3 (rounding when splitting profit across recipients — parts must sum to the whole), and double-mint holes (transfer → void → re-transfer must not duplicate).',
  },
  {
    key: 'deliveries-billing', phase: 1,
    prompt:
      'Hunt DELIVERIES that touch money/inventory, incl. the U15 changes. complete_delivery is now 8-arg with a not-future p_completed_at backdate that becomes invoice_date; the office one-shot Mark Delivered chains confirm+complete; FieldStop redundant-confirm removed; no-one-present signer path. Also confirm_delivery, create_quick_delivery (atomic order+delivery+draft invoice), cancel_delivery, void_delivery, the U7 delivery-half split path. Read each via live pg_proc. Especially class 4 (concurrency — FOR UPDATE on holds/prebooked/order before release; the quick-cancel race; office one-shot vs a phone crew completing simultaneously), class 1 (idempotency shape), class 6 (backdated invoice_date vs check_period_open + a closed month), and the inventory_transactions type written on each path (12 valid types).',
  },
  // ---- Phase 2: inventory + workflow wiring (the other half of tonight's scope) ----
  {
    key: 'inventory-holds-draws', phase: 2,
    prompt:
      'Hunt INVENTORY HOLDS + DRAWS (Layer 2, shipped 2026-07-02/03 + Sprint D 2026-07-10). Objects: inventory holds (types incl. \'job\' + crop_program), quote_product_draws + draw_down_quote (FIFO hold decrement, BOOKING_PARTIALLY_DRAWN), job_product_draws + reserve_job_inventory, the coordinated allocator _sync_quote_job_reservations (rebuilds a quote\'s active jobs together), close_quote_as_applied (releases un-applied leftover holds; terminal closed_by_application), restore_quote_version re-sync, rollover/settlement, D2 reserve-side unit normalization (normalize_rate_unit + field_app_priced_quantity across 4 fns — rate-unit→inventory-unit, the former 8× over-reserve). INVARIANTS: Net Free = available − planned holds − prebooked; a job hold = its FULL application demand (job + chemical channels ADD, never offset); draws cap at the booking (no double-BILL). Read each via live pg_proc + live hold/draw rows. Especially class 4 (concurrent draw_down vs unplan vs job-sync TOCTOU), class 3/5 (unit conversion correctness + stale holds after quote edit/version restore), and release-path completeness (decline/expire/cancel/close each release EXACTLY what they should — no double-release, no orphan holds).',
  },
  {
    key: 'inventory-transactions', phase: 2,
    prompt:
      'Hunt INVENTORY TRANSACTIONS + UNIT CONVERSION. The 12 inventory_transactions types (received, booked, delivered, returned, adjusted, transferred, job_applied, cancelled_delivery_reversal, void_delivery_reversal, prebooked, released, prebook_reconciliation) — verify every writer uses a valid type and the right sign. PO receiving (partial receive, parent-lock B2), cycle counts, adjustments. A5 blend-ticket unit conversion (3 RPCs convert rate/qty→inventory unit + refuse bad/rateless lines; create_order_from_blend_ticket records CONVERTED qty + actor gate, mig 20260705000000). U18 negative-stock = low-stock in all 3 detectors; get_dispatch_stock_status; shortfall/position/forecast job-awareness. Read via live pg_proc + sample live rows (read-only). Especially class 3 (unit math — oz/gal/pt/qt vs inventory unit; the 128× and 8× classes had instances before), class 4 (read-modify-write on quantity_available without FOR UPDATE), and consistency between the transaction ledger and the products quantity columns.',
  },
  {
    key: 'workflow-wiring', phase: 2,
    prompt:
      'Hunt WORKFLOW WIRING for the U14–U20 waves (shipped 2026-07-09/10) + cross-entity flows. get_dispatched_list + _is_dispatched_to_me (7-day tails — completed jobs move to Done), displaced split-assignee un-dispatch notices, crew Start/Complete on JobDetail, Sell & Deliver Now fast path (U14, 2-day product-overlap warning, open-booking banners), office cockpit tiles (chemical-drafts + delivered-not-invoiced, planned-bookings-attention), Email-to-Grower + email_log_select_own policy, per-section hold lines, field-acres cascade, auto-expire → real creator notifications + FK-safe activity actor, the 06:20 pg_cron morning-notification-checks (UTC vs America/Chicago conversion — this bit twice on 2026-07-10), draft Book-as-Order lost-response-safe chaining, convert-on-revised. Especially class 6 (lifecycle holes: booking-resurrection class — an expire/close racing a convert; status writes vs live CHECKs), class 5 (a tile/list whose predicate disagrees with the RPC that acts on it — user acts on a stale row), class 7 (assertRpcResult/checkMutationResult on the new call sites), and timezone correctness on every date-boundary predicate (business time = America/Chicago; live DB runs UTC).',
  },
  {
    key: 'lifecycle-invariants', phase: 2,
    prompt:
      'Hunt BUSINESS-LIFECYCLE correctness across quote/order/delivery/invoice/job/PO/return/commission/commission_payment (lifecycles documented in CLAUDE.md — note the quote lifecycle now includes closed_by_application, terminal, planned-only, and create_job_from_quote_section must reject it). (a) status strings written by frontend or RPC that are NOT in the live CHECK; (b) documented transitions no trigger/RPC enforces (the jobs enforcer cancel-from-terminal item is KNOWN/parked — look for NEW holes, e.g. around invoiced jobs, group-billed jobs, closed_by_application quotes); (c) the delivery two-step + item-lock bypassable via direct RPC or URL; (d) quote draw-down / Net-Free invariant holes; (e) invoice-type segregation (field_application vs chemical vs credit_memo rows leaking into each other\'s lists/reports). Use live pg_constraint + pg_proc.',
  },
]

// args may arrive as an object OR as a JSON-encoded string (the harness sometimes
// stringifies it) — normalize both so { only:[...] } / { phase:N } slicing is reliable.
const A = (() => {
  if (!args) return {}
  if (typeof args === 'string') { try { return JSON.parse(args) } catch { return {} } }
  return args
})()
const SELECTED = (() => {
  if (Array.isArray(A.only) && A.only.length) return DIMENSIONS.filter((d) => A.only.includes(d.key))
  if (A.phase === 1 || A.phase === 2 || A.phase === '1' || A.phase === '2') return DIMENSIONS.filter((d) => String(d.phase) === String(A.phase))
  return DIMENSIONS.filter((d) => d.phase === 1) // default: Phase 1 (billing engine)
})()

function verifyPrompt(d, f) {
  return [
    PREAMBLE,
    '',
    'ADVERSARIAL VERIFICATION. A prior finder (subsystem: ' + d.key + ') reported the finding below. Your job is to REFUTE it. Default to isReal=false unless you independently confirm it with hard evidence against the CURRENT code on disk and the LIVE database (read-only).',
    '',
    'FINDING:',
    '- Title: ' + f.title,
    '- Bug class: ' + f.bugClass,
    '- Claimed severity: ' + f.severity,
    '- Location: ' + (f.file || f.area),
    '- Evidence claimed: ' + f.evidence,
    '- Impact claimed: ' + f.impact,
    '- Recommendation: ' + f.recommendation,
    '',
    'Specifically check:',
    '1. Does the cited file:line / table / function actually exhibit this RIGHT NOW?',
    '2. Is it already mitigated — a trigger, an RLS policy, a PreToolUse hook, a CHECK constraint, a deployed-vs-disk difference, a documented ACCEPTED exception, or already-fixed-live per the KNOWN set above?',
    '3. Is the severity calibrated? Is the bug actually REACHABLE (or is the subsystem dormant — 0 live rows — which caps severity)?',
    '',
    'Set isReal=true ONLY with concrete evidence. Use revisedSeverity=FALSE_POSITIVE if refuted. In verifiedAgainst, state exactly what you ran or read.',
    '',
    'IMPORTANT: finish by returning your verdict via the StructuredOutput tool — never prose-only. If still uncertain, return isReal=false / FALSE_POSITIVE rather than stopping.',
  ].join('\n')
}

// ===========================================================================
// Run: each subsystem hunts, then each of its findings is verified as soon as
// that subsystem finishes (pipeline — no barrier between find and verify).
// ===========================================================================
log('Overnight bug hunt: ' + SELECTED.map((d) => d.key).join(', ') + ' (read-only; ' + SELECTED.length + ' subsystems).')

const results = await pipeline(
  SELECTED,
  (d) =>
    agent(PREAMBLE + '\n\n=== YOUR SUBSYSTEM ===\n' + d.prompt, {
      label: 'hunt:' + d.key,
      phase: 'Find',
      schema: FINDINGS_SCHEMA,
      model: 'opus',
      effort: 'high',
    }),
  (review, d) =>
    parallel(
      ((review && review.findings) || []).map((f) => () =>
        agent(verifyPrompt(d, f), {
          label: 'verify:' + d.key + ':' + f.severity,
          phase: 'Verify',
          schema: VERDICT_SCHEMA,
          model: 'opus',
          effort: 'high',
        }).then((v) => ({
          ...f,
          dimension: d.key,
          phase: d.phase,
          verdict: v,
          finalSeverity: v && v.revisedSeverity && v.revisedSeverity !== 'FALSE_POSITIVE' ? v.revisedSeverity : f.severity,
        }))
      )
    )
)

const all = results.flat().filter(Boolean)
const confirmed = all.filter((f) => f.verdict && f.verdict.isReal)
const refuted = all.filter((f) => !f.verdict || !f.verdict.isReal)

const order = { BLOCKER: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }
confirmed.sort((a, b) => (order[a.finalSeverity] ?? 9) - (order[b.finalSeverity] ?? 9))

const bySeverity = {
  BLOCKER: confirmed.filter((f) => f.finalSeverity === 'BLOCKER').length,
  HIGH: confirmed.filter((f) => f.finalSeverity === 'HIGH').length,
  MEDIUM: confirmed.filter((f) => f.finalSeverity === 'MEDIUM').length,
  LOW: confirmed.filter((f) => f.finalSeverity === 'LOW').length,
}
const autoFixable = confirmed.filter((f) => f.fixKind === 'frontend-only' || f.fixKind === 'docs-or-test').length
const parked = confirmed.filter((f) => f.fixKind === 'migration' || f.fixKind === 'edge-fn' || f.fixKind === 'data').length

log(
  'Hunt complete: ' + confirmed.length + ' confirmed (' +
    bySeverity.BLOCKER + ' BLOCKER / ' + bySeverity.HIGH + ' HIGH / ' +
    bySeverity.MEDIUM + ' MEDIUM / ' + bySeverity.LOW + ' LOW); ' +
    autoFixable + ' auto-fixable (green), ' + parked + ' need a migration/edge-fn/data change (park); ' +
    refuted.length + ' refuted.'
)

return {
  subsystemsRun: SELECTED.map((d) => d.key),
  counts: { confirmed: confirmed.length, refuted: refuted.length, bySeverity, autoFixable, parked },
  confirmed,
  refuted,
}
