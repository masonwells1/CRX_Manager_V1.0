export const meta = {
  name: 'gauntlet-sections-2-6-loop',
  description:
    'Sequential CRX Live Foundation Gauntlet loop over sections 2-6 (Money, Inventory, Lifecycle, DB-drift, Idempotency). Opus 4.8 orchestrates; sonnet finders fan out per section against live code + Supabase; opus skeptics adversarially refute every BLOCKER/HIGH, and an opus adjudicator must agree each section is SETTLED before the loop advances. Read-only: queries the live DB and reads code, mutates nothing.',
  whenToUse:
    'Overnight/unattended foundation audit of the money+inventory+lifecycle+drift+idempotency surface, one section at a time, with adversarial agreement gating each hand-off. Returns structured per-section results for the orchestrator to write reports + a parked remediation punch list.',
  phases: [
    { title: 'S2 Money', detail: 'find -> adversarial refute -> adjudicate settled' },
    { title: 'S3 Inventory', detail: 'find -> adversarial refute -> adjudicate settled' },
    { title: 'S4 Lifecycle', detail: 'find -> adversarial refute -> adjudicate settled' },
    { title: 'S5 DB-drift', detail: 'find (baseline=origin/main merge-base) -> refute -> adjudicate' },
    { title: 'S6 Idempotency', detail: 'find -> adversarial refute -> adjudicate settled' },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared rules + schemas (mirrors the vetted .claude/workflows/review-workflow.js)
// ─────────────────────────────────────────────────────────────────────────────
const GROUND_RULE =
  'TRUST NOTHING PRE-WRITTEN. CLAUDE.md lifecycles, the workflow map, the schema registry, and prior docs/audits are LEADS to CONFIRM by reading actual source under src/ + supabase/migrations/ AND querying the live Supabase DB (project rhyzpcqhnizqbxphqdkr) read-only via Supabase MCP execute_sql / list_tables / get_advisors. Never mutate: no INSERT/UPDATE/DELETE/DDL, no apply_migration, no deploy. Return executionStatus=BLOCKED (naming the unavailable source) if required code or live-DB evidence cannot be gathered; an empty findings array is valid ONLY with executionStatus=VERIFIED and a concrete evidenceSummary. A finding with no file:line / constraint / migration / RPC citation does not belong in the output. Separate "verified real" from "looked suspicious but checked out fine" (verifiedSafe). Money is bigint cents — flag any float/parseFloat on *_cents. Do NOT re-flag known intentional exceptions: profile_public_view RLS, /payments being admin+sales, get_field_geojson being live, balance_cents being a generated column.'

const FINDINGS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    executionStatus: { type: 'string', enum: ['VERIFIED', 'BLOCKED'] },
    evidenceSummary: { type: 'string', description: 'Concrete files, SQL queries, and commands successfully run — or the exact access blocker.' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['BLOCKER', 'HIGH', 'MED', 'LOW'] },
          title: { type: 'string' },
          location: { type: 'string', description: 'file:line, constraint name, migration filename, or RPC name' },
          evidence: { type: 'string', description: 'Concrete code, DB, or command evidence supporting the finding.' },
          detail: { type: 'string' },
          recommendation: { type: 'string' },
        },
        required: ['severity', 'title', 'location', 'evidence', 'detail', 'recommendation'],
      },
    },
    verifiedSafe: { type: 'array', items: { type: 'string' }, description: 'Leads checked and found correct.' },
    summary: { type: 'string' },
  },
  required: ['executionStatus', 'evidenceSummary', 'findings', 'summary'],
}

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['VERIFIED', 'REFUTED', 'UNVERIFIED'] },
    reasoning: { type: 'string' },
    verifiedAgainst: { type: 'string', description: 'Exact file:line, SQL result, or command used for the verdict.' },
  },
  required: ['status', 'reasoning', 'verifiedAgainst'],
}

const ADJUDICATION = {
  type: 'object',
  additionalProperties: false,
  properties: {
    settled: { type: 'boolean', description: 'True only if every candidate finding has a terminal VERIFIED/REFUTED verdict and no obvious evidence gap remains.' },
    cleanOfBlockerHigh: { type: 'boolean', description: 'True only if zero CONFIRMED BLOCKER/HIGH findings remain open.' },
    remainingGaps: { type: 'array', items: { type: 'string' }, description: 'Angles or evidence still missing; empty when settled.' },
    rationale: { type: 'string' },
  },
  required: ['settled', 'cleanOfBlockerHigh', 'remainingGaps', 'rationale'],
}

const NON_EMPTY = ['title', 'location', 'evidence', 'detail', 'recommendation']
const isStr = (v) => typeof v === 'string' && v.trim().length > 0
const layerOk = (r) => Boolean(r && r.executionStatus === 'VERIFIED' && isStr(r.evidenceSummary) && Array.isArray(r.findings) && isStr(r.summary))
const findingOk = (f) => Boolean(f && ['BLOCKER', 'HIGH', 'MED', 'LOW'].includes(f.severity) && NON_EMPTY.every((k) => isStr(f[k])))
const keyOf = (f) => `${(f.title || '').toLowerCase().trim()}::${(f.location || '').toLowerCase().trim()}`

function normVerdict(v) {
  if (!v || !['VERIFIED', 'REFUTED', 'UNVERIFIED'].includes(v.status) || !isStr(v.reasoning) || !isStr(v.verifiedAgainst)) {
    return { status: 'UNVERIFIED', reasoning: 'Verifier returned no structured verdict or omitted required evidence.', verifiedAgainst: 'none', malformed: true }
  }
  return { ...v, malformed: false }
}

// ─────────────────────────────────────────────────────────────────────────────
// Section definitions: each finder is one slice; general-purpose so it can run
// git/grep + Supabase MCP. Finders run on sonnet; skeptics + adjudicator on opus.
// ─────────────────────────────────────────────────────────────────────────────
const SECTIONS = {
  2: {
    phase: 'S2 Money',
    name: 'Money — invoices, payments, AR aging, statements, credits, write-offs, finance charges',
    finders: [
      `Section 2a — Invoices & AR truth. ${GROUND_RULE}\n\nVerify against src/ + live DB:\n- balance_cents is the GENERATED single source of AR truth and is never written by code (grep src/ for any .update touching balance_cents — that is a Hard Red Line violation).\n- post_invoice enforces check_period_open / period gating; posting is idempotent (p_idempotency_key read+written to idempotency_keys).\n- Payment allocation + prepay application correctly reduce balance; totals never use float/parseFloat on *_cents.\n- AR aging buckets (current/30/60/90) are computed from due_date correctly and sum to the invoice balance.\n- Statement generation totals reconcile to invoice balances.\nCite file:line / RPC / constraint. Query live pg_proc/pg_constraint where useful.`,
      `Section 2b — Payments, credits, write-offs, finance charges. ${GROUND_RULE}\n\nVerify:\n- Payment application/allocation is idempotent and cannot double-apply on retry/double-submit; overpayment/refund/prepay paths are money-correct (bigint cents only).\n- Credit-memo apply AND unapply/reversal correctly move balance both directions with no orphaned credit.\n- Write-offs reduce balance through the generated column path (never direct balance write) and post to financial_audit_log (append-only).\n- Finance-charge calculation uses integer cents math (no float), respects the configured rate, and is not double-charged across cycles.\nCite file:line / RPC / constraint / live query result.`,
    ],
  },
  3: {
    phase: 'S3 Inventory',
    name: 'Inventory — holds, prebooks, Net Free, quote draw-down, deliveries, receiving',
    finders: [
      `Section 3a — Holds, prebooks, Net Free, quote draw-down. ${GROUND_RULE}\n\nVerify:\n- Net Free = on_hand - held (confirm the exact formula in code + any RPC/view); it never goes silently negative without a guard.\n- Quote draw-down / is_planned reservations reserve and RELEASE correctly (a hold is released on quote->order conversion and on quote cancel/expire — no leaked holds).\n- Prebook reservations are honored and cannot be double-counted against the same stock.\n- Reservation math uses integer quantities and cannot oversell.\nCite file:line / RPC. Cross-check live reservation/hold tables via execute_sql where useful.`,
      `Section 3b — Deliveries & receiving ledger. ${GROUND_RULE}\n\nVerify:\n- Inventory is deducted exactly once on complete_delivery (not on schedule; no double-deduct on retry) and complete_delivery requires p_signed_by.\n- Receiving adds to the ledger with the correct transaction type; inventory_transactions is immutable (UPDATE+DELETE blocked — confirm the live trigger/policy).\n- Transaction types are consistent (receive vs adjust vs deliver) and quantities net correctly to on_hand.\n- No path leaves inventory reserved-but-never-released or deducted-but-never-recorded.\nCite file:line / RPC / trigger / live query.`,
    ],
  },
  4: {
    phase: 'S4 Lifecycle',
    name: 'Lifecycle wiring — quote -> order -> delivery -> invoice -> payment',
    finders: [
      `Section 4a — Quote -> Order -> Delivery. ${GROUND_RULE}\n\nTrace the conversion RPCs and confirm nothing strands an entity:\n- convert_quote_to_order: holds released, items copied, source linked, planned reservations resolved.\n- Order -> Delivery (confirm_delivery/complete_delivery): items locked after scheduled, inventory deducted on complete, signature required.\n- For each state, is there an exit? Hunt ghost states (status set in code but absent from the live CHECK constraint — would crash) and orphan states (CHECK value no RPC reaches). Query live CHECK constraints for quotes/orders/deliveries.\nCite file:line / RPC / constraint.`,
      `Section 4b — Delivery/Blend -> Invoice -> Payment. ${GROUND_RULE}\n\nVerify:\n- Invoice must have order_id OR blend_ticket_id (no dangling invoice); balance_cents generated is AR truth.\n- Invoice -> Payment: allocation + prepay application update balance; post_invoice enforces period-open.\n- Blend ticket -> Order/Invoice/Application: the OCR/handoff path produces a LINKED entity, not a dangling row.\n- Can any entity get PERMANENTLY stuck (state with no exit, hold never released, created-but-never-linked row, missing reversal path)? Reconcile live CHECK vs the statuses the transition RPCs actually move between.\nCite file:line / RPC / constraint.`,
    ],
  },
  5: {
    phase: 'S5 DB-drift',
    name: 'Database drift — migrations on disk vs schema registry vs live catalog, CHECK constraints, overloads, generated columns, search_path',
    finders: [
      `Section 5a — Drift, baselined against origin/main (NOT the checkout). ${GROUND_RULE}\n\nCRITICAL BASELINE RULE: judge drift against the merge-base of origin/main..HEAD, never the current checkout — a two-dot diff on a behind branch reports every migration main added since the fork as a false deletion. This read-only workflow must NOT fetch or mutate refs. The caller must refresh origin/main before launching it; if origin/main freshness cannot be established, return executionStatus=BLOCKED. Then run: \`git rev-list --left-right --count origin/main...HEAD\`; \`MB=$(git merge-base origin/main HEAD)\`; \`git diff --name-status "$MB" -- supabase/migrations\`; \`git ls-files --others --exclude-standard -- supabase/migrations\`. If the branch is behind, that is a stale-branch artifact, NOT a finding.\n\nThen verify:\n- CHECK-constraint supersets: any new enum/status CHECK includes ALL previously-allowed values (no value silently dropped).\n- Function-overload collisions: \`SELECT proname, count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace GROUP BY proname HAVING count(*)>1;\` should be EMPTY (accidental dual-overload is a real bug).\n- Generated columns (e.g. invoices.balance_cents) still generated live and never written by code.\n- Every SECURITY DEFINER function has SET search_path = public, pg_temp (query pg_proc.proconfig live).\n- schema-registry (.claude/schema-registry.json) vs disk migrations vs live catalog: note real trailing drift, but the live-row-count vs disk-file-count gap is pre-existing MCP-stamp/rename drift and is OUT OF SCOPE.\nCite migration filename / constraint / pg_proc row.`,
    ],
  },
  6: {
    phase: 'S6 Idempotency',
    name: 'Idempotency & double-submit safety for mutating RPCs and frontend callers',
    finders: [
      `Section 6a — Mutating-RPC idempotency (server side). ${GROUND_RULE}\n\nStart from the CURRENT full mutator set, not just RPCs that already declare a key. Enumerate every mutating RPC live: \`SELECT proname, pg_get_function_arguments(oid) FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY proname;\`. For each mutator verify it BOTH accepts p_idempotency_key text DEFAULT NULL AND actually reads/writes idempotency_keys (columns idempotency_key/operation/result) so a retry returns the cached result instead of re-mutating.\nKNOWN LEAD to confirm or refute against current code+DB: save_job_applied_record can create DUPLICATE applied-info records on retry/double-submit (2026-07-08 Section 6). Confirm whether the fix landed on origin/main.\nAny mutator missing real idempotency enforcement is a finding (severity by blast radius: money/inventory writes = BLOCKER/HIGH).\nCite RPC name / proc body / file:line.`,
      `Section 6b — Frontend double-submit callers. ${GROUND_RULE}\n\nVerify the frontend side: mutating buttons/flows that call idempotent RPCs actually PASS a stable idempotency key (not a fresh random each click), and disable/guard against double-click while in flight. Check assertRpcResult() is called after RPCs and checkMutationResult() after .update()/.delete(). Focus on money+inventory+lifecycle mutations (post invoice, take payment, apply credit, complete delivery, receive, convert quote). Cite file:line.`,
    ],
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-section driver: find (loop-until-dry, max 2 rounds) -> adversarial verify
// -> opus adjudicator must agree SETTLED before the section is released.
// ─────────────────────────────────────────────────────────────────────────────
async function runSection(num) {
  const sec = SECTIONS[num]
  const ph = sec.phase
  const seen = new Set()
  const confirmed = []
  const refuted = []
  const unverified = []
  const verifiedSafe = []
  const blocked = []
  let adjudication = null

  const MAX_ROUNDS = 2
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    log(`[S${num}] round ${round}: dispatching ${sec.finders.length} finder(s).`)

    // FIND — finders on sonnet, general-purpose so they can run git/grep + Supabase MCP.
    const reviews = await parallel(
      sec.finders.map((p, i) => () =>
        agent(p, { agentType: 'general-purpose', model: 'sonnet', schema: FINDINGS, phase: ph, label: `S${num}:find${i + 1}:r${round}` })
      )
    )
    reviews.forEach((r, i) => {
      if (!layerOk(r)) {
        blocked.push({ section: num, finder: i + 1, round, reason: r?.executionStatus === 'BLOCKED' ? (r.evidenceSummary || r.summary || 'blocked') : 'finder returned no VERIFIED evidence' })
        return
      }
      ;(r.verifiedSafe || []).forEach((s) => verifiedSafe.push({ section: num, note: s }))
    })

    // Completeness critic (opus) — what angle did the finders miss?
    const critic = await agent(
      `Section ${num} (${sec.name}) completeness critic. ${GROUND_RULE}\n\nThe finders already ran. Your job: find what they MISSED — an unqueried live constraint, an untraced RPC branch, a money/idempotency edge case, a reversal path not checked. Return ONLY additional, independently-evidenced findings (no restating theirs). Empty findings + VERIFIED is a valid "nothing missed" answer.`,
      { agentType: 'general-purpose', model: 'opus', schema: FINDINGS, phase: ph, label: `S${num}:critic:r${round}` }
    )
    if (layerOk(critic)) {
      ;(critic.verifiedSafe || []).forEach((s) => verifiedSafe.push({ section: num, note: s }))
    } else {
      blocked.push({
        section: num,
        critic: true,
        round,
        reason: critic?.executionStatus === 'BLOCKED'
          ? (critic.evidenceSummary || critic.summary || 'completeness critic blocked')
          : 'completeness critic returned no VERIFIED evidence',
      })
    }

    const raw = [...reviews, critic].filter(layerOk).flatMap((r) => r.findings)
    const fresh = raw.filter(findingOk).filter((f) => !seen.has(keyOf(f)))
    fresh.forEach((f) => seen.add(keyOf(f)))
    log(`[S${num}] round ${round}: ${fresh.length} fresh candidate finding(s).`)

    // Malformed finder findings never silently vanish.
    raw.filter((f) => !findingOk(f)).forEach((f) =>
      unverified.push({ ...f, section: num, status: 'UNVERIFIED', reason: 'finder omitted a required field; not silently dropped' })
    )

    // VERIFY — only BLOCKER/HIGH get the adversarial pass; MED/LOW recorded as-is.
    const toVerify = fresh.filter((f) => f.severity === 'BLOCKER' || f.severity === 'HIGH')
    fresh.filter((f) => f.severity === 'MED' || f.severity === 'LOW').forEach((f) =>
      unverified.push({ ...f, section: num, status: 'UNVERIFIED', reason: 'MED/LOW not adversarially verified' })
    )

    const verdicts = await parallel(
      toVerify.map((f) => () =>
        parallel(
          [1, 2].map((n) => () =>
            agent(
              `A finder flagged this ${f.severity} in CRX Manager Section ${num}:\n\nTitle: ${f.title}\nLocation: ${f.location}\nDetail: ${f.detail}\nEvidence claimed: ${f.evidence}\n\nYour job is to REFUTE it. Read the actual code and query the live DB yourself. Return VERIFIED only when concrete evidence confirms a real user-facing/data/money problem, REFUTED only when concrete evidence disproves it, UNVERIFIED when tools/access/evidence are missing. Uncertainty is never "refuted".`,
              { agentType: 'general-purpose', model: 'opus', schema: VERDICT, phase: ph, label: `S${num}:verify:${f.title.slice(0, 20)}#${n}` }
            )
          )
        ).then((votes) => {
          const v = votes.map(normVerdict)
          const complete = v.length === 2 && v.every((x) => !x.malformed && x.status !== 'UNVERIFIED')
          const status = !complete ? 'UNVERIFIED' : v.some((x) => x.status === 'VERIFIED') ? 'VERIFIED' : 'REFUTED'
          return { ...f, section: num, status, votes: v }
        })
      )
    )
    verdicts.filter(Boolean).forEach((r) => {
      if (r.status === 'VERIFIED') confirmed.push(r)
      else if (r.status === 'REFUTED') refuted.push(r)
      else unverified.push({ ...r, reason: 'adversarial verdict inconclusive — evidence missing' })
    })

    if (fresh.length === 0) {
      log(`[S${num}] round ${round}: dry (no fresh findings) — stopping find loop.`)
      break
    }
  }

  // ADJUDICATE — opus adjudicator must agree the section is SETTLED before release.
  adjudication = await agent(
    `Section ${num} (${sec.name}) adjudicator. You gate whether this section is SETTLED enough to hand off to the next section.\n\n` +
      `CONFIRMED (survived adversarial refute): ${JSON.stringify(confirmed.map((f) => ({ severity: f.severity, title: f.title, location: f.location })))}\n` +
      `REFUTED: ${JSON.stringify(refuted.map((f) => ({ title: f.title, location: f.location })))}\n` +
      `UNVERIFIED/MED/LOW/malformed: ${JSON.stringify(unverified.map((f) => ({ severity: f.severity, title: f.title, reason: f.reason })))}\n` +
      `BLOCKED evidence: ${JSON.stringify(blocked)}\n\n` +
      `settled=true ONLY if every candidate has a terminal VERIFIED/REFUTED verdict and no important angle is left with missing evidence (a BLOCKED finder or an UNVERIFIED BLOCKER/HIGH means NOT settled). cleanOfBlockerHigh=true ONLY if zero CONFIRMED BLOCKER/HIGH remain. List remainingGaps if not settled.`,
    { agentType: 'general-purpose', model: 'opus', schema: ADJUDICATION, phase: ph, label: `S${num}:adjudicate` }
  )

  const counts = {
    blocker: confirmed.filter((f) => f.severity === 'BLOCKER').length,
    high: confirmed.filter((f) => f.severity === 'HIGH').length,
    refuted: refuted.length,
    unverified: unverified.length,
    blocked: blocked.length,
  }
  log(`[S${num}] DONE — confirmed ${counts.blocker} BLOCKER / ${counts.high} HIGH · refuted ${counts.refuted} · unverified ${counts.unverified} · settled=${adjudication?.settled} cleanBH=${adjudication?.cleanOfBlockerHigh}`)

  return { section: num, name: sec.name, confirmed, refuted, unverified, verifiedSafe, blocked, adjudication, counts }
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrate sequentially: no section advances until its adjudicator agrees.
// ─────────────────────────────────────────────────────────────────────────────
const order = Array.isArray(args?.sections) && args.sections.length ? args.sections : [2, 3, 4, 5, 6]
const results = []
for (const num of order) {
  if (!SECTIONS[num]) { log(`Skipping unknown section ${num}`); continue }
  phase(SECTIONS[num].phase)
  const res = await runSection(num)
  results.push(res)
  if (!res.adjudication?.settled) {
    log(`[S${num}] adjudicator did NOT agree settled — recording gaps and halting before the next section.`)
    break
  }
}

return {
  scope: order,
  results,
  totals: {
    blocker: results.reduce((a, r) => a + r.counts.blocker, 0),
    high: results.reduce((a, r) => a + r.counts.high, 0),
    unverified: results.reduce((a, r) => a + r.counts.unverified, 0),
    blocked: results.reduce((a, r) => a + r.counts.blocked, 0),
    sectionsSettled: results.filter((r) => r.adjudication?.settled).length,
    sectionsCleanOfBlockerHigh: results.filter((r) => r.adjudication?.cleanOfBlockerHigh).length,
  },
  readOnly: true,
  note: 'Read-only audit. Confirmed findings are a PARKED remediation punch list — no code/DB was changed. Fixes need Mason + Codex gate.',
}
