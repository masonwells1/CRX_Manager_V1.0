export const meta = {
  name: 'overnight-bug-hunt',
  description:
    'Billing-engine-first, no-stone-unturned bug + flawed-logic hunt for CRX Manager. Each cycle fans out one agent per subsystem to hunt the 8 recurring bug classes against the live DB, then adversarially refutes every finding before it counts. Read-only — never mutates the DB or edits files. The /overnight-bug-hunt command layer adds the Codex finding-gate, the fix, and the Codex fix-gate on top.',
  whenToUse:
    'The find+verify core of the self-sustaining overnight bug hunt. Phase 1 = the money/billing engine (where ~80% of the last 20 days of bugs lived). Phase 2 = broad whole-app sweep. Pass args = { phase: 1 } or { phase: 2 } or { only: ["invoices-core", ...] } to slice one cycle.',
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
  'KNOWN-PARKED / KNOWN-DEFERRED (do NOT re-surface as new — reference the artifact if you find a NEW angle): delivery_items terminal-states-unlocked lock (PARKED-05, folded into update_order_items rewrite); create_split_invoices_from_order multi-field per-line rounding (needs field-aware redesign, dormant on live); draw_down_quote weighted-avg price is an accepted v1 simplification; create_prepay_credit is unused legacy; the freeform-vs-SCREAMING_SNAKE auth-error token sweep is a deferred owner decision.',
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
  // ---- Phase 1: billing engine ----
  {
    key: 'invoices-core', phase: 1,
    prompt:
      'Hunt the INVOICE CORE. RPCs: post_invoice, create_invoice_from_order, create_invoice_from_blend_ticket, save_field_app_invoice, void/cancel invoice, delete_invoices, finance charges. Read each body via live pg_proc. Hunt all 8 classes but especially: idempotency correctness, forgeable actor, the financial_audit_log row on every money mutation (class 8), any UPDATE touching the GENERATED balance_cents, and status values vs the live invoices CHECK constraint. Confirm check_period_open() is honored on backdated posts.',
  },
  {
    key: 'jobs-to-billing', phase: 1,
    prompt:
      'Hunt JOBS → BILLING. transfer_job_to_invoice, the job-mix 3-way quantity calculator, recipe per-unit pricing, per-acre machine fees, application-fee rate. Read transfer_job_to_invoice via live pg_proc + src/pages/JobDetail.tsx + the recipe/calculator code. Especially class 3 (cents exactness — per-acre vs per-unit, machine-fee rounding, decimal recipe price parsing), class 2 (actor) and class 5 (stale job/invoice totals after a recipe or quantity edit). This subsystem had ~10 Codex rounds in 2 days — assume the easy ones are caught; find the subtle remaining ones.',
  },
  {
    key: 'field-app-invoices', phase: 1,
    prompt:
      'Hunt FIELD / APPLICATION INVOICES. src/pages/FieldApplicationInvoice.tsx + save_field_app_invoice + the field/acre split + override-grower shares + the field-invoice edit path. Especially class 6 (segregation: field_application leaking into chemical-sales lists or chemical leaking into field lists; route/edit-lock bypass by direct URL; override-grower share preservation on edit) and class 3 (cents on share splits). Confirm the editable/locked rules can\'t be bypassed.',
  },
  {
    key: 'commissions', phase: 1,
    prompt:
      'Hunt COMMISSIONS. The commission_split JSONB (splits sum to 100), per-order commission records (pending→paid→cancelled), recompute-on-edit paths, commission_payments batch (unposted→posted→voided), void_commission_payment. Read save_customer split validation + the recompute paths + the batch RPCs. Especially class 5 (stale commissions after an order-item / price edit — do paid commissions get correctly flagged not silently mutated?) and class 3 (rounding when splitting an amount across recipients).',
  },
  {
    key: 'deliveries-billing', phase: 1,
    prompt:
      'Hunt DELIVERIES that touch money/inventory. confirm_delivery, complete_delivery (incl. partial re-bill), create_quick_delivery (atomic order+delivery+draft invoice), cancel_delivery, void_delivery. Read each via live pg_proc. Especially class 4 (concurrency — FOR UPDATE on holds/prebooked/order before release; the quick-cancel race), class 1 (idempotency shape), and the inventory_transactions type written on each path (12 valid types).',
  },
  {
    key: 'prepay-blend', phase: 1,
    prompt:
      'Hunt PREPAY + BLEND-TICKET BILLING. Prepay: apply_prepay / overpayment→credit, prepay_applications, the booking-prepay link/settlement RPCs. Blend tickets: create_invoice_from_blend_ticket, sync_blend_ticket_payment_status, the trg_sync_blend_ticket_payment trigger, the 4 orthogonal status axes. Especially class 1 (idempotency), class 2 (actor binding), class 6 (payment_status transitions vs the live CHECK), and whether voiding a linked invoice correctly resets blend payment_status.',
  },
  {
    key: 'splits-shares-allocation', phase: 1,
    prompt:
      'Hunt SPLITS / SHARES / PAYMENT ALLOCATION. order_item_field_allocations + create_split_invoices_from_order (penny-exact reconcile-or-raise), the DORMANT order_shares / invoice_shares / *_line_allocations / field_app_location_shares subsystems, allocate_payment, write-offs, prepay_applications. Especially class 3 (penny-drift — does the sum of the parts equal the whole, with a reconcile-or-raise guard?) and class 6 (do the dormant subsystems have RLS + sane guards if a path reaches them?). Note which subsystems are dormant on live (0 rows) so severity reflects reachability.',
  },
  // ---- Phase 2: broad whole-app sweep ----
  {
    key: 'rls-security', phase: 2,
    prompt:
      'Hunt DATABASE SECURITY beyond the known-accepted set. (a) tables missing RLS (pg_tables vs pg_policies); (b) NEW anon/PUBLIC-executable SECURITY DEFINER mutators NOT in the accepted ~53 (has_function_privilege(\'anon\', oid, \'EXECUTE\')); (c) SECDEF functions missing SET search_path; (d) actor-forgery on any mutator not already covered in Phase 1. Report the anon-exec-secdef count and whether any NEW one mutates.',
  },
  {
    key: 'migration-drift', phase: 2,
    prompt:
      'Hunt MIGRATION DRIFT (the 40+ March bugs class). (a) function-overload collisions (SELECT proname,count(*) ... HAVING count(*)>1); (b) CHECK constraints whose latest migration dropped a previously-allowed value; (c) RPCs/triggers referencing columns that don\'t exist live; (d) idempotency_keys wrong-column references; (e) updated_at set on the 11 tables that lack it (payments, write_offs, delivery_items, finance_charges, prepay_applications, cycle_counts, cycle_count_items, financial_audit_log, idempotency_keys, receiving_records, commission_payment_items).',
  },
  {
    key: 'types-drift', phase: 2,
    prompt:
      'Hunt TYPESCRIPT TYPE DRIFT between src/types/index.ts and the LIVE schema for the most-used tables (customers, orders, invoices, deliveries, products, quotes, payments, commissions, jobs, blend_tickets, invoice_items). Flag missing/renamed columns, money typed as number where the column is bigint cents, and tables with no interface. Use live information_schema.columns.',
  },
  {
    key: 'frontend-safety', phase: 2,
    prompt:
      'Hunt FRONTEND SAFETY conventions across src/. (a) .update()/.delete() not followed by checkMutationResult(); (b) RPC data used without assertRpcResult(); (c) confirm()/alert()/window.confirm/window.alert (must be ConfirmModal); (d) Sentry imported from @sentry/react not lib/sentry; (e) any service_role/JWT-shaped literal in src/; (f) logActivity() with positional args or non-profile.id performedBy.',
  },
  {
    key: 'lifecycle-invariants', phase: 2,
    prompt:
      'Hunt BUSINESS-LIFECYCLE correctness across quote/order/delivery/invoice/job/PO/return/commission/commission_payment (lifecycles documented in CLAUDE.md). (a) status strings written that are NOT in the live CHECK; (b) transitions no trigger/RPC enforces; (c) the delivery two-step + item-lock being bypassable; (d) quote draw-down / Net-Free invariant holes. Use live pg_constraint.',
  },
  {
    key: 'edge-and-pdf', phase: 2,
    prompt:
      'Hunt EDGE FUNCTIONS (6 in supabase/functions: create-user, process-blend-ticket, process-document, reset-user-password, send-email, setup-blend-tickets-storage) + customer-facing PDFs (src/lib/*Pdf.ts). Edge: CORS ALLOWED_ORIGIN enforced, JWT verified, admin-only actually gates on admin, idempotency on side-effects, disk-vs-deployed drift (use get_edge_function if available). PDF: cents without ÷100, off-brand color (crx-green #28A26A), hardcoded company address not from companyInfo.ts, page-overflow on long real data, broken asset refs.',
  },
  {
    key: 'docs-deps-tests', phase: 2,
    prompt:
      'Hunt DOC DRIFT + DEPS + TEST GAPS. Doc: compare counts in CLAUDE.md / docs/reference/* against reality (pages, migrations on disk, live RPC/table counts, tests) and report claimed-vs-actual. Deps: npm audit --json (prod vs dev) — unfixed vulns by severity. Tests: high-risk money/RPC/RLS/lifecycle areas with thin or skipped coverage; count it.skip/describe.skip and flag any guarding a financial/security path. Severity = risk of the untested area.',
  },
]

const SELECTED = (() => {
  if (args && Array.isArray(args.only) && args.only.length) return DIMENSIONS.filter((d) => args.only.includes(d.key))
  if (args && (args.phase === 1 || args.phase === 2)) return DIMENSIONS.filter((d) => d.phase === args.phase)
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
    }),
  (review, d) =>
    parallel(
      ((review && review.findings) || []).map((f) => () =>
        agent(verifyPrompt(d, f), {
          label: 'verify:' + d.key + ':' + f.severity,
          phase: 'Verify',
          schema: VERDICT_SCHEMA,
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
