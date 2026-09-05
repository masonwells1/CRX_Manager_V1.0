export const meta = {
  name: 'whole-codebase-audit',
  description:
    'Comprehensive multi-agent audit of CRX Manager — security, migrations, money, types, PDFs, edge functions, lifecycles, frontend safety, docs, deps, tests. Each finding is adversarially verified against the live DB/code before it counts.',
  whenToUse:
    'When you want a deep, wide, fact-checked health audit of the whole CRX Manager codebase. Read-only — never mutates the DB or edits files.',
  phases: [
    { title: 'Audit', detail: 'One agent per dimension — parallel deep review of code + live DB' },
    { title: 'Verify', detail: 'Adversarially refute each finding against the live DB / current code' },
  ],
}

// ---------------------------------------------------------------------------
// Shared context handed to every agent. Keeps each dimension grounded in the
// real project and hard-locks the run to READ-ONLY.
// ---------------------------------------------------------------------------
const PREAMBLE = [
  'You are auditing the CRX Manager codebase (React 18 + TypeScript + Vite + Supabase + Tailwind) at the repo root of the current worktree.',
  'It is a production agricultural-retail ERP. New money storage uses bigint cents. Existing PostgreSQL numeric-dollar storage is not an approved exception until exact numeric math, clean finite whole-cent values, and an active finite whole-cent CHECK are verified. The app spans 80+ pages, ~114 tables, ~286 callable RPCs, 619+ migrations, and 7 Edge Functions; treat any count as a lead to confirm live, never a fact.',
  '',
  'GROUND TRUTH: Use the actual repo on disk AND the LIVE Supabase database. The Supabase MCP tools are available — load them with ToolSearch (e.g. query "execute_sql" or "supabase list tables"). Live project id is rhyzpcqhnizqbxphqdkr. You MAY run read-only SQL (SELECT, pg_catalog, information_schema) to ground every finding against the live DB.',
  'EVIDENCE STATUS: Return executionStatus=BLOCKED if any required repo or live-DB source is unavailable. An empty findings array may be VERIFIED only after the requested sources ran; summarize them concretely in evidenceSummary.',
  '',
  'HARD RULES (do not violate):',
  '- READ-ONLY. NEVER call apply_migration. NEVER run mutating SQL (no INSERT/UPDATE/DELETE/DDL). SELECT and introspection only.',
  '- Do NOT edit, write, or delete any file. This is a review, not a fix.',
  '- Cite hard evidence for every finding: a file:line, a table/function name, or the exact read-only SQL you ran and what it returned.',
  '- Read AGENTS.md and the workflow/reference files it routes for the project\'s documented rules and ACCEPTED exceptions before flagging anything.',
  '- Known accepted findings — do NOT re-report: profile_public_view uses SECURITY DEFINER semantics by design; customer RLS is intentionally lower-bound-only; reportPdf.ts columnStyles uses one allowed `any`. Numeric-dollar storage is never suppressed by type alone: audit every such column, including commissions.commission_amount, and report dirty values, inexact arithmetic, or a missing active finite whole-cent CHECK.',
  '- Prefer precision over volume. Report only what you can substantiate. Do NOT pad with speculative or style-only nits. Report at most your 10 most significant findings for this dimension.',
].join('\n')

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    executionStatus: { type: 'string', enum: ['VERIFIED', 'BLOCKED'] },
    evidenceSummary: { type: 'string', description: 'Concrete files/queries checked, or the exact required-source blocker.' },
    dimension: { type: 'string' },
    summary: { type: 'string', description: 'One short paragraph: what you checked and the overall health of this dimension.' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW'] },
          area: { type: 'string', description: 'Subsystem, e.g. "RLS", "edge:send-email", "pdf:invoice".' },
          file: { type: 'string', description: 'file:line, or table/function name, or the SQL object affected.' },
          evidence: { type: 'string', description: 'What you observed — quote the code or SQL result.' },
          impact: { type: 'string' },
          recommendation: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['title', 'severity', 'area', 'file', 'evidence', 'impact', 'recommendation', 'confidence'],
      },
    },
  },
  required: ['executionStatus', 'evidenceSummary', 'dimension', 'summary', 'findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['VERIFIED', 'REFUTED', 'UNVERIFIED'], description: 'Use UNVERIFIED when access, tools, or evidence are incomplete.' },
    revisedSeverity: { type: 'string', enum: ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW', 'FALSE_POSITIVE', 'UNVERIFIED'] },
    reasoning: { type: 'string' },
    verifiedAgainst: { type: 'string', description: 'Exactly what you checked — the read-only SQL you ran, or the file:line you read.' },
  },
  required: ['status', 'revisedSeverity', 'reasoning', 'verifiedAgainst'],
}

const REQUIRED_FINDING_FIELDS = ['title', 'severity', 'area', 'file', 'evidence', 'impact', 'recommendation', 'confidence']
const FINDING_SEVERITIES = ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW']
const FINDING_CONFIDENCES = ['high', 'medium', 'low']

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isCompleteReview(review) {
  return Boolean(
    review
      && review.executionStatus === 'VERIFIED'
      && isNonEmptyString(review.evidenceSummary)
      && isNonEmptyString(review.dimension)
      && isNonEmptyString(review.summary)
      && Array.isArray(review.findings)
  )
}

function isCompleteFinding(finding) {
  return Boolean(
    finding
      && REQUIRED_FINDING_FIELDS.every((field) => isNonEmptyString(finding[field]))
      && FINDING_SEVERITIES.includes(finding.severity)
      && FINDING_CONFIDENCES.includes(finding.confidence)
  )
}

function normalizeVerdict(verdict) {
  const verifiedSeverities = ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW']
  const valid = verdict
    && ['VERIFIED', 'REFUTED', 'UNVERIFIED'].includes(verdict.status)
    && typeof verdict.reasoning === 'string'
    && verdict.reasoning.trim()
    && typeof verdict.verifiedAgainst === 'string'
    && verdict.verifiedAgainst.trim()
    && !(verdict.status === 'VERIFIED' && !verifiedSeverities.includes(verdict.revisedSeverity))
    && !(verdict.status === 'REFUTED' && verdict.revisedSeverity !== 'FALSE_POSITIVE')
    && !(verdict.status === 'UNVERIFIED' && verdict.revisedSeverity !== 'UNVERIFIED')

  if (!valid) {
    return {
      status: 'UNVERIFIED',
      revisedSeverity: 'UNVERIFIED',
      reasoning: 'Verifier returned no complete, internally consistent evidence verdict.',
      verifiedAgainst: 'No complete verifier evidence returned.',
      isReal: null,
    }
  }

  return {
    ...verdict,
    isReal: verdict.status === 'VERIFIED' ? true : verdict.status === 'REFUTED' ? false : null,
  }
}

// ---------------------------------------------------------------------------
// The 12 audit dimensions. Each is a focused deep-review brief.
// ---------------------------------------------------------------------------
const DIMENSIONS = [
  {
    key: 'db-security',
    prompt:
      'Audit DATABASE SECURITY. Check, grounded in the live DB: (a) every table has RLS ENABLED with at least one policy — find tables missing RLS (query pg_tables + pg_policies); (b) SECURITY DEFINER functions EXECUTE-able by `anon` or PUBLIC that mutate data or expose PII/financials — use has_function_privilege(\'anon\', oid, \'EXECUTE\') over pg_proc; (c) SECURITY DEFINER functions missing `SET search_path`; (d) actor-forgery — mutating financial RPCs that trust a `p_performed_by` param instead of binding to auth.uid() (canonical guard raises AUTH_REQUIRED / ACTOR_MISMATCH using IS DISTINCT FROM); (e) mutating RPCs with no idempotency. Report counts (e.g. how many anon-executable SECDEF functions remain and whether any mutate).',
  },
  {
    key: 'migration-drift',
    prompt:
      'Audit MIGRATION DRIFT — the failure class that caused 40+ bugs in March 2026. Check: (a) function-overload collisions — run `SELECT proname, count(*) FROM pg_proc WHERE pronamespace=\'public\'::regnamespace GROUP BY proname HAVING count(*)>1` on live; (b) CHECK constraints whose latest migration definition dropped a previously-allowed value (status enums must be supersets of all old values); (c) column-name drift — RPCs/triggers referencing columns that do not exist on the live table; (d) idempotency_keys referenced with wrong columns (must be idempotency_key / operation / result — never key / entity_type / entity_id / result_id); (e) updated_at set on tables that lack it (payments, write_offs, delivery_items, finance_charges, prepay_applications, cycle_counts, cycle_count_items, financial_audit_log, idempotency_keys, receiving_records, commission_payment_items). Cross-check disk migrations against live schema.',
  },
  {
    key: 'types-drift',
    prompt:
      'Audit TYPESCRIPT TYPE DRIFT between src/types/index.ts and the LIVE Supabase schema. For the most-used tables (customers, orders, invoices, deliveries, products, quotes, payments, commissions, jobs, blend_tickets), compare each TS interface against information_schema.columns: flag missing columns, renamed columns, wrong TS types (especially money typed as `number` when the column is bigint cents), and tables with no interface at all. Use live SQL.',
  },
  {
    key: 'pdf-output',
    prompt:
      'Audit the customer-facing PDF generators in src/lib. Read the src/lib *Pdf.ts files (invoicePdf, statementPdf, deliveryPdf, quotePdf, reportPdf, receivingPdf, orderSummaryPdf, orderPickListPdf, loadSheetPdf, yearEndSummaryPdf, wpsNoticePdf — glob src/lib/*Pdf.ts to confirm the full set). Flag: (a) cents rendered without ÷100; (b) off-brand colors (brand crx-green is #28A26A); (c) company address NOT single-sourced from src/lib/companyInfo.ts (West York, IL) — any hardcoded address is a finding; (d) page-overflow / table-width layout risks on long real-world data; (e) missing or broken image-asset references that would fail on a real customer print; (f) unsafe font fallback.',
  },
  {
    key: 'money-financial',
    prompt:
      'Audit MONEY & FINANCIAL correctness. Flag: (a) binary-float conversion, parsing, arithmetic, or rounding in authoritative money calculations or input parsing; new money storage that is not bigint cents; or any legacy PostgreSQL numeric-dollar column without verified exact numeric math, clean finite whole-cent values, and an active finite whole-cent CHECK. Dirty or unconstrained legacy columns remain reportable and are not approved exceptions. Allow display-only formatting such as converting integer cents for Intl.NumberFormat or PDF output; (b) parseDollarsToCents vs parseDollarsToCentsSigned misuse — signed is legitimate only in the 3 vendor-bill adjustment callsites; (c) any UPDATE that writes invoices.balance_cents (it is GENERATED ALWAYS — writing it is a bug); (d) violations of inventory_transactions / financial_audit_log immutability invariants; (e) rounding errors in commission splits or payment allocation. Inspect src/lib/parseCents.ts (parseDollarsToCents / parseDollarsToCentsSigned), src/lib/reconciliation.ts, the *.test.ts for commission-split / payment-allocation / finance-charge math, and the corresponding mutating RPC bodies via live pg_proc (commission split, payment allocation, finance charges).',
  },
  {
    key: 'frontend-safety',
    prompt:
      'Audit FRONTEND SAFETY conventions across src/. Grep + read. Flag: (a) supabase .update()/.delete() calls NOT followed by checkMutationResult(); (b) RPC result data used without assertRpcResult() wrapping; (c) any confirm()/alert()/window.confirm()/window.alert() (must use ConfirmModal); (d) Sentry imported directly from @sentry/react instead of lib/sentry; (e) any service_role key or JWT-shaped literal in src/; (f) logActivity() called with positional args or a non-profile.id performedBy (must be object param with performedBy = profile.id).',
  },
  {
    key: 'rpc-idempotency',
    prompt:
      'Audit RPC IDEMPOTENCY & ERROR conventions. Flag: (a) mutating RPCs that DECLARE p_idempotency_key but whose body never reads/writes idempotency_keys (the issue_return_credit / save_job regression class) — check function bodies via live pg_proc; (b) mutating RPCs with no p_idempotency_key parameter at all; (c) error tokens — SQL raising freeform English instead of SCREAMING_SNAKE codes, or TS callers using message.includes() instead of hasRpcCode() against RpcErrorCodes in src/lib/db.ts; (d) inconsistent return shapes among mutating RPCs.',
  },
  {
    key: 'edge-functions',
    prompt:
      'Audit the 7 Edge Functions in supabase/functions (create-user, epa-lookup, process-blend-ticket, process-document, reset-user-password, send-email, setup-blend-tickets-storage). Read each index.ts. Flag: (a) CORS — ALLOWED_ORIGIN enforced, no wildcard origin reflection; (b) auth — JWT verified; admin-only functions actually gate on an admin role check; (c) idempotency on side-effecting operations; (d) errors swallowed instead of surfaced/logged; (e) disk-vs-live drift — if the Supabase get_edge_function / list_edge_functions MCP tools are available, compare the deployed body to disk and flag divergence (this caught a real false-positive last week where disk ≠ deployed).',
  },
  {
    key: 'business-lifecycle',
    prompt:
      'Audit BUSINESS-LOGIC LIFECYCLE correctness across quote, order, delivery, invoice, job, PO, return, commission, and commission_payment. Use QUOTE_TO_DELIVERY.md for quote/order/delivery/invoice context and INVENTORY_RULES.md for inventory/receiving effects. For all nine entities, compare every status written by current source against the live CHECK constraints in pg_constraint and inspect current function bodies in pg_proc; documentation provides context but never overrides live evidence. Flag: (a) status-string values written by frontend or RPCs that are NOT in the live CHECK constraint for that table (the "void" vs "voided" class); (b) lifecycle transitions that no trigger/RPC actually enforces; (c) the delivery scheduled→in_progress→completed two-step and item-lock rules being bypassable.',
  },
  {
    key: 'doc-drift',
    prompt:
      'Audit DOCUMENTATION DRIFT. Compare counts claimed in docs/reference/* against reality: pages (count src/pages + `lazy(` occurrences in src/App.tsx), migrations (count supabase/migrations/*.sql), RPCs (live pg_proc count in public), tables (live count), tests. Report every stale number as claimed-vs-actual, and flag any volatile count added to always-loaded AGENTS.md or CLAUDE.md. Also flag reference docs (migration-history.md, rpc-functions.md, pages-routes.md, database-schema.md) that are missing entries for recent additions.',
  },
  {
    key: 'deps-cve',
    prompt:
      'Audit DEPENDENCIES. Run `npm audit --json` and `npm audit --omit=dev --json` via Bash and report unfixed vulnerabilities grouped by severity, separating prod from dev. Flag deprecated/abandoned packages and overly-loose version ranges on security-sensitive deps. Note: the dompurify CVE was cleared on 2026-05-30 and dompurify is still present as a transitive dep — verify it is still clear. ws and protocol-buffers-schema are no longer in package-lock.json at all (re-verified 2026-07-27), so do not hunt for them. Stay factual; do not propose upgrades you have not validated.',
  },
  {
    key: 'test-coverage-gaps',
    prompt:
      'Audit TEST COVERAGE relative to RISK (do not run the full suite — reason from file presence + grep). Identify high-risk areas (money math, mutating RPCs, RLS/security, financial lifecycles) that have thin or no unit-test coverage. Count skipped tests (grep for it.skip / describe.skip / .skip() ) and flag any that guard a critical financial or security path. Severity should reflect the risk of the UNTESTED area, not raw coverage percentage.',
  },
]

// Optional focus: pass args = { only: ['db-security', ...] } to re-run a subset
// of dimensions (e.g. to recover dimensions whose verifiers flaked on a prior run).
// The workflow harness may pass args as an object or a JSON-encoded string.
let ARGS_INVALID = false
const A = (() => {
  if (!args) return {}
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {}
    ARGS_INVALID = true
    return {}
  }
  if (typeof args === 'object' && !Array.isArray(args)) return args
  ARGS_INVALID = true
  return {}
})()
const HAS_ONLY = Object.prototype.hasOwnProperty.call(A, 'only')
const INVALID_ONLY = ARGS_INVALID || (HAS_ONLY && (!Array.isArray(A.only) || A.only.length === 0))
const REQUESTED_ONLY = Array.isArray(A.only) && A.only.length ? [...new Set(A.only)] : []
const UNKNOWN_ONLY = REQUESTED_ONLY.filter((key) => !DIMENSIONS.some((d) => d.key === key))
const SELECTED = INVALID_ONLY
  ? []
  : REQUESTED_ONLY.length
    ? DIMENSIONS.filter((d) => REQUESTED_ONLY.includes(d.key))
    : DIMENSIONS

function verifyPrompt(d, f) {
  return [
    PREAMBLE,
    '',
    'ADVERSARIAL VERIFICATION. A prior audit agent (dimension: ' + d.key + ') reported the finding below. Challenge it against current evidence. REFUTED requires concrete counter-evidence; missing or inconclusive evidence is UNVERIFIED.',
    '',
    'FINDING:',
    '- Title: ' + f.title,
    '- Claimed severity: ' + f.severity,
    '- Location: ' + (f.file || f.area),
    '- Evidence claimed: ' + f.evidence,
    '- Impact claimed: ' + f.impact,
    '- Recommendation: ' + f.recommendation,
    '',
    'Independently verify against the CURRENT code on disk and the LIVE database (read-only). Specifically check:',
    '1. Does the cited file:line / table / function actually exhibit this right now?',
    '2. Is it already mitigated elsewhere — a trigger, an RLS policy, a PreToolUse hook, a deployed-vs-disk difference, or a documented ACCEPTED exception in AGENTS.md or a workflow/reference file it routes?',
    '3. Is the severity calibrated correctly?',
    '',
    'Return status=VERIFIED only with concrete confirming evidence. Return REFUTED + revisedSeverity=FALSE_POSITIVE only with concrete counter-evidence. Return UNVERIFIED + revisedSeverity=UNVERIFIED when access, tools, or evidence are incomplete. In verifiedAgainst, state exactly what you ran or read.',
    '',
    'IMPORTANT: You MUST finish by returning your verdict via the StructuredOutput tool — never end with prose only. Uncertainty is UNVERIFIED, never REFUTED or FALSE_POSITIVE.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Run: each dimension reviews, then each of its findings is verified as soon
// as that dimension finishes (pipeline — no barrier between review and verify).
// ---------------------------------------------------------------------------
log('Starting whole-codebase audit across ' + SELECTED.length + ' dimensions (read-only).')

const results = await pipeline(
  SELECTED,
  (d) =>
    agent(PREAMBLE + '\n\n' + d.prompt, {
      label: 'audit:' + d.key,
      phase: 'Audit',
      schema: FINDINGS_SCHEMA,
    }),
  (review, d) => {
    if (!isCompleteReview(review)) {
      const blockedReason = review?.executionStatus === 'BLOCKED'
        ? `Finder reported blocked evidence: ${review.evidenceSummary || review.summary || 'unspecified blocker'}`
        : 'Finder returned no VERIFIED evidence status or omitted evidence/findings/summary.'
      const partialFindings = Array.isArray(review?.findings)
        ? review.findings.map((f) => ({
            ...f,
            dimension: d.key,
            status: 'UNVERIFIED',
            reason: `${blockedReason} Partial finding preserved without adversarial verification.`,
          }))
        : []
      return [{
        dimension: d.key,
        status: 'BLOCKED',
        reason: blockedReason,
      }, ...partialFindings]
    }

    const malformed = review.findings
      .filter((f) => !isCompleteFinding(f))
      .map((f) => ({
        ...f,
        dimension: d.key,
        status: 'UNVERIFIED',
        reason: 'Finder omitted required evidence fields or returned an unsupported enum value.',
      }))

    return parallel(
      review.findings.filter(isCompleteFinding).map((f) => () =>
        agent(verifyPrompt(d, f), {
          label: 'verify:' + d.key + ':' + f.severity,
          phase: 'Verify',
          schema: VERDICT_SCHEMA,
        }).then((v) => {
          const verdict = normalizeVerdict(v)
          return {
            ...f,
            dimension: d.key,
            status: verdict.status,
            verdict,
            finalSeverity: verdict.status === 'VERIFIED' ? verdict.revisedSeverity : f.severity,
          }
        })
      )
    ).then((verified) => [...verified, ...malformed])
  }
)

const selectionBlocked = UNKNOWN_ONLY.map((key) => ({
  dimension: String(key),
  status: 'BLOCKED',
  reason: `Unknown requested audit dimension: ${String(key)}`,
}))
if (INVALID_ONLY) selectionBlocked.push({
  dimension: 'only',
  status: 'BLOCKED',
  reason: 'Invalid audit selection: args.only must be an array.',
})
const all = [...selectionBlocked, ...results.flat().filter(Boolean)]
const confirmed = all.filter((f) => f.status === 'VERIFIED')
const refuted = all.filter((f) => f.status === 'REFUTED')
const unverified = all.filter((f) => f.status === 'UNVERIFIED')
const blocked = all.filter((f) => f.status === 'BLOCKED')
const overallStatus = blocked.length || unverified.length ? 'BLOCKED' : 'VERIFIED'

const order = { BLOCKER: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }
confirmed.sort((a, b) => (order[a.finalSeverity] ?? 9) - (order[b.finalSeverity] ?? 9))

const bySeverity = {
  BLOCKER: confirmed.filter((f) => f.finalSeverity === 'BLOCKER').length,
  HIGH: confirmed.filter((f) => f.finalSeverity === 'HIGH').length,
  MEDIUM: confirmed.filter((f) => f.finalSeverity === 'MEDIUM').length,
  LOW: confirmed.filter((f) => f.finalSeverity === 'LOW').length,
}

log(
  'Audit complete: ' +
    confirmed.length +
    ' confirmed (' +
    bySeverity.BLOCKER +
    ' BLOCKER / ' +
    bySeverity.HIGH +
    ' HIGH / ' +
    bySeverity.MEDIUM +
    ' MEDIUM / ' +
    bySeverity.LOW +
    ' LOW), ' +
    refuted.length +
    ' refuted, ' +
    unverified.length +
    ' unverified, ' +
    blocked.length +
    ' blocked, across ' +
    SELECTED.length +
    ' dimensions.'
)

return {
  dimensionsRun: SELECTED.map((d) => d.key),
  overallStatus,
  complete: overallStatus === 'VERIFIED',
  clean: overallStatus === 'VERIFIED' && confirmed.length === 0,
  counts: { confirmed: confirmed.length, refuted: refuted.length, unverified: unverified.length, blocked: blocked.length, bySeverity },
  confirmed,
  refuted,
  unverified,
  blocked,
}
