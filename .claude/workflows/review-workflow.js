export const meta = {
  name: 'review-workflow',
  description:
    'Widespread READ-ONLY review of CRX Manager workflow logic — 4 parallel layers (graph/connection, lifecycle, cross-entity flow, invariants) with adversarial verification of every BLOCKER/HIGH before it reaches the report. Returns structured findings; the /review-workflow command synthesizes + writes the one dated report file.',
  whenToUse:
    'The "is my foundation solid enough to build the next feature on?" check. Analyzes code + live DB, writes nothing itself. Every finding must carry a file:line / constraint / migration citation.',
  phases: [
    { title: 'Review', detail: '4 layers in parallel: graph, lifecycle, cross-entity, invariants' },
    { title: 'Verify', detail: 'skeptics try to refute every BLOCKER/HIGH finding' },
  ],
}

// The ONE rule, passed to every layer: trust nothing pre-written. The workflow map,
// documented lifecycles, and prior audit docs are LEADS to confirm by reading the
// actual code + live DB — never facts. A past grep-heuristic pass asserted ~6
// problems that were ALL false once someone read the code (Returns "broken",
// /notifications "orphan", "drop get_field_geojson" would have caused an outage).
const GROUND_RULE =
  'TRUST NOTHING PRE-WRITTEN. The workflow map (docs/app-workflow-map.html), the documented lifecycles (docs/manual/ARCHITECTURE.md, docs/reference/database-schema.md), and prior docs/audits are leads to CONFIRM by reading actual code and querying the live Supabase DB — never facts. Return executionStatus=BLOCKED if any required code or live-DB evidence source is unavailable; an empty findings array is valid only with executionStatus=VERIFIED and a concrete evidenceSummary. A finding with no file:line, constraint name, or migration citation does not belong in the output. Explicitly separate "verified real" from "looked suspicious but checked out fine".'

const FINDINGS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    executionStatus: { type: 'string', enum: ['VERIFIED', 'BLOCKED'] },
    evidenceSummary: { type: 'string', description: 'Concrete files, commands, and live queries successfully checked, or the exact access blocker.' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['BLOCKER', 'HIGH', 'MED', 'LOW'] },
          title: { type: 'string' },
          location: { type: 'string', description: 'file:line, constraint name, or migration filename' },
          evidence: { type: 'string', description: 'Concrete code, database, or command evidence supporting the finding.' },
          detail: { type: 'string' },
          recommendation: { type: 'string' },
        },
        required: ['severity', 'title', 'location', 'evidence', 'detail', 'recommendation'],
      },
    },
    verifiedSafe: {
      type: 'array',
      description: 'Leads that were checked and found correct — so the next review does not re-chase them.',
      items: { type: 'string' },
    },
    summary: { type: 'string' },
  },
  required: ['executionStatus', 'evidenceSummary', 'findings', 'summary'],
}

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: {
      type: 'string',
      enum: ['VERIFIED', 'REFUTED', 'UNVERIFIED'],
      description: 'VERIFIED = independently confirmed; REFUTED = independently disproved; UNVERIFIED = evidence was unavailable or inconclusive.',
    },
    reasoning: { type: 'string' },
    verifiedAgainst: { type: 'string', description: 'Exact file:line, SQL result, or command used for the verdict.' },
  },
  required: ['status', 'reasoning', 'verifiedAgainst'],
}

const NON_EMPTY_FINDING_FIELDS = ['title', 'location', 'evidence', 'detail', 'recommendation']

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isCompleteLayerReview(review) {
  return Boolean(
    review &&
      review.executionStatus === 'VERIFIED' &&
      isNonEmptyString(review.evidenceSummary) &&
      Array.isArray(review.findings) &&
      isNonEmptyString(review.summary)
  )
}

function isCompleteFinding(finding) {
  return Boolean(
    finding &&
      ['BLOCKER', 'HIGH', 'MED', 'LOW'].includes(finding.severity) &&
      NON_EMPTY_FINDING_FIELDS.every((field) => isNonEmptyString(finding[field]))
  )
}

function normalizeVerdict(verdict) {
  if (
    !verdict ||
    !['VERIFIED', 'REFUTED', 'UNVERIFIED'].includes(verdict.status) ||
    !isNonEmptyString(verdict.reasoning) ||
    !isNonEmptyString(verdict.verifiedAgainst)
  ) {
    return {
      status: 'UNVERIFIED',
      reasoning: 'Verifier returned no structured verdict or omitted required evidence.',
      verifiedAgainst: 'No complete verifier evidence returned.',
      malformed: true,
      isReal: null,
    }
  }

  return {
    ...verdict,
    isReal: verdict.status === 'VERIFIED' ? true : verdict.status === 'REFUTED' ? false : null,
  }
}

const LAYERS = [
  {
    key: 'A-graph',
    agentType: 'Explore',
    prompt:
      `Layer A — Graph & connection integrity. ${GROUND_RULE}\n\n` +
      `Verify, by reading the current code:\n` +
      `- Orphan pages: for each route in src/App.tsx not reachable via sidebar, navigate(), <Link to>, nav-config path: arrays, or a mounted panel, confirm it is TRULY unreachable. Remember /customers/new resolves to /customers/:id, header-bell panels navigate from TopBar, and FinancialDashboard uses an array-config menu. Only report genuine orphans.\n` +
      `- Broken navigation: every navigate('/literal') resolves to a real Route (account for :param patterns).\n` +
      `- Dead RPCs: every RPC in docs/reference/rpc-functions.md is either called from src/ OR is a legitimate trigger/cron/internal helper (see the generator's INTERNAL_RPCS set). grep src/ before calling any RPC dead — get_field_geojson was wrongly flagged before.\n` +
      `- Page->RPC wiring: each major workflow page wires the RPCs its lifecycle needs (e.g. a returns page calls approve/receive/issue_credit/cancel, each with idempotency + assertRpcResult).\n` +
      `- Role gating: admin-only pages (month-end, commissions, settings) are NOT reachable by sales_rep; /payments is intentionally admin+sales — do NOT flag that.\n\n` +
      `Return findings with file:line citations. Put disproven leads in verifiedSafe.`,
  },
  {
    key: 'B-lifecycle',
    agentType: 'general-purpose',
    prompt:
      `Layer B — Lifecycle / state-machine integrity. ${GROUND_RULE}\n\n` +
      `For each entity — Quote, Order, Delivery, Invoice, Job, PurchaseOrder, Return, BlendTicket, Commission, CommissionPayment — do a 4-way reconciliation:\n` +
      `1. Live CHECK constraint (query via Supabase MCP): SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='<table>'::regclass AND contype='c';\n` +
      `2. The documented lifecycle (docs/manual/ARCHITECTURE.md and docs/reference/database-schema.md).\n` +
      `3. The map SVG in docs/app-workflow-map.html.\n` +
      `4. The statuses the actual transition RPCs move between.\n\n` +
      `Flag where these four disagree. Hunt for: ghost states (a status set in code/RPC that is NOT in the live CHECK — would crash); orphan states (a CHECK value no RPC reaches); undocumented lifecycles; and status string drift ('void' vs 'voided', 'pending' vs 'requested' for returns).\n\n` +
      `Return findings with the constraint name / RPC / file:line. Put disproven leads in verifiedSafe.`,
  },
  {
    key: 'C-flow',
    agentType: 'general-purpose',
    prompt:
      `Layer C — Cross-entity flow integrity. ${GROUND_RULE}\n\n` +
      `Read the conversion RPCs and confirm nothing leaves an entity stranded:\n` +
      `- Quote -> Order (convert_quote_to_order): holds released, items copied, source_id linked, is_planned reservations resolved.\n` +
      `- Order -> Delivery (confirm_delivery / complete_delivery): items locked after scheduled, inventory deducted on complete, complete_delivery requires p_signed_by.\n` +
      `- Order/Delivery/Blend -> Invoice: invoice must have order_id OR blend_ticket_id; balance_cents is the GENERATED single source of AR truth.\n` +
      `- Invoice -> Payment: allocation + prepay application update balance; post_invoice enforces check_period_open.\n` +
      `- Order -> Commission: per-recipient records; commission_split sums to 100%; entity recipients (CMCTW, Crop Rx) wired.\n` +
      `- PO -> Inventory (receive) and Return -> Inventory (restock/credit): transaction types correct, ledger immutable.\n` +
      `- Blend ticket -> Order/Invoice/Application: OCR path produces a LINKED entity, not a dangling row.\n\n` +
      `For each chain answer: can an entity get PERMANENTLY stuck (a state with no exit, a hold never released, a created-but-never-linked row, a missing reversal path)? Cite file:line / RPC. Put disproven leads in verifiedSafe.`,
  },
  {
    key: 'D-invariants',
    agentType: 'general-purpose',
    prompt:
      `Layer D — Business-logic invariant sweep. ${GROUND_RULE}\n\n` +
      `Confirm the invariants that make the workflow safe to extend (query the live DB via Supabase MCP where stated):\n` +
      `- Money: no binary-float conversion, parsing, arithmetic, or rounding; new storage uses bigint cents; legacy PostgreSQL numeric-dollar storage is not an approved exception until exact numeric math, clean finite whole-cent values, and an active finite whole-cent CHECK are verified. Dirty or unconstrained columns remain findings.\n` +
      `- RLS: every table has RLS enabled + >=1 policy (cross-check live pg_policies against list_tables). The ONE intentional exception is profile_public_view (SECURITY DEFINER semantics) — do not flag it.\n` +
      `- Idempotency: every mutating RPC accepts p_idempotency_key AND actually reads/writes idempotency_keys (columns idempotency_key/operation/result).\n` +
      `- SECURITY DEFINER: every such function has SET search_path.\n` +
      `- Immutability: inventory_transactions (UPDATE+DELETE blocked) and financial_audit_log (append-only) still enforced.\n` +
      `- No function-overload collisions: SELECT proname, count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace GROUP BY proname HAVING count(*)>1; should be EMPTY.\n` +
      `- Supabase advisors: run get_advisors for security + performance; fold any NEW findings in.\n` +
      `- updated_at: no UPDATE references updated_at on tables that lack it (payments, write_offs, delivery_items, finance_charges, prepay_applications, cycle_counts, cycle_count_items, financial_audit_log, idempotency_keys, receiving_records, commission_payment_items).\n\n` +
      `Return findings with file:line / constraint / advisor id. Put disproven leads in verifiedSafe.`,
  },
]

phase('Review')
log('Dispatching 4 review layers in parallel (graph, lifecycle, cross-entity, invariants).')

const reviews = await parallel(
  LAYERS.map((l) => () =>
    agent(l.prompt, { agentType: l.agentType, schema: FINDINGS, phase: 'Review', label: `layer:${l.key}` })
  )
)

const tagged = reviews.map((r, i) => ({ r, layer: LAYERS[i].key }))
const blockedLayers = tagged
  .filter((x) => !isCompleteLayerReview(x.r))
  .map((x) => ({
    status: 'BLOCKED',
    layer: x.layer,
    reason: x.r?.executionStatus === 'BLOCKED'
      ? `Review layer reported blocked evidence: ${x.r.evidenceSummary || x.r.summary || 'unspecified blocker'}`
      : 'Review layer returned no VERIFIED evidence status or omitted evidence/findings/summary.',
  }))
const completeLayers = tagged.filter((x) => isCompleteLayerReview(x.r))
const blockedPartialFindings = tagged
  .filter((x) => !isCompleteLayerReview(x.r) && Array.isArray(x.r?.findings))
  .flatMap((x) => x.r.findings.map((f) => ({
    ...f,
    layer: x.layer,
    status: 'UNVERIFIED',
    reason: 'Review layer was blocked or incomplete; partial finding preserved without adversarial verification.',
  })))

const allLayerFindings = completeLayers.flatMap((x) => x.r.findings.map((f) => ({ ...f, layer: x.layer })))
const malformedFindings = allLayerFindings
  .filter((f) => !isCompleteFinding(f))
  .map((f) => ({
    ...f,
    status: 'UNVERIFIED',
    reason: 'Finder omitted a required location/evidence field; this finding was not silently dropped or refuted.',
  }))
const allFindings = allLayerFindings.filter(isCompleteFinding)
const verifiedSafe = completeLayers.flatMap((x) => (x.r.verifiedSafe || []).map((s) => ({ layer: x.layer, note: s })))

// Only BLOCKER + HIGH get the expensive adversarial pass — that is where false
// positives do real damage (they pollute the report and waste a fix cycle).
const toVerify = allFindings.filter((f) => f.severity === 'BLOCKER' || f.severity === 'HIGH')
const lowerSeverity = allFindings
  .filter((f) => f.severity === 'MED' || f.severity === 'LOW')
  .map((f) => ({ ...f, status: 'UNVERIFIED', reason: 'MED/LOW findings do not receive adversarial verification in this workflow.' }))

phase('Verify')
log(`${toVerify.length} BLOCKER/HIGH finding(s) to adversarially verify; ${lowerSeverity.length} MED/LOW reported as-is.`)

const verified = await parallel(
  toVerify.map((f) => () =>
    parallel(
      [1, 2].map((n) => () =>
        agent(
          `A review layer flagged this ${f.severity} on CRX Manager:\n\n` +
            `Title: ${f.title}\nLocation: ${f.location || '(none given)'}\nDetail: ${f.detail}\n\n` +
            `Your job is to REFUTE it. Read the actual code and query the live DB yourself. ` +
            `Return VERIFIED only when concrete evidence confirms a real user-facing problem, REFUTED only when concrete evidence disproves it, ` +
            `and UNVERIFIED when tools, access, or evidence are missing. Uncertainty must never be reported as refuted.`,
          { schema: VERDICT, phase: 'Verify', label: `verify:${f.title.slice(0, 24)}#${n}` }
        )
      )
    ).then((votes) => {
      const v = votes.map(normalizeVerdict)
      // Both requested verifiers must return evidence before a finding can be
      // refuted. A missing/malformed/inconclusive vote remains UNVERIFIED.
      const complete = v.length === 2 && v.every((x) => !x.malformed && x.status !== 'UNVERIFIED')
      const status = !complete ? 'UNVERIFIED' : v.some((x) => x.status === 'VERIFIED') ? 'VERIFIED' : 'REFUTED'
      return { ...f, status, confirmed: status === 'VERIFIED', votes: v }
    })
  )
)

const verifiedResults = verified.filter(Boolean)
const confirmed = verifiedResults.filter((f) => f.status === 'VERIFIED')
const refuted = verifiedResults.filter((f) => f.status === 'REFUTED')
const unverified = [
  ...verifiedResults.filter((f) => f.status === 'UNVERIFIED'),
  ...malformedFindings,
  ...blockedPartialFindings,
]
// MED/LOW remain in their single severity bucket. They do not mean evidence
// collection was blocked, but they do prevent the run from being called clean.
const overallStatus = blockedLayers.length || unverified.length ? 'BLOCKED' : 'VERIFIED'

log('Reviewer-independence limitation: finder and verifier agents use the same workflow runtime/model family unless the caller routes them differently.')

return {
  confirmed, // verified BLOCKER/HIGH — these go in the report
  refuted, // checked and dismissed — feed into the "Verified safe" section
  unverified, // missing/inconclusive evidence — never clean or refuted
  blocked: blockedLayers,
  lowerSeverity, // MED/LOW reported as-is
  verifiedSafe, // leads the layers already self-disproved
  layers: LAYERS.map((l) => l.key),
  overallStatus,
  complete: overallStatus === 'VERIFIED',
  clean: overallStatus === 'VERIFIED' && confirmed.length === 0 && lowerSeverity.length === 0,
  reviewerIndependence: {
    independentModelFamilies: false,
    limitation: 'Finder and verifier agents may use the same model family; verdicts are adversarial but not cross-family independent.',
  },
  counts: {
    blocker: confirmed.filter((f) => f.severity === 'BLOCKER').length,
    high: confirmed.filter((f) => f.severity === 'HIGH').length,
    med: lowerSeverity.filter((f) => f.severity === 'MED').length,
    low: lowerSeverity.filter((f) => f.severity === 'LOW').length,
    refuted: refuted.length,
    unverified: unverified.length,
    blocked: blockedLayers.length,
  },
}
