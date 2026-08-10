export const meta = {
  name: 'ordering-cycle-review',
  description: 'Three-phase read-only review of the quote→planned→order→invoice cycle with adversarial verification',
  phases: [
    { title: 'Phase 1: Lifecycle & Holds', detail: 'state machines, planned flag/holds, conversion seams' },
    { title: 'Phase 2: Money & Idempotency', detail: 'money math, commissions, idempotency/concurrency' },
    { title: 'Phase 3: Security & Frontend', detail: 'RLS/grants, frontend compliance, reporting/doc drift' },
    { title: 'Verify', detail: 'adversarial refutation of every finding' },
  ],
}

const FINDINGS = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'severity', 'location', 'detail', 'evidence'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['BLOCKER', 'HIGH', 'MED', 'LOW'] },
          location: { type: 'string', description: 'file:line citations' },
          detail: { type: 'string' },
          evidence: { type: 'string', description: 'exact code/SQL excerpts supporting the claim' },
          failure_scenario: { type: 'string' },
        },
      },
    },
    coverage_notes: { type: 'string', description: 'what was examined and what could not be verified' },
  },
}

const VERDICT = {
  type: 'object',
  required: ['refuted', 'reason'],
  properties: {
    refuted: { type: 'boolean' },
    reason: { type: 'string' },
    corrected_severity: { type: 'string', enum: ['BLOCKER', 'HIGH', 'MED', 'LOW'] },
  },
}

const COMMON = `
You are a read-only code reviewer for CRX Manager V1.0 (repo at /home/user/CRX_Manager_V1.0), the production ops app for an ag-chem distributor. React 18 + TypeScript + Supabase. Money is bigint cents. NEVER edit files, never run mutating commands, never touch the live database with anything other than the tools listed — you may read source, migrations under supabase/migrations/, .claude/schema-registry.json, and docs.
Before reporting, read docs/manual/KNOWN_ISSUES.md and docs/audits/gauntlet/2026-08-05-section-04-quote-order-delivery-invoice-payment-lifecycle-refresh.md — do NOT re-report items already known there; hunt beyond that baseline (you may note "known issue confirmed still present" only if materially worse than documented).
Report EVERY finding you believe is real, at every severity — do not filter, do not limit yourself to the most significant; filtering happens in a later pass. Every finding needs exact file:line citations and quoted evidence. Distinguish "the DB does not enforce X" (checked the migrations) from "I didn't find where X is enforced" — say which. Return structured findings only; your final output is data, not prose for a human.
Key context: quotes(draft→sent→revised→accepted→declined/expired/cancelled) with is_planned flag creating inventory holds; convert_quote_to_order() → orders(confirmed→partially_fulfilled→fulfilled); deliveries; invoices with GENERATED balance_cents as sole AR source (orders.total_paid/balance_due were DROPPED). Key files: src/pages/QuoteBuilder.tsx, Quotes.tsx, Orders.tsx, OrderDetail.tsx, NewOrder.tsx, InvoiceDetail.tsx; RPC surface documented in docs/reference/rpc-functions.md; workflow doc docs/workflows/QUOTE_TO_DELIVERY.md.
`

const PHASES = [
  {
    phase: 'Phase 1: Lifecycle & Holds',
    finders: [
      { key: 'state-machines', prompt: `${COMMON}
Your dimension: LIFECYCLE STATE MACHINES. Audit every status transition across quotes, orders, deliveries, invoices. For each transition, find where it is enforced — Postgres RPC/trigger/CHECK vs React only (React-only enforcement of a business invariant is a finding). Hunt: out-of-order transitions (convert non-accepted quote, invoice with nothing delivered, complete delivery on cancelled order), backwards moves (quote reopen — check harden_quote_reopen_history_guards and revert_quote_status migrations for gaps), terminal-state leakage (edit/convert/re-invoice cancelled/voided/expired entities — check reuse_guard_covers_revivable_quotes and reuse_guard_covers_invoiced_jobs for coverage gaps), and UI status values that don't match CHECK constraints in .claude/schema-registry.json.` },
      { key: 'planned-holds', prompt: `${COMMON}
Your dimension: THE is_planned FLAG AND INVENTORY HOLDS. Trace the complete hold lifecycle in migrations and frontend. Hunt: when exactly holds are created (mark-planned vs accept vs both, double-creation); whether editing a planned quote's quantities resizes holds; every exit path (unplanned, declined, expired, cancelled, deleted, converted-to-order) and whether each releases or transfers the hold — orphaned holds are the target; interplay with Layer 2 job reservations (same stock held twice? what does "available" mean in InventoryPage.tsx when both exist); expiry of planned quotes (auto-release or stuck?); overselling (two planned quotes holding more than on-hand — is that intended soft-hold behavior and does the UI communicate it). Check tests/e2e/holds-cleanup-paths.spec.ts for what is and isn't covered.` },
      { key: 'conversion-seams', prompt: `${COMMON}
Your dimension: CONVERSION SEAMS — everywhere data is copied forward. Audit convert_quote_to_order(), invoice creation from orders/deliveries, the Quick Delivery atomic shortcut, create_direct_order/NewOrder.tsx, and the recently-hardened bulk order import. Hunt: does convert use the sent quote_versions snapshot or live (re-editable) quote rows — which price does the customer get if edited between send and convert; field fidelity across quote_items→order_items→delivery_items→invoice lines (sections, tier overrides, rates×acres math, unit conversions); rounding at each hop; partial deliveries / delivery_remainders / quantity_remaining reconciliation vs what gets invoiced; U7 split invoicing over/under-invoicing the order total; whether Quick Delivery and direct/bulk orders enforce the same invariants as the quote-born path or bypass them.` },
    ],
  },
  {
    phase: 'Phase 2: Money & Idempotency',
    finders: [
      { key: 'money-math', prompt: `${COMMON}
Your dimension: MONEY. Hunt: any float math on money anywhere in the cycle (QuoteBuilder rate×acres×price — where does rounding happen and is it done exactly once in one place); total reconciliation invariants (sum(items)=section totals=quote total=order total=sum(invoice lines)=invoice total) — any stored header total that can drift from its lines; any code path writing invoices.balance_cents (GENERATED — writes are bugs); ghost references to the dropped orders.total_paid/balance_due; credit memos and returns flowing through inventory AND AR consistently; prepay application ordering/partial/refund; whether a backdated invoice or payment can land in a closed accounting period via the ordering cycle (AP just got period-close locks — does AR have equivalents).` },
      { key: 'commissions', prompt: `${COMMON}
Your dimension: COMMISSIONS. Commission records are created automatically at order creation from quote JSONB splits ({splits:[{recipient,percentage}]}). Hunt: is splits-sum-to-100% ENFORCED (DB or RPC) or merely documented; what happens to commission amounts when the order is edited, cancelled, or partially fulfilled after creation; invoice voided after commission paid; U8 job commissions vs order commissions — can a job that also has an order double-pay; commission status lifecycle and CommissionPayments.tsx correctness; whether commission data leaks into customer-facing surfaces.` },
      { key: 'idempotency-concurrency', prompt: `${COMMON}
Your dimension: IDEMPOTENCY AND CONCURRENCY. Enumerate every mutating RPC in the cycle (save_quote, status changes, planned toggle/hold release, convert_quote_to_order, create_direct_order, cancel_order, invoice creation/posting, payment application) and verify each accepts AND actually enforces p_idempotency_key — check migrations require_money_lifecycle_idempotency_keys and bind_idempotency_to_mutation_intent for coverage gaps. Hunt: double-click convert producing two orders from one quote or two invoices from one order/delivery; stale-write protection — quotes have a row-version guard (quote_customer_row_version_guard), do orders and invoices have equivalents; two office users editing the same entity; race between hold release and conversion. Check tests/e2e/concurrent-operations.spec.ts coverage vs this list.` },
    ],
  },
  {
    phase: 'Phase 3: Security & Frontend',
    finders: [
      { key: 'rls-security', prompt: `${COMMON}
Your dimension: RLS AND SECURITY on the ordering-cycle surface. For every cycle table (quotes, quote_sections, quote_items, quote_versions, orders, order_items, commissions, deliveries+children, invoices) and every cycle RPC: RLS enabled with sane policies; role gating on transitions (can a driver mutate quote status, can sales see cost/margin — check the recent secdef_pricing_reads_office_only work for gaps); SECURITY DEFINER hygiene (search_path pinned, deliberate grants, anon EXECUTE revoked — the B7/B8/B9 incident patterns); actor forgery (does convert/status-change record the real auth.uid() actor or accept a caller-supplied one); quote/order/invoice PDF generators leaking internal cost or commission data into customer-facing documents.` },
      { key: 'frontend-compliance', prompt: `${COMMON}
Your dimension: FRONTEND CORRECTNESS in the cycle pages (Quotes.tsx, QuoteBuilder.tsx, Orders.tsx, OrderDetail.tsx, NewOrder.tsx, InvoiceDetail.tsx, Deliveries pages, CommissionPayments.tsx). Hunt: missing assertRpcResult() after RPCs or checkMutationResult() after .update()/.delete(); status literals not matching .claude/schema-registry.json; confirm()/window.confirm()/alert() instead of ConfirmModal/toasts; buttons not disabled during in-flight transitions (double-submit); stale list state after conversions; error paths — what the user sees when a convert half-fails and whether the RPC is actually atomic; direct writes to RPC-owned tables (quote_sections/quote_items must only be written via save_quote); Supabase client imported from anywhere other than src/lib/db.ts; Sentry imported outside src/lib/sentry.` },
      { key: 'reporting-drift', prompt: `${COMMON}
Your dimension: REPORTING, DOCS, AND TEST DRIFT. Downstream readers of the cycle: ARaging.tsx, AccountsReceivable.tsx, customer balance (recently fixed for paid-invoice totals — verify complete), FinancialDashboard.tsx, statements, ProgramTracker.tsx, OfficeCockpit.tsx — hunt for derivations inconsistent with invoices.balance_cents as the sole AR source. Also: logActivity() coverage after send/accept/decline/convert/invoice events per docs/workflows/QUOTE_TO_DELIVERY.md rules; drift between that doc and current code (status lists, RPC names, dropped columns); map tests/e2e specs (quote-builder-v2, mega-workflow, math-inventory-flow, holds-cleanup-paths, concurrent-operations) against the lifecycle and name the untested seams — especially planned-flag edges and quote-reopen.` },
    ],
  },
]

const allVerified = []
for (const p of PHASES) {
  phase(p.phase)
  log(`Starting ${p.phase} — ${p.finders.length} finders`)
  const results = await pipeline(
    p.finders,
    f => agent(f.prompt, { label: `find:${f.key}`, phase: p.phase, effort: 'high', schema: FINDINGS }),
    (res, f) => {
      if (!res || !res.findings || !res.findings.length) return { finder: f.key, coverage: res?.coverage_notes || '', verified: [] }
      return parallel(res.findings.map(finding => () =>
        agent(`${COMMON}
You are an adversarial skeptic. A reviewer claims the following finding in the ordering cycle. Your job is to REFUTE it: read the cited files/migrations yourself and check whether the claim is factually accurate against current source, whether an enforcement mechanism the reviewer missed exists elsewhere (another migration, trigger, hook, or later migration superseding an earlier one — migrations apply in timestamp order, check for later files touching the same object), and whether the failure scenario can actually occur. Default to refuted=true if the evidence does not hold up or the issue is already documented in KNOWN_ISSUES.md or the 2026-08-05 gauntlet section-04 baseline. If confirmed, optionally correct the severity.
FINDING: ${JSON.stringify(finding)}`, { label: `verify:${f.key}`, phase: 'Verify', effort: 'high', schema: VERDICT })
          .then(v => ({ ...finding, finder: f.key, phaseName: p.phase, verdict: v }))
      )).then(vs => ({ finder: f.key, coverage: res.coverage_notes || '', verified: vs.filter(Boolean) }))
    }
  )
  for (const r of results.filter(Boolean)) {
    const confirmed = r.verified.filter(v => v.verdict && !v.verdict.refuted)
    const refuted = r.verified.length - confirmed.length
    log(`${p.phase} / ${r.finder}: ${confirmed.length} confirmed, ${refuted} refuted`)
    allVerified.push(r)
  }
}

const confirmed = allVerified.flatMap(r => r.verified.filter(v => v.verdict && !v.verdict.refuted))
const refuted = allVerified.flatMap(r => r.verified.filter(v => v.verdict && v.verdict.refuted))
return {
  confirmed,
  refutedCount: refuted.length,
  refutedTitles: refuted.map(v => ({ title: v.title, reason: v.verdict.reason })),
  coverage: allVerified.map(r => ({ finder: r.finder, notes: r.coverage })),
}