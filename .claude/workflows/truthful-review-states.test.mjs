import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

async function executeWorkflow(relativePath, agent, args = {}) {
  const source = (await readFile(new URL(relativePath, import.meta.url), 'utf8')).replace(
    'export const meta',
    'const meta'
  )
  const parallel = async (tasks) => Promise.all(tasks.map((task) => task()))
  const pipeline = async (items, finder, verifier) =>
    Promise.all(items.map(async (item) => verifier(await finder(item), item)))
  const logs = []
  const run = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', source)
  const result = await run(agent, parallel, pipeline, () => {}, (message) => logs.push(message), args)
  return { result, logs }
}

function completeLayer(findings = []) {
  return {
    executionStatus: 'VERIFIED',
    evidenceSummary: 'Read current source and completed the required read-only evidence checks.',
    summary: 'Completed review with concrete evidence.',
    findings,
    verifiedSafe: [],
  }
}

function completeFinding() {
  return {
    title: 'Example money defect',
    dedupeKey: 'money:example:wrong-total',
    bugClass: 'money-cents',
    severity: 'HIGH',
    fixKind: 'frontend-only',
    area: 'page:Example',
    file: 'src/pages/Example.tsx:10',
    evidence: 'The total adds dollars directly to cents at line 10.',
    impact: 'A customer can receive the wrong total.',
    recommendation: 'Keep the calculation in integer cents.',
    confidence: 'high',
  }
}

{
  const { result } = await executeWorkflow('./review-workflow.js', async (_prompt, options) => {
    if (options.label === 'layer:B-lifecycle') return null
    return completeLayer()
  })

  assert.equal(result.overallStatus, 'BLOCKED', 'a missing review layer must block the workflow')
  assert.equal(result.complete, false)
  assert.equal(result.clean, false)
  assert.equal(result.blocked.length, 1)
  assert.equal(result.blocked[0].layer, 'B-lifecycle')
  assert.equal(result.refuted.length, 0, 'a missing layer must never count as refuted')
}

{
  const partialFinding = {
    severity: 'HIGH',
    title: 'Partial source-backed finding',
    location: 'src/example.ts:12',
    evidence: 'The repository source shows the unsafe assignment.',
    detail: 'Live database confirmation was unavailable.',
    recommendation: 'Confirm live state before fixing.',
  }
  const { result } = await executeWorkflow('./review-workflow.js', async (_prompt, options) => {
    if (options.label === 'layer:B-lifecycle') {
      return {
        executionStatus: 'BLOCKED',
        evidenceSummary: 'Repository source was read, but the live database was unavailable.',
        summary: 'Partial evidence only.',
        findings: [partialFinding],
        verifiedSafe: [],
      }
    }
    if (options.label?.startsWith('layer:')) return completeLayer()
    throw new Error(`A blocked layer finding must not reach verification: ${options.label}`)
  })

  assert.equal(result.overallStatus, 'BLOCKED')
  assert.equal(result.blocked.length, 1)
  assert.equal(result.unverified.length, 1, 'blocked-layer findings must remain visible')
  assert.equal(result.unverified[0].title, partialFinding.title)
  assert.equal(result.unverified[0].status, 'UNVERIFIED')
}

{
  const { result } = await executeWorkflow('./review-workflow.js', async (_prompt, options) => {
    if (options.label === 'layer:B-lifecycle') {
      return { findings: [], summary: 'Live database was unavailable.', verifiedSafe: [] }
    }
    return completeLayer()
  })

  assert.equal(result.overallStatus, 'BLOCKED', 'a summary without VERIFIED evidence status must block')
  assert.equal(result.clean, false)
  assert.equal(result.blocked.length, 1)
}

{
  const finding = {
    severity: 'HIGH',
    title: 'Example finding',
    location: 'src/example.ts:12',
    evidence: 'The current branch reaches the incorrect assignment.',
    detail: 'A reachable path assigns the wrong status.',
    recommendation: 'Assign the constrained status.',
  }
  const { result } = await executeWorkflow('./review-workflow.js', async (_prompt, options) => {
    if (options.label === 'layer:A-graph') return completeLayer([finding])
    if (options.label?.startsWith('layer:')) return completeLayer()
    if (options.label?.startsWith('verify:')) return null
    throw new Error(`Unexpected agent label: ${options.label}`)
  })

  assert.equal(result.overallStatus, 'BLOCKED', 'missing verifier output must block the workflow')
  assert.equal(result.clean, false)
  assert.equal(result.confirmed.length, 0)
  assert.equal(result.refuted.length, 0, 'missing verifier output must never refute a finding')
  assert.equal(result.unverified.length, 1)
  assert.equal(result.unverified[0].status, 'UNVERIFIED')
}

{
  const findingWithoutEvidence = {
    severity: 'HIGH',
    title: 'Unsubstantiated finding',
    location: 'src/example.ts:12',
    detail: 'The finder supplied a conclusion but no concrete observation.',
    recommendation: 'Re-run with evidence.',
  }
  const { result } = await executeWorkflow('./review-workflow.js', async (_prompt, options) => {
    if (options.label === 'layer:A-graph') return completeLayer([findingWithoutEvidence])
    if (options.label?.startsWith('layer:')) return completeLayer()
    throw new Error(`An evidence-free finding must not reach verification: ${options.label}`)
  })

  assert.equal(result.overallStatus, 'BLOCKED')
  assert.equal(result.refuted.length, 0)
  assert.equal(result.unverified.length, 1, 'an evidence-free finding must stay visible as unverified')
  assert.match(result.unverified[0].reason, /omitted a required location\/evidence field/)
}

for (const workflow of ['./overnight-bug-hunt.js', './money-inventory-hunt.js']) {
  const { result, logs } = await executeWorkflow(
    workflow,
    async (_prompt, options) => {
      if (options.label?.startsWith('hunt:')) return completeLayer([completeFinding()])
      if (options.label?.startsWith('verify:')) return null
      throw new Error(`Unexpected agent label: ${options.label}`)
    },
    { only: ['invoices-core'] }
  )

  assert.equal(result.overallStatus, 'BLOCKED', `${workflow}: missing verifier output must block`)
  assert.equal(result.complete, false)
  assert.equal(result.clean, false)
  assert.equal(result.confirmed.length, 0)
  assert.equal(result.refuted.length, 0, `${workflow}: missing verifier output must not refute`)
  assert.equal(result.unverified.length, 1)
  assert.equal(result.unverified[0].status, 'UNVERIFIED')
  assert.equal(result.reviewerIndependence.independentModelFamilies, false)
  assert.ok(logs.some((line) => line.includes('Reviewer-independence limitation')))
}

for (const workflow of ['./overnight-bug-hunt.js', './money-inventory-hunt.js']) {
  const { result } = await executeWorkflow(
    workflow,
    async (_prompt, options) => {
      if (options.label?.startsWith('hunt:')) return completeLayer()
      throw new Error(`No verifier expected for an empty finder: ${options.label}`)
    },
    { only: ['invoices-core', 'typo-subsystem'] }
  )

  assert.equal(result.overallStatus, 'BLOCKED', `${workflow}: unknown subsystem must block`)
  assert.equal(result.complete, false)
  assert.equal(result.clean, false)
  assert.equal(result.blocked.length, 1)
  assert.equal(result.blocked[0].dimension, 'typo-subsystem')
}

for (const workflow of ['./overnight-bug-hunt.js', './money-inventory-hunt.js']) {
  for (const args of [{ phase: 99 }, { only: 'invoices-core' }]) {
    const { result } = await executeWorkflow(
      workflow,
      async (_prompt, options) => {
        throw new Error(`Invalid selection must not dispatch a finder: ${options.label}`)
      },
      args
    )

    assert.equal(result.overallStatus, 'BLOCKED', `${workflow}: invalid selection must block`)
    assert.equal(result.complete, false)
    assert.equal(result.clean, false)
    assert.equal(result.blocked.length, 1)
    assert.equal(result.subsystemsRun.length, 0, 'invalid selection must not silently run Phase 1')
  }
}

{
  const { result } = await executeWorkflow(
    './money-inventory-hunt.js',
    async (_prompt, options) => {
      if (options.label?.startsWith('hunt:')) return completeLayer()
      throw new Error(`No verifier expected for an empty finder: ${options.label}`)
    },
    { phase: 3 }
  )

  assert.equal(result.overallStatus, 'VERIFIED', 'a known Phase 3 must run instead of falling back')
  assert.ok(result.subsystemsRun.length > 0)
  assert.ok(result.subsystemsRun.includes('returns-credits'))
}

for (const workflow of ['./overnight-bug-hunt.js', './money-inventory-hunt.js']) {
  const { result } = await executeWorkflow(
    workflow,
    async (_prompt, options) => {
      if (options.label?.startsWith('hunt:')) return null
      throw new Error(`A verifier must not run after a missing finder: ${options.label}`)
    },
    { only: ['invoices-core'] }
  )

  assert.equal(result.overallStatus, 'BLOCKED', `${workflow}: missing finder output must block`)
  assert.equal(result.clean, false)
  assert.equal(result.refuted.length, 0, `${workflow}: missing finder output must not look refuted`)
  assert.equal(result.blocked.length, 1)
}

for (const workflow of ['./overnight-bug-hunt.js', './money-inventory-hunt.js']) {
  const partialFinding = completeFinding()
  const { result } = await executeWorkflow(
    workflow,
    async (_prompt, options) => {
      if (options.label?.startsWith('hunt:')) {
        return {
          executionStatus: 'BLOCKED',
          evidenceSummary: 'Repository source was read, but the live database was unavailable.',
          summary: 'Partial evidence only.',
          findings: [partialFinding],
          verifiedSafe: [],
        }
      }
      throw new Error(`A blocked finder finding must not reach verification: ${options.label}`)
    },
    { only: ['invoices-core'] }
  )

  assert.equal(result.overallStatus, 'BLOCKED')
  assert.equal(result.blocked.length, 1)
  assert.equal(result.unverified.length, 1, `${workflow}: blocked findings must remain visible`)
  assert.equal(result.unverified[0].title, partialFinding.title)
  assert.equal(result.unverified[0].status, 'UNVERIFIED')
}

{
  const { result } = await executeWorkflow(
    './overnight-bug-hunt.js',
    async (_prompt, options) => {
      if (options.label?.startsWith('hunt:')) return completeLayer([completeFinding()])
      if (options.label?.startsWith('verify:')) {
        return {
          status: 'REFUTED',
          revisedSeverity: 'FALSE_POSITIVE',
          reasoning: 'The cited line is guarded by the database constraint.',
          verifiedAgainst: 'src/pages/Example.tsx:10 and constraint example_total_check',
        }
      }
      throw new Error(`Unexpected agent label: ${options.label}`)
    },
    { only: ['invoices-core'] }
  )

  assert.equal(result.overallStatus, 'VERIFIED')
  assert.equal(result.refuted.length, 1, 'a complete evidence-backed refutation remains supported')
  assert.equal(result.unverified.length, 0)
  assert.equal(result.blocked.length, 0)
}

{
  const finding = {
    title: 'Example audit defect',
    severity: 'HIGH',
    area: 'RLS',
    file: 'supabase/migrations/example.sql:10',
    evidence: 'The policy permits a row outside the current user scope.',
    impact: 'A user could read another account\'s row.',
    recommendation: 'Bind the policy to the authenticated user.',
    confidence: 'high',
  }
  const { result } = await executeWorkflow(
    './whole-codebase-audit.js',
    async (_prompt, options) => {
      if (options.label === 'audit:db-security') {
        return { executionStatus: 'VERIFIED', evidenceSummary: 'Read the current policy source.', dimension: 'db-security', summary: 'Reviewed the current policy.', findings: [finding] }
      }
      if (options.label?.startsWith('verify:')) {
        return {
          status: 'VERIFIED',
          revisedSeverity: 'FALSE_POSITIVE',
          reasoning: 'This deliberately inconsistent verdict must fail closed.',
          verifiedAgainst: 'supabase/migrations/example.sql:10',
        }
      }
      throw new Error(`Unexpected agent label: ${options.label}`)
    },
    { only: ['db-security'] }
  )

  assert.equal(result.overallStatus, 'BLOCKED', 'an inconsistent audit verdict must block')
  assert.equal(result.clean, false)
  assert.equal(result.confirmed.length, 0, 'an invalid VERIFIED verdict must not count as confirmed')
  assert.equal(result.refuted.length, 0, 'an invalid VERIFIED verdict must not count as refuted')
  assert.equal(result.unverified.length, 1)
  assert.equal(result.unverified[0].verdict.status, 'UNVERIFIED')
}

for (const revisedSeverity of [undefined, 'CRITICAL']) {
  const finding = {
    title: 'Example audit severity defect',
    severity: 'HIGH',
    area: 'RLS',
    file: 'supabase/migrations/example.sql:10',
    evidence: 'The policy permits a row outside the current user scope.',
    impact: 'A user could read another account row.',
    recommendation: 'Bind the policy to the authenticated user.',
    confidence: 'high',
  }
  const { result } = await executeWorkflow(
    './whole-codebase-audit.js',
    async (_prompt, options) => {
      if (options.label === 'audit:db-security') {
        return { executionStatus: 'VERIFIED', evidenceSummary: 'Read the current policy source.', dimension: 'db-security', summary: 'Reviewed the current policy.', findings: [finding] }
      }
      if (options.label?.startsWith('verify:')) {
        return {
          status: 'VERIFIED',
          revisedSeverity,
          reasoning: 'A verified result must carry a supported severity.',
          verifiedAgainst: 'supabase/migrations/example.sql:10',
        }
      }
      throw new Error(`Unexpected agent label: ${options.label}`)
    },
    JSON.stringify({ only: ['db-security'] })
  )

  assert.equal(result.overallStatus, 'BLOCKED', `invalid VERIFIED severity ${String(revisedSeverity)} must block`)
  assert.equal(result.confirmed.length, 0)
  assert.equal(result.unverified.length, 1)
  assert.equal(result.unverified[0].verdict.status, 'UNVERIFIED')
}

{
  const { result } = await executeWorkflow(
    './whole-codebase-audit.js',
    async (_prompt, options) => {
      throw new Error(`An unknown audit dimension must not dispatch an agent: ${options.label}`)
    },
    { only: ['db-securty'] }
  )

  assert.equal(result.overallStatus, 'BLOCKED', 'an unknown audit dimension must block')
  assert.equal(result.complete, false)
  assert.equal(result.clean, false)
  assert.equal(result.dimensionsRun.length, 0)
  assert.equal(result.blocked.length, 1)
  assert.equal(result.blocked[0].dimension, 'db-securty')
}

for (const args of [{ only: 'db-security' }, { only: [] }, JSON.stringify({ only: 'db-security' })]) {
  const { result } = await executeWorkflow(
    './whole-codebase-audit.js',
    async (_prompt, options) => {
      throw new Error(`A malformed audit selection must not dispatch an agent: ${options.label}`)
    },
    args
  )

  assert.equal(result.overallStatus, 'BLOCKED', 'a malformed audit selection must block')
  assert.equal(result.complete, false)
  assert.equal(result.clean, false)
  assert.equal(result.dimensionsRun.length, 0)
  assert.equal(result.blocked.length, 1)
}

{
  const { result } = await executeWorkflow(
    './whole-codebase-audit.js',
    async (_prompt, options) => {
      if (options.label === 'audit:db-security') return null
      throw new Error(`A missing finder must not dispatch a verifier: ${options.label}`)
    },
    { only: ['db-security'] }
  )

  assert.equal(result.overallStatus, 'BLOCKED', 'missing whole-audit finder output must block')
  assert.equal(result.complete, false)
  assert.equal(result.clean, false)
  assert.equal(result.confirmed.length, 0)
  assert.equal(result.refuted.length, 0)
  assert.equal(result.unverified.length, 0)
  assert.equal(result.blocked.length, 1)
  assert.equal(result.blocked[0].dimension, 'db-security')
}

{
  const partialFinding = {
    title: 'Partial audit defect',
    severity: 'HIGH',
    area: 'RLS',
    file: 'supabase/migrations/example.sql:10',
    evidence: 'The policy appears to permit a row outside the current user scope.',
    impact: 'A user might read another account row.',
    recommendation: 'Re-run with live policy evidence available.',
    confidence: 'medium',
  }
  const { result } = await executeWorkflow(
    './whole-codebase-audit.js',
    async (_prompt, options) => {
      if (options.label === 'audit:db-security') {
        return {
          executionStatus: 'BLOCKED',
          evidenceSummary: 'Repository source was read, but the live database was unavailable.',
          dimension: 'db-security',
          summary: 'Partial evidence only.',
          findings: [partialFinding],
        }
      }
      throw new Error(`A blocked finder must not dispatch a verifier: ${options.label}`)
    },
    { only: ['db-security'] }
  )

  assert.equal(result.overallStatus, 'BLOCKED')
  assert.equal(result.clean, false)
  assert.equal(result.blocked.length, 1)
  assert.equal(result.unverified.length, 1, 'partial finder evidence must remain visible')
  assert.equal(result.unverified[0].title, partialFinding.title)
  assert.equal(result.unverified[0].status, 'UNVERIFIED')
}

{
  const malformedFinding = {
    title: 'Evidence-free audit defect',
    severity: 'HIGH',
    area: 'RLS',
    file: 'supabase/migrations/example.sql:10',
    impact: 'A user might read another account row.',
    recommendation: 'Supply concrete evidence before verification.',
    confidence: 'low',
  }
  const { result } = await executeWorkflow(
    './whole-codebase-audit.js',
    async (_prompt, options) => {
      if (options.label === 'audit:db-security') {
        return {
          executionStatus: 'VERIFIED',
          evidenceSummary: 'Read the current policy source.',
          dimension: 'db-security',
          summary: 'A finder returned one incomplete finding.',
          findings: [malformedFinding],
        }
      }
      throw new Error(`An incomplete finding must not dispatch a verifier: ${options.label}`)
    },
    { only: ['db-security'] }
  )

  assert.equal(result.overallStatus, 'BLOCKED')
  assert.equal(result.blocked.length, 0)
  assert.equal(result.unverified.length, 1, 'malformed findings must remain visible and block')
  assert.match(result.unverified[0].reason, /omitted required evidence fields/)
}

{
  const mediumFinding = {
    severity: 'MED',
    title: 'Documented lifecycle drift',
    location: 'docs/reference/example.md:12',
    evidence: 'The document names a state that the current constraint omits.',
    detail: 'The stale state name can mislead future implementation work.',
    recommendation: 'Refresh the lifecycle documentation from current evidence.',
  }
  const { result } = await executeWorkflow('./review-workflow.js', async (_prompt, options) => {
    if (options.label === 'layer:A-graph') return completeLayer([mediumFinding])
    if (options.label?.startsWith('layer:')) return completeLayer()
    throw new Error(`MED findings do not enter the BLOCKER/HIGH verifier: ${options.label}`)
  })

  assert.equal(result.overallStatus, 'VERIFIED', 'complete MED/LOW evidence is not an unavailable-source blocker')
  assert.equal(result.complete, true)
  assert.equal(result.clean, false, 'a complete run with findings must not be called clean')
  assert.equal(result.lowerSeverity.length, 1)
  assert.equal(result.unverified.length, 0, 'MED/LOW must appear in one bucket, not be duplicated')
}

console.log('PASS truthful review-state regression tests')
