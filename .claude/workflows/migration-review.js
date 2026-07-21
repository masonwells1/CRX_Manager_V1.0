export const meta = {
  name: 'migration-review',
  description:
    'Parallel multi-reviewer migration audit (RLS + drift + types) with adversarial verification of every BLOCKER. Returns a structured verdict only — does NOT touch the database or write the apply-guard proof file (the /migration-review command stamps proof + the human applies).',
  whenToUse:
    'Before any Supabase apply_migration that touches an existing table, CHECK constraint, function, or adds a new table. Produces the verdict the migration-apply-guard proof file is based on. Read-only.',
  phases: [
    { title: 'Review', detail: 'rls-security + migration-drift + types-drift reviewers, in parallel' },
    { title: 'Verify', detail: 'adversarial skeptics try to refute every BLOCKER' },
  ],
}

// ---------------------------------------------------------------------------
// args: pass the migration to review as EITHER
//   { file: 'supabase/migrations/<name>.sql' }   (preferred — Mason's convention)
//   { name: '<migration name>', sql: '<inline SQL string>' }
// The reviewer subagents read the file / SQL themselves and cross-check the live DB.
// NOTE: Date.now()/new Date() are unavailable in workflow scripts, so this script
// never stamps a timestamp — the caller writes the proof file with a real clock.
// ---------------------------------------------------------------------------

// The Workflow tool can deliver `args` as a JSON-encoded STRING rather than an
// object (observed 2026-07-18, runs wf_ae36ee12-2e4 / wf_5c9ddfc7-174). When that
// happens, args.file/args.name/args.sql are all undefined and the run fails closed
// with "No migration SQL provided". Normalize to an object first, then read fields.
let _args = args
if (typeof _args === 'string') {
  try {
    _args = JSON.parse(_args)
  } catch {
    _args = null
  }
}

const migFile = (_args && _args.file) || null
const migName = (_args && _args.name) || (migFile ? migFile.split(/[\\/]/).pop() : 'unknown')
const inlineSql = (_args && _args.sql) || null

const target = migFile
  ? `the migration file at ${migFile}`
  : `this inline migration SQL named "${migName}":\n\n${inlineSql || '(no SQL provided — ask the caller)'}`

const FINDINGS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['BLOCKER', 'HIGH', 'MED', 'LOW'] },
          title: { type: 'string' },
          location: { type: 'string', description: 'file:line, constraint name, or function signature' },
          detail: { type: 'string' },
          recommendation: { type: 'string' },
        },
        required: ['severity', 'title', 'detail', 'recommendation'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['findings', 'summary'],
}

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    isReal: {
      type: 'boolean',
      description: 'true = blocker is genuine and must be fixed; false = refuted / false positive',
    },
    reasoning: { type: 'string' },
  },
  required: ['isReal', 'reasoning'],
}

const REVIEWERS = [
  {
    type: 'rls-security-reviewer',
    focus:
      'RLS bypass risks: anon/PUBLIC-EXECUTE-able SECURITY DEFINER DML, missing `SET search_path = public, pg_temp`, new tables without RLS + at least one policy, missing idempotency on mutating RPCs, and actor-forgery (e.g. COALESCE(p_performed_by, auth.uid())) anti-patterns. This is the B7/B8/B9 (2026-05-26) class.',
  },
  {
    type: 'migration-drift-reviewer',
    focus:
      'CHECK-constraint supersets (a rewritten status list MUST include ALL existing allowed values), function-overload uniqueness (no accidental dual overload after CREATE OR REPLACE), column-name accuracy vs src/types/index.ts and the live schema, and `updated_at` writes on tables that lack the column. This is the March-2026 40-bug class.',
  },
  {
    type: 'typescript-types-drift-reviewer',
    focus:
      'If this migration adds or changes columns, confirm src/types/index.ts is (or will need to be) updated to match. Flag silent type drift where code would compile but break at runtime on a missing field.',
  },
]

phase('Review')
log(`Reviewing migration: ${migName}`)

const reviews = await parallel(
  REVIEWERS.map((r) => () =>
    agent(
      `Review ${target}.\n\n` +
        `Focus specifically on: ${r.focus}\n\n` +
        `Read the actual migration SQL and cross-check it against the live database and src/types/index.ts where relevant. ` +
        `Return every issue you can substantiate with a concrete location (file:line, constraint name, or function signature). ` +
        `Do NOT invent issues — if it is clean, return an empty findings array and say so in the summary.`,
      { agentType: r.type, schema: FINDINGS, phase: 'Review', label: `review:${r.type}` }
    )
  )
)

// Flatten + tag each finding with the reviewer that raised it.
const allFindings = reviews
  .map((rev, i) => ({ rev, reviewer: REVIEWERS[i].type }))
  .filter((x) => x.rev)
  .flatMap((x) => (x.rev.findings || []).map((f) => ({ ...f, reviewer: x.reviewer })))

const blockers = allFindings.filter((f) => f.severity === 'BLOCKER')

// No blockers at all → fast clean exit, skip the verify phase entirely.
if (blockers.length === 0) {
  return {
    migration: migName,
    verdict: 'clean',
    realBlockers: [],
    refutedBlockers: [],
    allFindings,
    reviewers: REVIEWERS.map((r) => r.type),
    note: 'No BLOCKER findings from any reviewer. Caller may stamp the proof file as "clean".',
  }
}

phase('Verify')
log(`${blockers.length} BLOCKER finding(s) — adversarially verifying each.`)

// For each blocker, run 2 independent skeptics that TRY to refute it.
// Security-conservative rule: keep the blocker unless BOTH skeptics refute it
// (confirmed if >=1 of 2 says it's real). On security/money, a false negative
// costs far more than a false positive, so we bias toward keeping.
const verified = await parallel(
  blockers.map((b) => () =>
    parallel(
      [1, 2].map((n) => () =>
        agent(
          `A migration reviewer flagged this as a BLOCKER on migration "${migName}":\n\n` +
            `Title: ${b.title}\nLocation: ${b.location || '(none given)'}\nDetail: ${b.detail}\n\n` +
            `Your job is to REFUTE it. Read ${target} and the live DB yourself. ` +
            `Is this a genuine blocker, or a false positive? If you are not certain it is real, answer isReal=false. ` +
            `Only answer isReal=true if you can independently confirm the problem is real and would actually bite in production.`,
          { schema: VERDICT, phase: 'Verify', label: `verify:${b.title.slice(0, 28)}#${n}` }
        )
      )
    ).then((votes) => {
      const v = votes.filter(Boolean)
      const confirmed = v.filter((x) => x.isReal).length >= 1 // drop only if BOTH refute
      return { ...b, confirmed, votes: v }
    })
  )
)

const realBlockers = verified.filter(Boolean).filter((b) => b.confirmed)
const refutedBlockers = verified.filter(Boolean).filter((b) => !b.confirmed)

return {
  migration: migName,
  verdict: realBlockers.length === 0 ? 'clean' : 'blocked',
  realBlockers,
  refutedBlockers,
  allFindings,
  reviewers: REVIEWERS.map((r) => r.type),
  note:
    realBlockers.length === 0
      ? 'All BLOCKER findings were refuted by adversarial verification. Caller may stamp proof as "clean", but eyeball the refutedBlockers list first.'
      : 'Real, verified BLOCKER(s) remain. DO NOT apply. Fix them, then re-run this workflow until the verdict is "clean".',
}
