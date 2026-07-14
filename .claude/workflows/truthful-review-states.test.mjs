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

  assert.equal(result.overallStatus, 'BLOCKED', 'unverified MED/LOW evidence must not produce a clean run')
  assert.equal(result.lowerSeverity.length, 1)
  assert.equal(result.unverified.length, 0, 'MED/LOW must appear in one bucket, not be duplicated')
}

console.log('PASS truthful review-state regression tests')
