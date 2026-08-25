#!/usr/bin/env node
// Shared decision logic for live migration applies.
//
// Both the Supabase MCP hook and scripts/apply-migration-file.mjs call the
// production evaluator below. Regression fixtures use the separately named
// cached-evidence evaluator; no production caller can select that mode.
// Refuses to let Claude apply a migration to live unless proof exists that the
// review subagents (rls-security-reviewer + migration-drift-reviewer) have run
// THIS SESSION on that specific migration and returned clean.
//
// Proof = a file at .claude/session-state/migration-review-<safe-name>.json
// with structure:
//   { "migration": "<filename or migration name>",
//     "timestamp": "<ISO-8601>",
//     "reviewers": ["rls-security-reviewer", "migration-drift-reviewer"],
//     "findings": "clean" | "blockers-fixed" }
//
// The file is written by Claude after subagents return clean. Without it, this
// hook blocks the apply_migration call with explicit instructions.
//
// Setup matcher: in .claude/settings.json this hook is registered against matcher
// "mcp__.*" (narrowed 2026-08-18); .codex/hooks.json still registers it under "*".
// Either way it filters in-script for tool names containing "apply_migration".

import { readFileSync, existsSync, readdirSync, statSync, mkdirSync, unlinkSync, openSync, closeSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { flagActive } from "./autopilot-lib.mjs";
import { destructiveMigrationCheck } from "./live-testdata-lib.mjs";
import { sessionProofDirs } from "./codex-push-lib.mjs";
import { checkMigrationOrdering } from "./migration-ordering-lib.mjs";
import {
  applyTimeCode,
  applyTimeWriteTargets,
  castDefinitions,
  operatorDefinitions,
  overlappingTables,
  ruleAttachmentIdentity,
  ruleAttachments,
  routineIdentityChanges,
  viewDefinitions,
} from "./apply-time-dml-lib.mjs";
import {
  appliedLedgerHas,
  migrationTimestampPrefix,
  validMigrationStem,
  validProjectRef,
  validRegistryReason,
} from "./guard-input-validation.mjs";
import { buildTriggerFanoutManifest } from "../../scripts/generate-trigger-fanout.mjs";
import { buildAppliedSnapshot } from "../../scripts/refresh-applied-migrations.mjs";
import {
  LINKED_READ_QUERY_IDS,
  runLinkedRead,
} from "../../scripts/supabase-linked-read.mjs";

export const REQUIRED_CODEX_MODEL = "gpt-5.6-sol";
export const REQUIRED_CODEX_EFFORT = "high";
export const PROOF_MAX_AGE_MS = 30 * 60 * 1000;
export const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CRX_PRODUCTION_REF = "rhyzpcqhnizqbxphqdkr";
const TRIGGER_FANOUT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TRIGGER_FANOUT_FUTURE_SKEW_MS = 5 * 60 * 1000;
const TRIGGER_FANOUT_ATTESTATION_FORMAT = 1;
const TRIGGER_FANOUT_PRODUCER_SOURCES = Object.freeze([
  "scripts/generate-trigger-fanout.mjs",
  "scripts/supabase-linked-read.mjs",
  ".claude/hooks/apply-time-dml-lib.mjs",
]);

function migrationSourcePath(root, stem) {
  if (!validMigrationStem(stem)) throw new Error("invalid migration stem");
  const migrationsDir = path.resolve(root, "supabase", "migrations");
  const filePath = path.resolve(migrationsDir, `${stem}.sql`);
  if (path.dirname(filePath) !== migrationsDir) throw new Error("migration path escaped its directory");
  return filePath;
}

const allow = () => ({ decision: "allow" });
const block = (reason) => ({ decision: "block", reason });

function targetTable(target) {
  const parts = String(target || "").replaceAll('"', "").toLowerCase().split(".");
  if (parts[0] === "public") return parts[1] || "";
  // Public relations stay bare for compatibility with the schema registry.
  // A non-public relation must retain its schema, though: auth.users is a
  // captured fan-out source because deleting it cascades into public.profiles.
  return parts.length >= 3 ? `${parts[0]}.${parts[1]}` : (parts[0] || "");
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function gitBlobFor(filePath, root) {
  try {
    const blob = execFileSync("git", ["hash-object", filePath], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!/^[0-9a-f]{40,64}$/.test(blob)) throw new Error("invalid blob identity");
    return blob;
  } catch {
    throw new Error("producer source blob identity could not be verified");
  }
}

function loadAttestedFanout(root) {
  const manifestPath = path.join(root, "scripts", "trigger-fanout.json");
  const attestationPath = path.join(
    root, ".claude", "session-state", "trigger-fanout-attestation.json",
  );
  if (!existsSync(attestationPath)) {
    throw new Error("manifest has no wrapper-minted attestation");
  }

  let manifestBytes;
  let parsed;
  let attestation;
  try {
    manifestBytes = readFileSync(manifestPath);
    parsed = JSON.parse(manifestBytes.toString("utf8"));
    attestation = JSON.parse(readFileSync(attestationPath, "utf8"));
  } catch {
    throw new Error("manifest or attestation is unreadable or invalid JSON");
  }

  if (!exactKeys(attestation, [
    "format_version", "kind", "manifest", "source_project", "captured_at", "producer",
  ]) ||
      attestation.format_version !== TRIGGER_FANOUT_ATTESTATION_FORMAT ||
      attestation.kind !== "crx-trigger-fanout-attestation" ||
      !exactKeys(attestation.manifest, ["path", "sha256"]) ||
      attestation.manifest.path !== "scripts/trigger-fanout.json" ||
      !/^[0-9a-f]{64}$/.test(attestation.manifest.sha256) ||
      !exactKeys(attestation.producer, ["wrapper", "sources"]) ||
      attestation.producer.wrapper !== "scripts/generate-trigger-fanout.mjs" ||
      !Array.isArray(attestation.producer.sources) ||
      attestation.producer.sources.length !== TRIGGER_FANOUT_PRODUCER_SOURCES.length) {
    throw new Error("attestation failed strict shape validation");
  }
  if (attestation.manifest.sha256 !== sha256(manifestBytes)) {
    throw new Error("manifest bytes do not match the wrapper attestation");
  }
  if (attestation.source_project !== CRX_PRODUCTION_REF ||
      attestation.source_project !== parsed?._meta?.source_project ||
      typeof attestation.captured_at !== "string" ||
      attestation.captured_at !== parsed?._meta?.captured_at) {
    throw new Error("attestation project or capture time does not match the manifest");
  }

  for (let index = 0; index < TRIGGER_FANOUT_PRODUCER_SOURCES.length; index += 1) {
    const expectedPath = TRIGGER_FANOUT_PRODUCER_SOURCES[index];
    const source = attestation.producer.sources[index];
    if (!exactKeys(source, ["path", "git_blob", "sha256"]) ||
        source.path !== expectedPath ||
        !/^[0-9a-f]{40,64}$/.test(source.git_blob) ||
        !/^[0-9a-f]{64}$/.test(source.sha256)) {
      throw new Error("attestation producer source list is invalid");
    }
    const sourcePath = path.join(root, ...expectedPath.split("/"));
    let bytes;
    try {
      bytes = readFileSync(sourcePath);
    } catch {
      throw new Error("an attested producer source is missing or unreadable");
    }
    if (sha256(bytes) !== source.sha256 || gitBlobFor(sourcePath, root) !== source.git_blob) {
      throw new Error("an attested producer source is dirty or does not match its reviewed blob");
    }
  }
  return { manifestPath, parsed };
}

function captureLiveAppliedSnapshot(projectRoot) {
  const capture = runLinkedRead({
    projectRoot,
    queryId: LINKED_READ_QUERY_IDS.APPLIED_MIGRATIONS,
  });
  if (capture.rows.length !== 1) {
    throw new Error("linked migration-ledger query did not return exactly one row");
  }
  const row = capture.rows[0];
  if (!exactKeys(row, ["migration_ledger"])) {
    throw new Error("linked migration-ledger query returned an unexpected row shape");
  }
  return buildAppliedSnapshot(row.migration_ledger, capture.projectId);
}

function captureLiveFanoutManifest(projectRoot) {
  const capture = runLinkedRead({
    projectRoot,
    queryId: LINKED_READ_QUERY_IDS.TRIGGER_FANOUT,
  });
  if (capture.rows.length !== 1) {
    throw new Error("linked trigger-fanout query did not return exactly one row");
  }
  const row = capture.rows[0];
  if (!exactKeys(row, ["trigger_fanout_capture"])) {
    throw new Error("linked trigger-fanout query returned an unexpected row shape");
  }
  return buildTriggerFanoutManifest(row.trigger_fanout_capture, capture.projectId);
}

function loadTrustedFanout(evidenceRoots, inMemoryManifest = null) {
  const scanned = new Set();
  const opaque = new Set();
  const fanout = new Map();
  const enabledEventTriggers = new Map();
  const sessionDependentEventTriggers = new Map();
  const allEnabledEventTriggers = new Map();
  const persistedRules = new Map();
  const persistedCheckConstraints = new Map();
  const manifests = [];
  const expiredManifests = [];
  const rejectedManifests = [];
  const sources = [];
  if (inMemoryManifest) {
    sources.push({
      manifestPath: "linked production query (in memory)",
      parsed: inMemoryManifest,
    });
  } else {
    for (const root of evidenceRoots) {
      const manifestPath = path.join(root, "scripts", "trigger-fanout.json");
      if (!existsSync(manifestPath)) continue;
      try {
        const { parsed } = loadAttestedFanout(root);
        sources.push({ manifestPath, parsed });
      } catch (err) {
        rejectedManifests.push(`${manifestPath}: ${err?.message || err}`);
      }
    }
  }
  for (const { manifestPath, parsed } of sources) {
    if (parsed?._meta?.format_version !== 6 ||
        parsed?._meta?.source_project !== CRX_PRODUCTION_REF ||
        typeof parsed?._meta?.captured_at !== "string" ||
        !Array.isArray(parsed?.tables_scanned) || !Array.isArray(parsed?.opaque_on_tables) ||
        !Array.isArray(parsed?.event_triggers) || !Array.isArray(parsed?.rules) ||
        !Array.isArray(parsed?.check_constraints) ||
        !parsed?.fanout || typeof parsed.fanout !== "object" || Array.isArray(parsed.fanout)) {
      throw new Error(`${manifestPath}: invalid or unbound trigger fan-out manifest`);
    }
    const capturedAt = Date.parse(parsed._meta.captured_at);
    const captureAge = Date.now() - capturedAt;
    if (!Number.isFinite(capturedAt) || captureAge < -TRIGGER_FANOUT_FUTURE_SKEW_MS ||
        captureAge > TRIGGER_FANOUT_MAX_AGE_MS) {
      expiredManifests.push(manifestPath);
      continue;
    }
    for (const trigger of parsed.event_triggers) {
      const keys = Object.keys(trigger || {}).sort();
      if (JSON.stringify(keys) !== JSON.stringify([
        "effect", "enabled", "enabled_mode", "event", "has_sql_body", "language", "name",
        "routine_config", "routine_hash", "routine_name", "routine_oid", "routine_schema",
      ]) ||
          typeof trigger.enabled !== "boolean" ||
          typeof trigger.enabled_mode !== "string" || !/^[ODRA]$/.test(trigger.enabled_mode) ||
          trigger.enabled !== (trigger.enabled_mode !== "D") ||
          typeof trigger.name !== "string" || !/^[a-z0-9_]+$/.test(trigger.name) ||
          typeof trigger.event !== "string" || !/^[a-z0-9_]+$/.test(trigger.event) ||
          typeof trigger.routine_oid !== "string" || !/^\d+$/.test(trigger.routine_oid) ||
          typeof trigger.routine_schema !== "string" || !/^[a-z0-9_]+$/.test(trigger.routine_schema) ||
          typeof trigger.routine_name !== "string" || !/^[a-z0-9_]+$/.test(trigger.routine_name) ||
          typeof trigger.language !== "string" || !/^[a-z0-9_]+$/.test(trigger.language) ||
          !Array.isArray(trigger.routine_config) ||
          trigger.routine_config.some((entry) => typeof entry !== "string" || /[\r\n\0]/.test(entry)) ||
          typeof trigger.has_sql_body !== "boolean" ||
          !trigger.effect || typeof trigger.effect !== "object" || Array.isArray(trigger.effect) ||
          JSON.stringify(Object.keys(trigger.effect).sort()) !== JSON.stringify([
            "dynamic_write_count", "safe", "session_catalog_required", "tables", "targets",
            "unknown_calls", "unresolved", "unsupported_routine_identity",
          ]) ||
          typeof trigger.effect.safe !== "boolean" ||
          typeof trigger.effect.session_catalog_required !== "boolean" ||
          typeof trigger.effect.unresolved !== "boolean" ||
          typeof trigger.effect.unsupported_routine_identity !== "boolean" ||
          !Number.isInteger(trigger.effect.dynamic_write_count) || trigger.effect.dynamic_write_count < 0 ||
          !Array.isArray(trigger.effect.unknown_calls) || !Array.isArray(trigger.effect.targets) ||
          !Array.isArray(trigger.effect.tables) ||
          trigger.effect.safe !== (!trigger.effect.session_catalog_required &&
            !trigger.effect.unresolved &&
            !trigger.effect.unsupported_routine_identity && trigger.effect.dynamic_write_count === 0 &&
            trigger.effect.unknown_calls.length === 0 && trigger.effect.targets.length === 0 &&
            trigger.effect.tables.length === 0) ||
          typeof trigger.routine_hash !== "string" || !/^[0-9a-f]{64}$/.test(trigger.routine_hash)) {
        throw new Error(`${manifestPath}: invalid event-trigger evidence`);
      }
      if (trigger.enabled) {
        const identityKey = `${trigger.routine_schema}\0${trigger.routine_name}\0${trigger.routine_oid}\0${trigger.routine_hash}`;
        allEnabledEventTriggers.set(identityKey, trigger);
      }
      if (trigger.enabled && !trigger.effect.safe) {
        const key = `${trigger.name}\0${trigger.routine_oid}\0${trigger.routine_hash}`;
        const hasNoWriteProof = !trigger.effect.unresolved &&
          !trigger.effect.unsupported_routine_identity &&
          trigger.effect.dynamic_write_count === 0 && trigger.effect.unknown_calls.length === 0 &&
          trigger.effect.targets.length === 0 && trigger.effect.tables.length === 0;
        if (trigger.effect.session_catalog_required && hasNoWriteProof) {
          sessionDependentEventTriggers.set(key, trigger);
        } else {
          enabledEventTriggers.set(key, trigger);
        }
      }
    }
    for (const rule of parsed.rules) {
      const keys = Object.keys(rule || {}).sort();
      if (JSON.stringify(keys) !== JSON.stringify([
        "definition_hash", "event", "name", "oid", "relation",
      ]) ||
          typeof rule.oid !== "string" || !/^\d+$/.test(rule.oid) ||
          typeof rule.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(rule.name) ||
          typeof rule.relation !== "string" ||
            !/^[a-z_][a-z0-9_$]*(?:\.[a-z_][a-z0-9_$]*)?$/.test(rule.relation) ||
          typeof rule.event !== "string" ||
            !new Set(["select", "insert", "update", "delete"]).has(rule.event) ||
          typeof rule.definition_hash !== "string" ||
            !/^[0-9a-f]{64}$/.test(rule.definition_hash)) {
        throw new Error(`${manifestPath}: invalid rewrite-rule evidence`);
      }
      persistedRules.set(
        `${rule.event}\0${rule.relation}\0${rule.name}\0${rule.oid}\0${rule.definition_hash}`,
        {
          name: rule.name,
          schema: rule.relation.includes(".") ? rule.relation.split(".")[0] : "public",
          relation: rule.relation.split(".").pop(),
          table: rule.relation,
          event: rule.event,
        },
      );
    }
    const manifestTables = new Set(parsed.tables_scanned.map((table) => String(table).toLowerCase()));
    for (const constraint of parsed.check_constraints) {
      const keys = Object.keys(constraint || {}).sort();
      if (JSON.stringify(keys) !== JSON.stringify([
        "definition_hash", "name", "oid", "relation", "routine_name", "routine_oid",
        "routine_schema",
      ]) ||
          typeof constraint.oid !== "string" || !/^\d+$/.test(constraint.oid) ||
          typeof constraint.routine_oid !== "string" || !/^\d+$/.test(constraint.routine_oid) ||
          typeof constraint.name !== "string" ||
            !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(constraint.name) ||
          typeof constraint.relation !== "string" ||
            !/^[a-z_][a-z0-9_$]*$/.test(constraint.relation) ||
          typeof constraint.routine_schema !== "string" ||
            !/^[a-z_][a-z0-9_$]*$/.test(constraint.routine_schema) ||
          typeof constraint.routine_name !== "string" ||
            !/^[a-z_][a-z0-9_$]*$/.test(constraint.routine_name) ||
          !manifestTables.has(constraint.relation) ||
          typeof constraint.definition_hash !== "string" ||
            !/^[0-9a-f]{64}$/.test(constraint.definition_hash)) {
        throw new Error(`${manifestPath}: invalid persisted CHECK-routine evidence`);
      }
      const key = `${constraint.relation}\0${constraint.oid}\0${constraint.routine_schema}` +
        `\0${constraint.routine_name}\0${constraint.routine_oid}\0${constraint.definition_hash}`;
      persistedCheckConstraints.set(key, constraint);
      // A table CHECK executes on later INSERT/UPDATE. Its custom routine body
      // is database-resident, so treat writes to this relation as opaque even
      // if the broad bootstrap opacity policy is narrowed in a future format.
      opaque.add(constraint.relation);
    }
    for (const table of parsed.tables_scanned) {
      if (typeof table !== "string" || !table.trim()) throw new Error(`${manifestPath}: invalid scanned table`);
      scanned.add(table.toLowerCase());
    }
    for (const table of parsed.opaque_on_tables) {
      if (typeof table !== "string" || !table.trim()) throw new Error(`${manifestPath}: invalid opaque table`);
      opaque.add(table.toLowerCase());
    }
    for (const [sourceRaw, edges] of Object.entries(parsed.fanout)) {
      const source = sourceRaw.toLowerCase();
      // A schema-qualified parent such as auth.users is not part of the public
      // tables_scanned universe, but a live FK edge makes it a verified source
      // in its own right.
      scanned.add(source);
      if (!Array.isArray(edges)) throw new Error(`${manifestPath}: invalid fan-out edge list for ${source}`);
      const union = fanout.get(source) || new Map();
      for (const edge of edges) {
        const target = String(edge?.target || "").trim().toLowerCase();
        const via = String(edge?.via || "").trim();
        if (!target || !via) throw new Error(`${manifestPath}: invalid fan-out edge for ${source}`);
        union.set(`${target}\0${via}`, { target, via });
      }
      fanout.set(source, union);
    }
    manifests.push(manifestPath);
  }
  if (expiredManifests.length) {
    throw new Error(
      `trigger-fanout.json evidence includes a manifest not captured within the last 24 hours ` +
      `(expired or future-dated) ` +
      `(${expiredManifests.join(", ")}); run node scripts/generate-trigger-fanout.mjs ` +
      `in every evidence checkout and retry`,
    );
  }
  if (rejectedManifests.length) {
    throw new Error(
      `trigger-fanout.json evidence includes a rejected wrapper attestation ` +
      `(${rejectedManifests.join(", ")}); run node scripts/generate-trigger-fanout.mjs ` +
      `in every evidence checkout and retry`,
    );
  }
  if (manifests.length === 0) {
    throw new Error("no trigger-fanout.json in any verified checkout");
  }
  return {
    scanned,
    opaque,
    fanout: new Map([...fanout].map(([source, edges]) => [source, [...edges.values()]])),
    enabledEventTriggers: [...enabledEventTriggers.values()],
    sessionDependentEventTriggers: [...sessionDependentEventTriggers.values()],
    allEnabledEventTriggers: [...allEnabledEventTriggers.values()],
    rules: [...persistedRules.values()],
    checkConstraints: [...persistedCheckConstraints.values()],
    manifests,
  };
}

function expandThroughFanout(analysis, evidence) {
  const targets = new Set(analysis.targets || []);
  const tables = new Set([...targets].map(targetTable).filter(Boolean));
  const queue = [...tables];
  const visited = new Set();
  const opaqueSources = new Set();
  while (queue.length) {
    const source = queue.shift();
    if (!source || visited.has(source)) continue;
    visited.add(source);
    if (!evidence.scanned.has(source) || evidence.opaque.has(source)) opaqueSources.add(source);
    for (const edge of evidence.fanout.get(source) || []) {
      targets.add(`${edge.target}.*`);
      if (!tables.has(edge.target)) {
        tables.add(edge.target);
        queue.push(edge.target);
      }
    }
  }
  return { targets, tables, opaqueSources };
}

function loadKnownDefinitions(evidenceRoots, currentMigration = "") {
  const operatorsByKey = new Map();
  const castsByKey = new Map();
  const viewsByKey = new Map();
  const rulesByKey = new Map();
  for (const root of evidenceRoots) {
    const migrationDir = path.join(root, "supabase", "migrations");
    if (!existsSync(migrationDir)) continue;
    let names;
    try {
      names = readdirSync(migrationDir).filter((name) => name.endsWith(".sql"));
    } catch (err) {
      throw new Error(`${migrationDir}: ${err?.message || err}`);
    }
    for (const name of names) {
      const filePath = path.join(migrationDir, name);
      let sql;
      try {
        sql = readFileSync(filePath, "utf8");
      } catch (err) {
        throw new Error(`${filePath}: ${err?.message || err}`);
      }
      const hasOperators = /\bcreate\s+operator\b/i.test(sql);
      const hasCasts = /\bcreate\s+(?:cast|domain)\b/i.test(sql);
      const hasViews = /\bcreate\s+(?:or\s+replace\s+)?(?:(?:temp|temporary|recursive)\s+)*view\b/i.test(sql);
      const hasRules = /\bcreate\s+(?:or\s+replace\s+)?rule\b/i.test(sql);
      if (!hasOperators && !hasCasts && !hasViews && !hasRules) continue;

      // The lexer is the expensive part. Each migration is read and reduced to
      // apply-time code once, then every catalog extractor consumes that same
      // trusted result.
      const code = applyTimeCode(sql).code;
      if (hasOperators) {
        for (const definition of operatorDefinitions(code)) {
          operatorsByKey.set(`${definition.operator}\0${definition.fn}`, definition);
        }
      }
      if (hasCasts) {
        for (const definition of castDefinitions(code)) {
          castsByKey.set(
            `${definition.source}\0${definition.target}\0${definition.fn}\0${definition.context}`,
            definition,
          );
        }
      }
      if (hasViews) {
        for (const definition of viewDefinitions(code)) {
          viewsByKey.set(`${definition.name}\0${definition.query}`, definition);
        }
      }
      // A rule stored by an EARLIER migration remains executable catalog state
      // when the candidate applies. Do not seed later filenames: PostgreSQL has
      // not installed those yet, and treating future rules as live would create
      // a false availability failure.
      if (hasRules && (!currentMigration || name < `${currentMigration}.sql`)) {
        for (const definition of ruleAttachments(code)) {
          rulesByKey.set(ruleAttachmentIdentity(definition), definition);
        }
      }
    }
  }
  return {
    operators: [...operatorsByKey.values()],
    casts: [...castsByKey.values()],
    views: [...viewsByKey.values()],
    rules: [...rulesByKey.values()],
  };
}

function evaluateMigrationApplyMode({
  name,
  query,
  projectId,
  projectDir,
  cwd,
  now = Date.now(),
  gitWorktreeList,
  useCachedTestEvidence = false,
} = {}) {
if (!projectDir) throw new Error("projectDir is required");
const input = { name, query, project_id: projectId, cwd };
const stateDir = path.join(projectDir, ".claude", "session-state");

// Make sure the directory exists so future writes work.
try { mkdirSync(stateDir, { recursive: true }); } catch { /* ignore */ }

// The session-state directories this apply may draw evidence from: THIS
// session's own checkout, plus the primary one. Nothing else.
//
// Why (2026-07-29): the harness pins CLAUDE_PROJECT_DIR to the PRIMARY checkout
// even when the session's cwd is a linked worktree, while
// scripts/write-apply-proofs.mjs writes its output under `process.cwd()` — the
// worktree that actually holds the migration file. A migration built in a
// worktree therefore minted perfectly valid proofs somewhere this guard never
// looked, and the apply was denied no matter how many clean reviews ran. Same
// root cause pr-merge-guard hit in PR #252/#255.
//
// The merge guard's answer — scan every sibling checkout — is NOT safe here, and
// Codex blocked the first version of this fix for taking it. Its proof is bound
// to the exact head and base SHAs GitHub reports, so a sibling's proof can only
// authorize the identical merge. This proof is weaker: interactively `queryHash`
// is enforced only when the proof carries one, and migration names match by
// substring. Scanning all worktrees would therefore let a proof minted by a
// DIFFERENT concurrent session authorize a live apply this session never
// reviewed — against the settled "proof from THIS session" rule
// (docs/manual/DECISION_LOG.md, 2026-07-13) and squarely in Mason's way of
// working, where dozens of worktrees run at once.
//
// So the lookup follows the session's actual working directory, honoured only
// after `git worktree list` confirms it is a checkout of this repository. An
// unrecognised cwd falls back to the primary directory alone — the old
// behaviour, which fails closed.
//
// The AUTOPILOT.on flag above is deliberately narrower still: it stays pinned to
// the primary checkout. It is authorization state for this project, not evidence
// about a migration; reading it from any other checkout would let a flag Mason
// never armed here change the rule-set.
const hookCwd = cwd || process.cwd();
const listWorktrees = gitWorktreeList || (() => execFileSync(
  "git",
  ["worktree", "list", "--porcelain"],
  { cwd: projectDir, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] },
));
const proofDirs = sessionProofDirs(projectDir, hookCwd, listWorktrees);

// Extract the migration identifier from the MCP call. Supabase MCP apply_migration
// shape is { project_id, name, query }. We use `name` if present, otherwise fall
// back to the first matching migration file from the SQL query content.
const migName = (input.name || "").toString().trim();
const migQuery = (input.query || "").toString();
const currentHash = migQuery ? createHash("sha256").update(migQuery).digest("hex") : "";
const safeName = migName.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "unknown";

// ORDERING PREFLIGHT (2026-08-08). Refuse a migration that is OLDER than one
// already applied — the mechanism that silently reverted the
// batch_apply_prepayments actor guard on 2026-07-15 with nothing detecting it.
//
// The comparison set is the APPLIED ledger, never the files on disk: a file on
// disk is not proof it ran, and comparing against disk would block a correct
// ascending batch of new migrations. The production entry runs the fixed
// linked ledger query itself and consumes the result in memory. Locally written
// snapshots exist only behind the separately named regression-test entry.
//
// MISSING EVIDENCE IS A BLOCK, NOT A PASS. A failed, malformed, stale, or
// project-mismatched linked read therefore refuses the apply. Only the
// library's internal "this name has no timestamp" case abstains.
{
  const snapPaths = useCachedTestEvidence
    ? [...new Set(proofDirs.map((dir) => path.join(dir, "applied-migrations.json")))]
    : ["linked production query (in memory)"];
  let snapPath = snapPaths[0];
  // The recapture target must be the project THIS apply is aimed at. Reading it
  // from the environment printed a literal `<your project ref>` in every normal
  // hook run — neither manifest exports SUPABASE_PROJECT_REF — and a stray env
  // value could have pointed the operator at a different project's ledger, which
  // the snapshot format cannot detect. The apply call itself is authoritative.
  // (Codex P2, PR #354.)
  const targetRefRaw =
    (input.project_id || "").toString().trim() ||
    (process.env.SUPABASE_PROJECT_REF || "").toString().trim() ||
    CRX_PRODUCTION_REF;
  if (!validProjectRef(targetRefRaw)) {
    return block(
      `MIGRATION ORDER GUARD: the target project identifier is invalid. Project refs may contain ` +
      `only lowercase ASCII letters, digits, underscores, and hyphens. Refusing the apply without ` +
      `reflecting the supplied value.`);
  }
  const targetRef = targetRefRaw;
  const howTo = useCachedTestEvidence
    ? `Refresh it first (read-only):\n` +
      `  node scripts/refresh-applied-migrations.mjs\n` +
      `That fixture-only command path is retained for deterministic regression tests.`
    : `The guard performs its own fixed read-only linked query against project ` +
      `${CRX_PRODUCTION_REF} for every apply attempt. Verify Supabase CLI authentication and the ` +
      `repository link, then retry; local snapshot files are not accepted as production evidence.`;

  let appliedNames = [];
  let snapshotAgeMs = null;
  try {
    const candidates = [];
    const readErrors = [];
    if (useCachedTestEvidence) {
      for (const candidatePath of snapPaths) {
        if (!existsSync(candidatePath)) continue;
        try {
          const parsed = JSON.parse(readFileSync(candidatePath, "utf8"));
          candidates.push({
            snapPath: candidatePath,
            parsed,
            capturedAt: Date.parse(parsed?.captured_at ?? ""),
          });
        } catch (err) {
          readErrors.push(`${candidatePath}: ${err?.message || err}`);
        }
      }
    } else {
      try {
        const parsed = captureLiveAppliedSnapshot(projectDir);
        candidates.push({
          snapPath: snapPaths[0],
          parsed,
          capturedAt: Date.parse(parsed?.captured_at ?? ""),
        });
      } catch (err) {
        readErrors.push(`fixed linked read: ${err?.message || err}`);
      }
    }
    if (candidates.length === 0) {
      return block(
        `MIGRATION ORDERING GUARD: no trustworthy live applied-migration evidence was available ` +
        `(source: ${snapPaths.join(", ")}), so there is no ` +
        `evidence of what the database has already run and an out-of-order replay could not be ` +
        `detected. Refusing the apply.` +
        (readErrors.length ? ` Read error(s): ${readErrors.join("; ")}.` : "") +
        `\n\n${howTo}`);
    }
    // Prefer the newest database capture when both the active worktree and the
    // primary checkout still hold evidence. The invalidator removes both after
    // every apply; this ordering handles pre-fix leftovers without choosing a
    // known-older ledger. Equal-time snapshots must agree byte-for-byte in
    // meaning or the evidence is ambiguous and the apply is refused.
    candidates.sort((a, b) =>
      (Number.isFinite(b.capturedAt) ? b.capturedAt : -Infinity) -
      (Number.isFinite(a.capturedAt) ? a.capturedAt : -Infinity));
    const freshest = candidates[0];
    const tied = candidates.filter((candidate) => candidate.capturedAt === freshest.capturedAt);
    if (tied.some((candidate) => JSON.stringify(candidate.parsed) !== JSON.stringify(freshest.parsed))) {
      return block(
        `MIGRATION ORDERING GUARD: multiple verified checkout snapshots claim the same capture time ` +
        `but contain different ledgers (${tied.map((candidate) => candidate.snapPath).join(", ")}). ` +
        `Refusing ambiguous ordering evidence.\n\n${howTo}`);
    }
    snapPath = freshest.snapPath;
    const parsed = freshest.parsed;

    // The snapshot must name the database it was read from, and that database
    // must be the one this apply is aimed at. Time, count and names alone are
    // portable: production's ledger carried to a restored copy or a staging
    // branch reads as that database's own history, and `ledgerHas()` below then
    // reports a one-shot money migration as already applied against a database
    // that has never run it — switching the replay guard off exactly where it
    // is needed (Codex High, PR #364 round 10). A bare-array snapshot cannot
    // carry the field at all, so it is no longer accepted.
    const snapProject = (Array.isArray(parsed) ? "" : (parsed?.project_id ?? ""))
      .toString().trim().toLowerCase();
    if (!snapProject) {
      return block(
        `MIGRATION ORDERING GUARD: the applied-migration snapshot at ${snapPath} does not record ` +
        `which database it was captured from, so it cannot be shown to describe ${targetRef}. An ` +
        `unbound ledger is replayable against any database, which would disable the one-shot ` +
        `replay check. Refusing the apply.\n\n${howTo}`);
    }
    if (snapProject !== targetRef.toLowerCase()) {
      return block(
        `MIGRATION ORDERING GUARD: the applied-migration snapshot was captured from project ` +
        `"${snapProject}" but this apply targets "${targetRef}". A ledger is evidence about one ` +
        `database only — reading another database's applied list here would both mis-order this ` +
        `migration and mark one-shot data repairs as already run. Refusing the apply.\n\n${howTo}`);
    }

    const rows = Array.isArray(parsed) ? parsed : parsed?.applied;
    if (!Array.isArray(rows) || rows.length === 0) {
      return block(
        `MIGRATION ORDERING GUARD: the applied-migration snapshot at ${snapPath} contains no rows. ` +
        `An empty snapshot is indistinguishable from "nothing has ever been applied" and would ` +
        `silently disable this check. Refusing the apply.\n\n${howTo}`);
    }
    // Same mapping rule as scripts/refresh-applied-migrations.mjs. Preferring
    // `name` alone drops the timestamp for the many ledger rows whose name has
    // none (e.g. version 20260727174805 / name deactivation_revokes_auth_access),
    // and a row that cannot be timestamped cannot constrain ordering.
    appliedNames = rows
      .map((r) => {
        if (typeof r === "string") return r;
        const name = (r?.name ?? "").toString().trim();
        const version = (r?.version ?? "").toString().trim();
        if (name && /\d{14}/.test(name)) return name;
        if (version && name) return `${version}_${name}`;
        return version || name || "";
      })
      .filter(Boolean);

    // A snapshot can be present, fresh and non-empty yet contain not one
    // parseable timestamp — in which case the ordering check has nothing to
    // compare against and abstains, and the apply would sail through a gate
    // that looks satisfied. Refuse instead: this is the silent gap the whole
    // mechanism exists to close (CodeRabbit, PR #348).
    if (!appliedNames.some((n) => /\d{14}/.test(n))) {
      return block(
        `MIGRATION ORDERING GUARD: the applied-migration snapshot at ${snapPath} has ` +
        `${appliedNames.length} row(s) but not one carries a 14-digit migration timestamp, so no ` +
        `ordering comparison is possible. A snapshot that cannot answer the question must not be ` +
        `treated as answering it. Refusing the apply.\n\n${howTo}`);
    }

    const capturedAt = Date.parse(parsed?.captured_at ?? "");
    if (Number.isFinite(capturedAt)) {
      snapshotAgeMs = Date.now() - capturedAt;
      if (snapshotAgeMs > SNAPSHOT_MAX_AGE_MS) {
        return block(
          `MIGRATION ORDERING GUARD: the applied-migration snapshot is ` +
          `${Math.floor(snapshotAgeMs / 3600000)}h old (captured ${parsed.captured_at}). Migrations ` +
          `applied since then are invisible to this check, so it could pass a replay that is ` +
          `actually behind the live high-water mark. Refusing the apply.\n\n${howTo}`);
      }
    } else {
      return block(
        `MIGRATION ORDERING GUARD: the applied-migration snapshot has no usable captured_at ` +
        `timestamp, so its freshness cannot be established. Refusing the apply.\n\n${howTo}`);
    }
  } catch (err) {
    // out() exits the process, so a genuine block above never lands here.
    return block(
      `MIGRATION ORDERING GUARD: could not read the applied-migration snapshot at ${snapPath} ` +
      `(${err?.message || err}). Refusing the apply rather than proceeding without ordering ` +
      `evidence.\n\n${howTo}`);
  }

  try {
    const ordering = checkMigrationOrdering({ name: migName, sql: migQuery, appliedNames });
    if (!ordering.ok) return block( ordering.reason);
    // Belt-and-braces: an abstention is "no verdict", and `ok: true` there means
    // "unknown", not "fine".
    //
    // This used to fire only when `migName` carried a 14-digit timestamp, which
    // was exactly backwards: `apply_migration`'s name is CALLER-CONTROLLED, and
    // an untimestamped name is the one abstention cause the snapshot checks
    // above cannot catch (they constrain the ledger, not the candidate). So
    // stripping the timestamp off an out-of-order migration bought an
    // unconditional pass through this guard — the same replay class that
    // removed the prepayment actor guard. Verified by probe: identical SQL,
    // "20260101000000_old_mig" denied, "old_mig" allowed. (Codex High, PR #354.)
    //
    // Every repository migration is timestamped, so refusing an untimestamped
    // candidate costs nothing real and closes the hole. Deny on ANY abstention.
    if (ordering.abstained) {
      const untimestamped = !/\d{14}/.test(migName || "");
      return block(
        `MIGRATION ORDERING GUARD: the ordering check reached no verdict for "${safeName}", so ` +
        `whether this is an out-of-order replay is UNKNOWN` +
        (untimestamped
          ? `, because the migration name carries no 14-digit timestamp to compare against the ` +
            `applied-migration snapshot. Every repository migration is timestamped, and this name ` +
            `is caller-supplied, so an untimestamped name must not skip the ordering comparison. ` +
            `Re-issue the migration under its real timestamped name.`
          : `.`) +
        ` An unknown verdict is not a pass. Refusing the apply.\n\n${howTo}`);
    }
  } catch (err) {
    // A crash in the ordering check must not silently wave a migration through.
    return block(
      `MIGRATION ORDERING GUARD failed to evaluate "${safeName}": ${err?.message || err}. ` +
      `Refusing the apply rather than skipping the check. Fix the guard, or state an explicit ` +
      `intentional replay in the migration SQL if that is genuinely what this is.`);
  }

  // ONE-SHOT REPLAY GUARD (2026-08-10, Codex High round 8).
  //
  // supabase/baselines/one-shot-migrations.json registers data migrations whose
  // authorization was bound to the live population at the moment they were
  // written — counts, not row identity. Replaying one onto a database whose
  // ledger does not already contain it rewrites rows nobody approved.
  //
  // Registering them only taught scripts/list-post-baseline-migrations.mjs to
  // withhold them from the replay plan. That is one path. This is the other:
  // the SQL file is still sitting on disk, and an ordinary apply against a
  // restored or drifted database still sees it, so the containment was
  // advisory. It is now enforced at the apply itself.
  //
  // EVERY apply is the trigger — ledger presence buys nothing (Codex High,
  // round 12). Round 8 skipped any entry the ledger already contained, on the
  // reasoning that such a database is "by definition the population the
  // migration was approved against". That reasoning holds only at the instant
  // of the first apply. A population drifts: orders get edited, returned,
  // re-invoiced. Re-running a count-bound money repair days later rewrites
  // whatever is there NOW, and the ordering guard above deliberately excludes a
  // migration's own timestamp from its comparison (migration-ordering-lib.mjs
  // — "a re-apply of the very same migration is idempotency, not ordering"), so
  // the duplicate was not caught there either. Both gates waved it through.
  //
  // So a registered one-shot needs the fresh, project-bound, single-use
  // override on its FIRST apply and on every one after it.
  {
    // Read the registry — and later the migration body — from EVERY verified
    // checkout, not just the primary one (Codex High, round 12).
    //
    // `CLAUDE_PROJECT_DIR` pins to the PRIMARY checkout even when the session is
    // working inside a linked worktree. Rounds 8-11 read both the registry and
    // `supabase/migrations/<stem>.sql` from that primary path, so a one-shot
    // registered on a feature branch — the exact moment a fresh money repair is
    // most dangerous and least reviewed — was invisible to this guard until the
    // branch merged. The apply-time containment arrived only after it was no
    // longer needed.
    //
    // `proofDirs` already resolves the two checkouts this guard is allowed to
    // trust: the primary, plus this session's own cwd once `git worktree list`
    // confirms it belongs to this repository. Their checkout roots are those
    // paths minus the trailing `.claude/session-state`. Entries are UNIONED, so
    // a stem registered in either checkout counts — union is never laxer than
    // reading one path alone.
    const evidenceRoots = [...new Set(proofDirs.map((d) => path.resolve(d, "..", "..")))];
    const oneShot = Object.create(null);
    const registriesRead = [];
    for (const root of evidenceRoots) {
      const registryPath = path.join(root, "supabase", "baselines", "one-shot-migrations.json");
      if (!existsSync(registryPath)) continue;
      try {
        const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
        const map = parsed?.one_shot;
        if (!map || typeof map !== "object" || Array.isArray(map)) {
          throw new Error("no plain `one_shot` map");
        }
        // Registry keys become migration filenames, so they must be exact
        // repository stems rather than caller-controlled path fragments. The
        // prose value is validated as inert single-line metadata and is never
        // reflected into hook output or executable instructions.
        for (const [stem, reason] of Object.entries(map)) {
          if (!validMigrationStem(stem) || !validRegistryReason(reason)) {
            throw new Error("invalid one-shot entry");
          }
          if (!(stem in oneShot)) oneShot[stem] = true;
        }
        registriesRead.push(registryPath);
      } catch {
        // A registry that EXISTS but will not parse is the disagreement case:
        // one checkout claims containment and the other cannot be read to
        // confirm or deny it. Fail closed rather than fall back to the half
        // that happened to load.
        return block(
          `ONE-SHOT REPLAY GUARD: the one-shot migration registry at ${registryPath} exists but ` +
          `failed strict parsing or validation. Its contents are treated as untrusted and are not ` +
          `echoed. Without a valid registry there is no way to tell an ` +
          `idempotent schema migration from a population-bound data repair, so this apply is ` +
          `refused. Restore the file from git (it is tracked) and retry.`);
      }
    }
    if (registriesRead.length === 0) {
      // Fail closed. The registry is tracked in git and ships beside this hook,
      // so its absence from every verified checkout means the checkout is
      // broken or the file was removed — the states in which a silent pass is
      // most dangerous.
      return block(
        `ONE-SHOT REPLAY GUARD: no one-shot migration registry was found in any verified checkout ` +
        `(looked in ${evidenceRoots.map((r) => path.join(r, "supabase", "baselines", "one-shot-migrations.json")).join(", ")}). ` +
        `Without it there is no way to tell an idempotent schema migration from a population-bound ` +
        `data repair, so this apply is refused. Restore the file from git (it is tracked) and retry.`);
    }

    let fanoutEvidence;
    let knownOperators;
    let knownCasts;
    let knownViews;
    let knownRules;
    try {
      fanoutEvidence = useCachedTestEvidence
        ? loadTrustedFanout(evidenceRoots)
        : loadTrustedFanout([], captureLiveFanoutManifest(projectDir));
      const knownDefinitions = loadKnownDefinitions(evidenceRoots, migName);
      knownOperators = knownDefinitions.operators;
      knownCasts = knownDefinitions.casts;
      knownViews = knownDefinitions.views;
      knownRules = [...fanoutEvidence.rules, ...knownDefinitions.rules];
    } catch (err) {
      return block(
        `ONE-SHOT REPLAY GUARD: trusted trigger/FK, custom-operator, custom-cast/domain, or stored-view evidence could not be loaded ` +
        `(${err?.message || err}). A directly named table is not the complete apply-time write ` +
        `surface when live triggers or referential actions can rewrite another population. ` +
        `Refusing the apply; production evidence is read directly in memory and cannot be ` +
        `replaced by a local manifest or attestation.`);
    }
    if (fanoutEvidence.enabledEventTriggers.length) {
      return block(
        `ONE-SHOT REPLAY GUARD: linked production evidence contains enabled PostgreSQL event ` +
        `trigger(s): ${fanoutEvidence.enabledEventTriggers.map((trigger) => trigger.name).join(", ")}. ` +
        `Event triggers execute database-wide on DDL and these routine bodies do not have a ` +
        `complete no-write static proof. Refusing every migration apply until the trigger(s) are ` +
        `disabled/removed through a separately reviewed path or their exact current behavior is ` +
        `modeled and independently reviewed. The guard's live read will re-evaluate them on retry.`);
    }
    // An event trigger fires on DDL, not on ordinary row DML. Treating its
    // session-local catalog lookup as a reason to reject a simple UPDATE/INSERT
    // would disable the only sanctioned repair path and invite a bypass. Keep
    // the fail-closed rule for every statement that can be DDL (including
    // procedural/dynamic execution, whose effect cannot be proved here).
    const hasPotentialDdl = /\b(?:alter|analyze|call|cluster|comment|create|do|drop|execute|grant|refresh|reindex|revoke|security\s+label|truncate|vacuum)\b/i.test(query);
    if (fanoutEvidence.sessionDependentEventTriggers.length && hasPotentialDdl) {
      return block(
        `ONE-SHOT REPLAY GUARD: linked production session-dependent PostgreSQL event trigger helper(s) ` +
        `${fanoutEvidence.sessionDependentEventTriggers.map((trigger) => trigger.name).join(", ")} ` +
        `resolve PostgreSQL catalog metadata helpers through the applying database session's ` +
        `search_path. The guard's evidence read and the later migration apply use different ` +
        `sessions, so that catalog binding cannot be proved for DDL or procedural/dynamic migration ` +
        `shapes. Refusing this apply until each trigger pins and proves a safe path or the applying ` +
        `session is independently bound through a reviewed mechanism.`);
    }

    // Normalize for comparison: lowercase, strip comments, collapse whitespace.
    //
    // COMMENTS COME OUT VIA A SCANNER, NOT A REGEX (Codex High, round 20).
    // Rounds 8-19 stripped `--` line comments with one regex and left `/* */`
    // block comments standing. Codex dropped a single harmless block comment
    // into the registered money backfill and BOTH substring comparisons below
    // went false — so re-submitting the identical population-bound repair under
    // a fresh timestamped name walked straight past the one-shot override. A
    // one-character edit defeated the whole control.
    //
    // A scanner rather than stacked regexes because the two comment forms nest
    // inside one another and inside string literals: `-- see /*` must not open a
    // block that eats the rest of the file, `'/*'` must not either, and
    // PostgreSQL block comments nest. Dollar-quoted bodies are deliberately NOT
    // treated as opaque here: a `DO $$ ... $$` block IS the usual shape of a
    // money repair, so a comment tucked inside one is the same evasion wearing a
    // different hat. This text is only ever compared, never executed, so
    // stripping inside a body costs nothing.
    const stripComments = (s) => {
      let acc = "";
      let i = 0;
      const n = s.length;
      while (i < n) {
        const two = s.slice(i, i + 2);
        if (two === "--") {
          while (i < n && s[i] !== "\n") i += 1;
          acc += " ";
          continue;
        }
        if (two === "/*") {
          let depth = 1;
          i += 2;
          while (i < n && depth > 0) {
            const inner = s.slice(i, i + 2);
            if (inner === "/*") { depth += 1; i += 2; continue; }
            if (inner === "*/") { depth -= 1; i += 2; continue; }
            i += 1;
          }
          acc += " ";
          continue;
        }
        const ch = s[i];
        if (ch === "'" || ch === '"') {
          // Copy the literal through verbatim so a `--` or `/*` sitting inside
          // quoted data cannot blank the code that follows it.
          acc += ch;
          i += 1;
          while (i < n) {
            if (s[i] === ch && s[i + 1] === ch) { acc += ch + ch; i += 2; continue; }
            if (s[i] === ch) { acc += ch; i += 1; break; }
            acc += s[i];
            i += 1;
          }
          continue;
        }
        acc += ch;
        i += 1;
      }
      return acc;
    };
    // SEMANTICALLY-INERT SYNTAX IS NORMALIZED AWAY (Codex High, round 22).
    // Rounds 20-21 compared collapsed whitespace and stripped comments, which
    // left three spellings that change no rows but break every comparison
    // below. Re-submitting the registered money repair as any of them, under a
    // fresh timestamped name, walked past the one-shot override exactly as the
    // block comment did in round 20:
    //
    //   UPDATE ONLY public.orders SET ...        -- ONLY is a no-op here
    //   UPDATE public.orders o SET ...           -- an alias renames nothing
    //   UPDATE orders SET ... WHERE o.id = ...   -- qualifier on the column
    //
    // So the qualifier prefixes (`public.`, `o.`) come off, `ONLY` comes off,
    // and a table alias standing between the target and SET/WHERE comes off.
    // Both sides of every comparison run through this same function, so the
    // normalization cannot make two genuinely different repairs collide — it
    // only removes spellings that PostgreSQL itself treats as identical.
    //
    // Normalization is the FIRST layer, not the only one. Every round of this
    // has the same shape — the guard asks "does this text look like the repair
    // we already ran?", and the next round finds another spelling that reads
    // differently and runs identically. Round 23 turned `SET total_price =
    // total_price` into `SET total_price = (total_price)`, and normalizing
    // parentheses would just invite round 24. The semantic layer below asks the
    // smaller, finite question instead: what does this SQL WRITE when it
    // applies? These checks run together; either one is enough to refuse.
    //
    // An earlier version of this comment rejected a table+column fingerprint as
    // too noisy, on the grounds that it "would also match any future migration
    // touching the same column of the same table". That was measured and is
    // wrong, because it counted function bodies. 29 migrations here write
    // order_items.total_price — but almost all of them do it inside a
    // `CREATE FUNCTION` body, which writes nothing at apply time. Separating
    // apply-time writes from deferred ones, ZERO of the other 881 migrations in
    // this repository overlap the registered repair's targets. The fingerprint
    // costs no friction at all.
    const norm = (s) => stripComments(s)
      .toLowerCase()
      .replace(/\s+/g, " ")
      // `public.orders` -> `orders`, `o.id` -> `id`. Requires a letter or
      // underscore start so a numeric literal like `1.5` is never touched.
      .replace(/\b[a-z_][a-z0-9_]*\s*\.\s*(?=[a-z_"*])/g, "")
      .replace(/\b(update|delete from|insert into|merge(?: into)?) only /g, "$1 ")
      .replace(/\bupdate ("?[a-z0-9_]+"?) (?:as )?[a-z0-9_]+ set\b/g, "update $1 set")
      .replace(
        /\bdelete from ("?[a-z0-9_]+"?) (?:as )?[a-z0-9_]+ (where|using|returning)\b/g,
        "delete from $1 $2",
      )
      .replace(/\s+/g, " ")
      .trim();

    // A LEADING CTE IS STILL THE SAME WRITE (Codex High, round 22).
    // writeStatements() below keeps only fragments that START with a write
    // verb, so wrapping the registered UPDATE in `WITH x AS (...) UPDATE ...`
    // dropped it from the comparison set entirely. Find the write verb at
    // paren depth 0 instead and compare from there, so the CTE prefix is
    // ignored rather than being a way out.
    const writeCore = (st) => {
      let depth = 0;
      for (let i = 0; i < st.length; i += 1) {
        const ch = st[i];
        if (ch === "(") { depth += 1; continue; }
        if (ch === ")") { depth -= 1; continue; }
        if (depth !== 0) continue;
        if (i > 0 && /[a-z0-9_]/.test(st[i - 1])) continue;
        if (/^(insert into|update|delete from|merge(?: into)?) /.test(st.slice(i))) return st.slice(i);
      }
      return "";
    };

    // WHOLE-BODY CONTAINMENT IS NOT THE ONLY TEST (Codex High, round 20).
    // Both substring comparisons below ask whether one body wholly contains the
    // other, which any inserted statement breaks just as cleanly as an inserted
    // comment did. So the registered file is also broken into its individual
    // write statements: if the submitted SQL still carries one of them, it is
    // still replaying that repair no matter what was padded around it.
    //
    // Splitting on `;` cuts through dollar-quoted bodies too, which is what we
    // want — it surfaces the `UPDATE ... WHERE id = ANY(v_ids)` buried inside a
    // `DO` block as a fragment in its own right. Only write statements count,
    // and only ones long enough to be specific; a short or read-only fragment
    // would match half the repository and turn this into noise.
    const writeStatements = (normalized) => normalized
      .split(";")
      .map((st) => writeCore(st.trim()))
      .filter((st) => st.length >= 40);

    const normQuery = norm(migQuery);

    // WHAT THE SUBMITTED SQL ACTUALLY WRITES, as (table, column) pairs, counting
    // only statements that execute when the migration applies. Computed once;
    // see apply-time-dml-lib.mjs for why deferred routine bodies are excluded.
    let submitted = { targets: new Set(), dynamicWrites: [], unresolved: false };
    try {
      submitted = applyTimeWriteTargets(
        migQuery,
        { knownOperators, knownCasts, knownViews, knownRules },
      );
    } catch {
      // A parse this module cannot handle must not silently mean "writes
      // nothing". Treat it as unresolvable so the semantic check below refuses
      // rather than waving the migration through.
      submitted = { targets: new Set(), dynamicWrites: [], unresolved: true, searchPathChange: true };
    }
    // applyTimeWriteTargets recursively includes routine DDL executed from
    // dynamic SQL literals and invoked helper bodies. Falling back preserves
    // fail-closed behavior if an older/failed analyzer result reaches here.
    const routineCatalog = submitted.routineCatalog || routineIdentityChanges(migQuery);
    const changedEventRoutines = fanoutEvidence.allEnabledEventTriggers.filter((trigger) =>
      routineCatalog.changes.some((change) =>
        change.name === trigger.routine_name &&
        (!change.schema || change.schema === trigger.routine_schema),
      ),
    );
    if (routineCatalog.unparsed && fanoutEvidence.allEnabledEventTriggers.length) {
      return block(
        `ONE-SHOT REPLAY GUARD: this migration contains a routine catalog change whose identity ` +
        `cannot be parsed while linked production has enabled PostgreSQL event triggers. Refusing ` +
        `the apply because the changed routine cannot be cleared against the captured trigger OIDs ` +
        `and body hashes.`);
    }
    if (changedEventRoutines.length) {
      return block(
        `ONE-SHOT REPLAY GUARD: this migration creates, replaces, alters, or drops enabled ` +
        `PostgreSQL event-trigger routine(s) ` +
        `${changedEventRoutines.map((trigger) =>
          `${trigger.routine_schema}.${trigger.routine_name} ` +
          `(OID ${trigger.routine_oid}, body ${trigger.routine_hash.slice(0, 12)}…)`).join(", ")}. ` +
        `The guard's in-memory linked read proves only the exact current routine bodies. Refusing ` +
        `the apply; review the event-trigger change independently before retrying.`);
    }
    const submittedFanout = expandThroughFanout(submitted, fanoutEvidence);

    const ledgerHas = (stem) => appliedLedgerHas(stem, appliedNames);

    for (const stem of Object.keys(oneShot)) {
      // Both supported timestamp forms produce a real prefix or null. Never
      // turn an 8-digit stem into the empty string and then use it as identity.
      const version = migrationTimestampPrefix(stem);
      let matched = "";
      const sourceFiles = [];
      for (const root of evidenceRoots) {
        const filePath = migrationSourcePath(root, stem);
        if (!existsSync(filePath)) continue;
        try {
          const sourceSql = readFileSync(filePath, "utf8");
          if (!norm(sourceSql)) {
            return block(
              `ONE-SHOT REPLAY GUARD: ${stem} is registered as a population-bound migration, ` +
              `but its source file at ${filePath} has no executable canonical SQL after comments ` +
              `are removed. An empty or corrupted source has no replay identity. Refusing the ` +
              `apply; restore the tracked SQL file and retry.`);
          }
          const registered = applyTimeWriteTargets(
            sourceSql,
            { knownOperators, knownCasts, knownViews, knownRules },
          );
          const registeredFanout = expandThroughFanout(registered, fanoutEvidence);
          const resolvedWrite = registered.targets.size > 0;
          const opaqueWrite = registered.unresolved || registered.dynamicWrites.length > 0 ||
            registered.unknownCalls?.length > 0;
          if (!resolvedWrite && !opaqueWrite) {
            return block(
              `ONE-SHOT REPLAY GUARD: ${stem} is registered as a population-bound migration, ` +
              `but its source file at ${filePath} contains no analyzable apply-time write identity. ` +
              `A nonempty but corrupted/read-only source cannot identify the registered repair. ` +
              `Refusing the apply; restore the tracked SQL file and retry.`);
          }
          sourceFiles.push({ filePath, sourceSql, registered, registeredFanout });
        } catch (err) {
          return block(
            `ONE-SHOT REPLAY GUARD: ${stem} is registered as a population-bound migration, ` +
            `but its source file at ${filePath} could not be read (${err?.message || err}). ` +
            `Without that source, a renamed replay cannot be compared to the registered repair. ` +
            `Refusing the apply; restore the tracked SQL file and retry.`);
        }
      }
      if (sourceFiles.length === 0) {
        return block(
          `ONE-SHOT REPLAY GUARD: ${stem} is registered as a population-bound migration, but ` +
          `supabase/migrations/${stem}.sql is missing from every verified checkout. Without that ` +
          `source, a renamed replay cannot be compared to the registered repair. Refusing the ` +
          `apply; restore the tracked SQL file and retry.`);
      }
      // The MCP `name` is caller-controlled, so a name match is a convenience,
      // not the whole test — the body is checked too.
      if (migName && (migName.includes(stem) || (version && migName.includes(version)))) {
        matched = `the migration name "${safeName}"`;
      } else if (normQuery) {
        // Same reason the registry is read from every verified checkout: the
        // migration file for a branch-local one-shot exists only in the
        // worktree (Codex High, round 12).
        for (const { filePath, sourceSql, registered, registeredFanout } of sourceFiles) {
          try {
            const normFile = norm(sourceSql);
            if (normFile && (normQuery.includes(normFile) || normFile.includes(normQuery))) {
              matched = `the SQL body (it matches ${stem}.sql on disk)`;
              break;
            }
            const shared = writeStatements(normFile).find((st) => normQuery.includes(st));
            if (shared) {
              matched =
                `a write statement carried over from ${stem}.sql on disk ` +
                `(“${shared.slice(0, 80)}${shared.length > 80 ? "…" : ""}”)`;
              break;
            }

            // SEMANTIC LAYER (Codex High, round 23). The three checks above all
            // compare TEXT, and the set of texts that perform one write is
            // infinite. This one compares what the two files DO at apply time.
            // Rewording, re-parenthesizing, aliasing, re-casing, or re-commenting
            // the registered repair changes every text comparison and changes
            // nothing here.
            // A registered one-shot whose own targets cannot be read statically
            // gives this layer nothing to compare against. Rather than pass
            // quietly, treat any apply-time write in the submitted SQL as
            // needing the override. Nothing in the registry does this today, so
            // it costs nothing until someone registers dynamic SQL — at which
            // point a prompt is the correct outcome.
            const submittedHasEffect = submittedFanout.targets.size || submitted.unresolved ||
              submitted.dynamicWrites.length || submitted.unknownCalls?.length;
            if ((registered.unresolved || registered.dynamicWrites.length ||
                 registered.unknownCalls?.length) && submittedHasEffect) {
              matched =
                `an apply-time write that cannot be cleared against ${stem}.sql, whose own ` +
                `write target is decided at runtime`;
              break;
            }
            if (registeredFanout.targets.size === 0) continue;

            // Table-level on purpose (Codex High, round 27). A trigger that
            // recomputes money from sibling columns re-runs the registered
            // repair for a write that shares no column with it — `SET profit =
            // profit` re-fires the same correction `SET total_price =
            // total_price` did. The column is still reported; it just cannot
            // narrow the match.
            const regTables = new Set([...registeredFanout.targets].map(targetTable).filter(Boolean));
            const hits = overlappingTables(submittedFanout.targets, registeredFanout.targets);
            if (hits.length) {
              matched =
                `what it writes when it applies — ${[...new Set(hits)].sort().join(", ")} — ` +
                `in a table ${stem}.sql already wrote directly or through live trigger/FK fan-out`;
              break;
            }

            // The manifest records every edge it can prove, then marks a source
            // opaque when live behavior is incomplete or unreadable. Known
            // edges above still match specifically; opacity below refuses the
            // remaining unknown surface instead of treating it as empty.
            if (submittedFanout.opaqueSources.size && regTables.size) {
              matched =
                `an apply-time write whose live trigger/FK fan-out is opaque on ` +
                `${[...submittedFanout.opaqueSources].sort().join(", ")}, so it cannot be ruled out ` +
                `against ${stem}.sql (${[...regTables].sort().join(", ")})`;
              break;
            }
            if (registeredFanout.opaqueSources.size && submittedHasEffect) {
              matched =
                `an apply-time write that cannot be cleared against ${stem}.sql because that registered ` +
                `repair has opaque live trigger/FK fan-out on ` +
                `${[...registeredFanout.opaqueSources].sort().join(", ")}`;
              break;
            }

            // A write whose relation is chosen at runtime (`EXECUTE format(
            // 'UPDATE %I ...', v_table)`) cannot be cleared statically, and
            // neither can SQL this module failed to parse. Both fail toward
            // refusing: an override prompt costs one message, a missed replay
            // costs a money population.
            if (submitted.unresolved && regTables.size) {
              matched =
                `an apply-time write whose target table is decided at runtime, which cannot be ` +
                `ruled out against ${stem}.sql (${[...regTables].sort().join(", ")})`;
              break;
            }
            const dynHit = submitted.dynamicWrites.find((lit) =>
              [...regTables].some((t) => new RegExp(`\\b${t}\\b`, "i").test(lit)));
            if (dynHit) {
              matched =
                `a dynamically executed write naming a table ${stem}.sql wrote ` +
                `(“${dynHit.slice(0, 80).replace(/\s+/g, " ")}${dynHit.length > 80 ? "…" : ""}”)`;
              break;
            }

            // ROUND 24. Routine bodies defined in the submitted file are now
            // followed wherever it calls them, so define-the-repair-and-run-it
            // no longer reads as zero writes. What is left is a routine that
            // already lives in the database: `CALL do_the_repair()` names a body
            // this file does not contain, and no amount of reading the file will
            // tell us what it writes. CALL and PERFORM exist only to run
            // something for its effect, so an unreadable one is refused rather
            // than assumed harmless — measured at 16 of 881 migrations here.
            if (submitted.unknownCalls?.length && regTables.size) {
              const names = [...new Set(submitted.unknownCalls)].sort();
              matched =
                `an apply-time call to ${names.map((n) => `${n}()`).join(", ")}, whose body is not ` +
                `in this migration and so cannot be cleared against ${stem}.sql ` +
                `(${[...regTables].sort().join(", ")})`;
              break;
            }
          } catch (err) {
            return block(
              `ONE-SHOT REPLAY GUARD: ${stem} is registered as a population-bound migration, ` +
              `but its source file at ${filePath} could not be read or analysed ` +
              `(${err?.message || err}). Without that source, a renamed replay cannot be compared ` +
              `to the registered repair. Refusing the apply; restore the tracked SQL file and retry.`);
          }
        }
      }
      if (!matched) continue;

      // Digest-bound override: an operator who genuinely means to replay this
      // must hash the EXACT SQL they are about to run and record it. A named
      // flag would be a wave-through for any body; binding to `currentHash`
      // means the override authorizes this text and nothing else.
      //
      // ONE SHOT MEANS ONE SHOT (Codex High, round 11). Round 10 bound the
      // override to the stem and the SQL hash and stopped there — so the same
      // file stayed valid across DATABASES and across TIME. An override written
      // for one approved replay still released the identical money write days
      // later, against a restored or entirely different project: exactly the
      // population drift this guard exists to stop. It must now also name the
      // target project and carry a fresh timestamp, and it is CONSUMED on
      // sight — deleted before the verdict is decided, so it authorizes one
      // apply attempt whether that attempt is then accepted or refused.
      // ROUND 31. The override was read from `stateDir` — the PRIMARY checkout,
      // because CLAUDE_PROJECT_DIR is pinned there even when the session works
      // in a linked worktree. That is the same mismatch the proof lookup above
      // was fixed for on 2026-07-29: an operator authorizing a replay from the
      // worktree that actually holds the migration wrote a perfectly good
      // override somewhere this guard never looked, and the apply was refused no
      // matter how deliberate the authorization. Refusing is the safe direction,
      // so this is friction rather than a hole — but it is friction on the path
      // an operator only reaches when a money replay genuinely has to happen,
      // which is the worst possible place to make someone fight the tooling.
      //
      // So the override resolves over `proofDirs`: the primary checkout plus
      // THIS session's own worktree, and nothing else. That is the same trust
      // boundary the proofs use and it is deliberately narrower than "any
      // worktree" — a sibling session's override must not authorize this apply.
      //
      // ONE OVERRIDE, OR NONE. If both checkouts hold one, this refuses instead
      // of picking. Spending one would leave the other sitting there valid for
      // the rest of its window, ready to release a second apply — the exact
      // multiple-release the claim-and-consume machinery below exists to
      // prevent, reintroduced at the level of which file to open. Ambiguous
      // authorization is not authorization.
      const ovCandidates = proofDirs.map((d) => path.join(d, "one-shot-replay-override.json"));
      const ovPresent = ovCandidates.filter((p) => existsSync(p));
      if (ovPresent.length > 1) {
        return block(
          `ONE-SHOT REPLAY GUARD: a replay override exists in more than one checkout ` +
          `(${ovPresent.join(", ")}). Consuming one would leave the other valid for the rest of ` +
          `its window, so a single authorization could release a second apply — refusing rather ` +
          `than choosing.\n\n` +
          `Delete all but the one you meant, then retry.`);
      }
      // With none present this is the primary checkout's path, exactly as before,
      // so the no-override path is unchanged.
      const ovPath = ovPresent[0] || ovCandidates[0];
      const OVERRIDE_MAX_AGE_MS = 30 * 60 * 1000;
      const OVERRIDE_MAX_SKEW_MS = 60 * 1000;
      let overrideOk = false;
      let overrideWhy = "";
      let overrideClaimed = false;
      if (existsSync(ovPath)) {
        let raw = "";
        // CLAIM BEFORE READING (Codex High, round 15). Consume-before-deciding
        // is not one shot under concurrency: rounds 11-13 read the file and
        // deleted it afterwards, so two apply hooks running at once both passed
        // the existsSync check and both read the same bytes. One delete won; the
        // loser got ENOENT, and its catch only refused when the path still
        // existed — by then it did not. The loser carried on with the copy it
        // had already read, and BOTH applies were authorized by ONE
        // authorization. That is exactly the multiple-attempt release this
        // control exists to prevent on a population-bound money migration.
        //
        // THE CLAIM IS AN EXCLUSIVE CREATE, NOT A RENAME (round 16).
        //
        // Round 15 claimed the override by renaming it to a private path, on
        // the stated premise that "exactly one process can move the override
        // away". THAT PREMISE IS FALSE ON WINDOWS, which is where this guard
        // actually runs. Measured on this machine — 8 concurrent renames of one
        // source to distinct destinations, 150 rounds — 21 rounds produced TWO
        // winners and one produced THREE. The round-15 concurrency test caught
        // it: two racers were released by a single override. POSIX rename(2) is
        // exclusive; Win32 MoveFileEx under contention is not, so a rename-based
        // claim reintroduced exactly the double-release it was written to fix.
        //
        // openSync(lock, "wx") — O_CREAT|O_EXCL — IS exclusive here: the same
        // harness measured 0 double-winners in 120 rounds for exclusive-create
        // (and for mkdir and link). So the claim is now: take an exclusive lock,
        // and only the holder may read and delete the override. Deleting it
        // while holding the lock is the consumption. A parse failure, a
        // mismatch, and a clean acceptance all still leave the operator with a
        // spent override, which is what round 11 required.
        //
        // The lock is released in a `finally` BEFORE any out() call, because
        // out() calls process.exit and would otherwise leak the lock and wedge
        // every later apply.
        const lockPath = `${ovPath}.lock`;
        let holdsLock = false;
        let lockErr = null;
        try {
          closeSync(openSync(lockPath, "wx"));
          holdsLock = true;
        } catch (err) {
          lockErr = err;
        }
        if (!holdsLock) {
          // A CLAIM THAT FAILED IS NOT A CONSUMPTION (Codex Medium, round 13,
          // carried forward). Either another apply holds the claim right now, or
          // a previous holder died and left the lock behind. In neither case did
          // THIS apply own the authorization, and in the second case the override
          // is still sitting there — it would stay valid for the rest of its
          // 30-minute window and release a second, third, fourth apply. Refuse:
          // better a blocked replay the operator clears by hand than a one-shot
          // that is not one shot.
          return block(
            `ONE-SHOT REPLAY GUARD: the replay override at ${ovPath} could not be claimed ` +
            `(${lockErr?.message || lockErr}), so reading it would not have spent it. Either ` +
            `another apply is consuming it right now, or a previous apply died holding the claim. ` +
            `An override that survives its own use authorizes every apply until it expires, which ` +
            `is the opposite of one-shot — refusing this apply.\n\n` +
            `Remove ${lockPath} by hand (and ${ovPath} if it is still there), then write a fresh ` +
            `override if the replay is genuinely intended.`);
        }
        let consumeErr = null;
        try {
          // Re-check UNDER the lock. Between the existsSync above and the lock
          // an earlier holder may have spent it; if so this apply owns nothing
          // and must fall through to the ordinary one-shot refusal below. It
          // must never fall back on bytes it does not own.
          if (existsSync(ovPath)) {
            try {
              raw = readFileSync(ovPath, "utf8");
            } catch (err) {
              overrideWhy = `it could not be read (${err?.message || err})`;
            }
            // The delete IS the consumption. If it fails, the override survives
            // its own use — so the bytes just read must not be honoured.
            //
            // rmSync, not unlinkSync: round 13 settled that an override which is
            // SPENDABLE BUT UNUSABLE (a directory sitting at that path) must be
            // spent and then refused for being unreadable. unlinkSync cannot
            // remove a directory, so it would report "could not be consumed" and
            // leave the thing in place — weakening a settled requirement to suit
            // the implementation. The path is fixed and derived, so a recursive
            // removal here is bounded to the override itself. The retries cover
            // Windows' transient EPERM on a file another process just released.
            try {
              rmSync(ovPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
              overrideClaimed = true;
            } catch (err) {
              consumeErr = err;
            }
          }
        } finally {
          try {
            unlinkSync(lockPath);
          } catch { /* a leftover lock fails closed: it only ever blocks applies */ }
        }
        if (consumeErr) {
          return block(
            `ONE-SHOT REPLAY GUARD: the replay override at ${ovPath} was read but could not be ` +
            `consumed (${consumeErr?.message || consumeErr}). An override that survives its own ` +
            `use authorizes every apply until it expires — refusing this apply.\n\n` +
            `Remove that path by hand, then write a fresh override if the replay is genuinely ` +
            `intended.`);
        }

        if (overrideClaimed && !overrideWhy) {
          try {
            const ov = JSON.parse(raw);
            const ovMigration = typeof ov?.migration === "string" ? ov.migration.trim() : "";
            const ovQueryMigration = typeof ov?.queryMigration === "string"
              ? ov.queryMigration.trim()
              : "";
            const ovHash = typeof ov?.queryHash === "string" ? ov.queryHash.trim().toLowerCase() : "";
            const ovProject = typeof ov?.project === "string" ? ov.project.trim() : "";
            const issuedText = typeof ov?.issuedAt === "string" ? ov.issuedAt.trim() : "";
            const ovIssued = Date.parse(issuedText);
            const ageMs = Number.isFinite(ovIssued) ? Date.now() - ovIssued : NaN;

            if (!validMigrationStem(ovMigration)) {
              overrideWhy = `its migration identifier is missing or invalid`;
            } else if (ovMigration !== stem) {
              overrideWhy = `it authorizes a different migration identifier`;
            } else if (ovQueryMigration && !validMigrationStem(ovQueryMigration)) {
              overrideWhy = `its query migration identifier is invalid`;
            } else if (!/^[0-9a-f]{64}$/.test(ovHash) || currentHash === "" || ovHash !== currentHash) {
              overrideWhy = `its queryHash does not match the SQL being applied`;
            } else if (!validProjectRef(ovProject)) {
              overrideWhy =
                `its target project identifier is missing or invalid, so it cannot be shown to ` +
                `authorize this database`;
            } else if (ovProject !== targetRef) {
              overrideWhy = `it authorizes a different target project`;
            } else if (!Number.isFinite(ovIssued) || new Date(ovIssued).toISOString() !== issuedText) {
              overrideWhy = `its issuedAt is missing or not a canonical ISO timestamp, so its age cannot be checked`;
            } else if (ageMs > OVERRIDE_MAX_AGE_MS || ageMs < -OVERRIDE_MAX_SKEW_MS) {
              overrideWhy =
                `it was issued ${Math.round(ageMs / 60000)} minute(s) ago, outside the ` +
                `${OVERRIDE_MAX_AGE_MS / 60000}-minute window`;
            } else {
              overrideOk = true;
            }
          } catch {
            overrideWhy = `it is not valid JSON; its contents are not echoed`;
          }
        }
      }
      if (overrideOk) continue;

      // The wrapper must hash the SQL being applied, not automatically the
      // historical registered source. A different reviewed repair can overlap
      // the same protected table and therefore need this override while having
      // entirely different bytes. Prefer an exact file-backed current query;
      // if none of the verified checkouts contains those bytes, require the
      // operator to save/review the SQL as a migration before authorizing it.
      let overrideQueryStem = "";
      for (const candidateStem of [...new Set([migName, stem])]) {
        if (!validMigrationStem(candidateStem) || !currentHash) continue;
        const exactSource = evidenceRoots.some((root) => {
          try {
            const candidatePath = migrationSourcePath(root, candidateStem);
            return existsSync(candidatePath) &&
              createHash("sha256").update(readFileSync(candidatePath, "utf8")).digest("hex") === currentHash;
          } catch {
            return false;
          }
        });
        if (exactSource) {
          overrideQueryStem = candidateStem;
          break;
        }
      }
      const overrideInstruction = overrideQueryStem
        ? `  node scripts/write-one-shot-replay-override.mjs --migration ${stem} ` +
          `--query-migration ${overrideQueryStem} --project ${targetRef}\n`
        : `  First save the exact reviewed SQL as a timestamped file under supabase/migrations, ` +
          `then run:\n` +
          `  node scripts/write-one-shot-replay-override.mjs --migration ${stem} ` +
          `--query-migration <current-query-stem> --project ${targetRef}\n`;

      return block(
        `ONE-SHOT REPLAY GUARD: this apply matches ${matched}, which is registered as a one-shot ` +
        `DATA migration in supabase/baselines/one-shot-migrations.json. ` +
        (ledgerHas(stem)
          ? `The applied-migration ledger for this database already contains it, so this is a REPEAT ` +
            `apply of a repair that has already run once.`
          : `The applied-migration ledger for this database does NOT contain it.`) +
        `\n\n` +
        `Registry classification: population-bound one-shot data repair. Registry prose is ` +
        `untrusted metadata and is intentionally not echoed by this security boundary.\n\n` +
        `Its authorization was bound to the live population at the time it was written — counts, not ` +
        `row identity. Running it against a database that never had it rewrites rows nobody approved; ` +
        `running it a SECOND time rewrites whatever the population has since become. After a restore, ` +
        `the corrected values come back with the DATA — not by re-running the edit.\n\n` +
        (overrideWhy
          ? `An override file was present and has been CONSUMED without releasing this apply: ${overrideWhy}. ` +
            `Write a new one below if the replay is genuinely intended.\n\n`
          : ``) +
        `If this really is a deliberate, reviewed replay, bind the override to the exact SQL, ` +
        `this database, and this moment:\n` +
        overrideInstruction +
        `That fixed reviewed wrapper accepts only validated identifiers, resolves the migration ` +
        `inside supabase/migrations, hashes the current query file's exact bytes, and refuses to overwrite an existing ` +
        `authorization.\n` +
        `That override authorizes that exact text, on ${targetRef}, for the next ` +
        `${OVERRIDE_MAX_AGE_MS / 60000} minutes, for ONE apply attempt — it is deleted the moment ` +
        `the guard reads it, so a second attempt needs a second override. Get Mason's explicit OK ` +
        `first — this is a live money write.`);
    }
  }
}

// HARD carve-out (Mason's settled 2026-07-13 policy): in a hands-free run, a
// DESTRUCTIVE migration — apply-time DELETE/TRUNCATE/DROP of data — NEVER
// applies autonomously, review proof or not. Deleted data has no PITR on the
// free Supabase plan. Checked BEFORE the proof gate so a clean review cannot
// override it.
//
// Autopilot flag state drives which rule-set applies (Codex P1s, 2026-07-13
// rounds 2-3):
//   absent → interactive rules (Mason present; his in-chat OK is the gate).
//   active → hands-free rules below (destructive refused; Codex gate + exact
//            queryHash binding required).
//   stale (file exists but EXPIRED or malformed) → the authorization has
//            LAPSED with nobody watching: block ALL applies, benign or not,
//            until Mason re-arms (a fresh explicit authorization) or disarms
//            (--off deletes the flag, restoring interactive rules in person).
const apFlagPath = path.join(stateDir, "AUTOPILOT.on");
let flagState = "absent";
try {
  if (existsSync(apFlagPath)) {
    try { flagState = flagActive(readFileSync(apFlagPath, "utf8"), Date.now()).active ? "active" : "stale"; }
    catch { flagState = "stale"; }
  }
} catch { flagState = "stale"; } // can't even inspect the flag → fail closed

if (flagState === "stale") {
  return block(
    `MIGRATION APPLY GUARD: an autopilot flag exists but is EXPIRED or malformed — the hands-free ` +
    `authorization for this run has LAPSED, and no one is confirmed present. ALL migration applies ` +
    `are parked (benign ones too). PARK the migration (scripts/.staging-migrations/ + a ` +
    `docs/manual/KNOWN_ISSUES.md note) and wait for Mason: he can re-arm ` +
    `(node .claude/hooks/autopilot-arm.mjs --hours N) or disarm in person (--off). ` +
    `Do NOT delete or rewrite the flag yourself to get past this.`);
}

const handsFree = flagState === "active";

if (handsFree && migQuery) {
  // Fail CLOSED in hands-free mode: a classifier error counts as destructive.
  let d;
  try { d = destructiveMigrationCheck(migQuery); }
  catch (e) { d = { destructive: true, reason: `destructive-check error (${e && e.message ? e.message : e}) — failing closed hands-free` }; }
  if (d.destructive) {
    return block(
      `MIGRATION APPLY GUARD (hands-free run): migration "${migName || "(unnamed)"}" contains a ` +
      `destructive statement (${d.reason}). Destructive migrations NEVER apply autonomously — ` +
      `Mason's settled 2026-07-13 policy — because deleted data has no point-in-time recovery on ` +
      `this Supabase plan. PARK it (scripts/.staging-migrations/ + a docs/manual/KNOWN_ISSUES.md ` +
      `entry with the plain-English risk) and leave it for Mason's explicit in-chat OK in the morning. ` +
      `Do NOT disarm autopilot to route around this. (This rule also fires on an EXPIRED autopilot ` +
      `flag — deliberate fail-closed. If Mason IS present and approves in chat, HE can ask you to ` +
      `disarm first: node .claude/hooks/autopilot-arm.mjs --off.)`);
  }
}

// Look at all proof files in stateDir and find a recent one for this migration.
const MAX_AGE_MS = PROOF_MAX_AGE_MS;

let validProof = null;
for (const dir of proofDirs) {
  if (validProof) break;
  try {
  const files = readdirSync(dir).filter(f => f.startsWith("migration-review-") && f.endsWith(".json"));
  for (const f of files) {
    const full = path.join(dir, f);
    let data;
    try { data = JSON.parse(readFileSync(full, "utf8")); } catch { continue; }
    let ageMs;
    try { ageMs = now - new Date(data.timestamp).getTime(); } catch { continue; }
    // Age must be a real value inside [0, 30min] — a FUTURE-dated timestamp
    // (clock skew, typo, or a fabricated far-future stamp) must not stay
    // "fresh" forever (Codex P2 2026-07-13 round 5). NaN fails this too.
    if (!(ageMs >= 0 && ageMs <= MAX_AGE_MS)) continue;
    // Match if proof migration name appears in the apply_migration `name` field
    // or if the apply_migration name matches.
    const proofName = (data.migration || "").toString();
    if (
      proofName &&
      (migName.includes(proofName) || proofName.includes(migName) || migName === proofName)
    ) {
      const findings = (data.findings || "").toString();
      if (findings === "clean" || findings === "blockers-fixed") {
        // Content-binding: if the proof recorded a queryHash, it must match the SQL
        // actually being applied. A mismatch means the migration was edited AFTER it
        // was reviewed, so the proof no longer attests to this content — skip it.
        if (data.queryHash && currentHash && data.queryHash !== currentHash) continue;
        validProof = { file: f, dir, data };
        break;
      }
    }
  }
  } catch { /* directory unreadable — try the next one, then fall through to block */ }
}

if (validProof) {
  // Hands-free applies carry three EXTRA requirements (Codex P1s 2026-07-13
  // rounds 2-3) — with Mason absent, the proof must be maximally bound:
  //   1. Exact content binding: the proof's queryHash must be present and
  //      match the transmitted SQL (interactively it's optional-but-checked;
  //      unattended, an unbound proof could apply edited-after-review SQL).
  //   2. A recorded Codex Sol/high verdict (separate reviewer gate actually ran — Mason's
  //      "ran, not queued" rule).
  //   3. A FRESH Codex output artifact on disk (<30 min): /codex-review tees
  //      its output to .claude/session-state/codex-review-latest.txt. A
  //      verdict field with no fresh artifact means Codex was not actually
  //      run this session. (Honest-mistake net: a determined agent could
  //      forge the artifact — that residual is documented in
  //      docs/manual/KNOWN_ISSUES.md §4b proof self-attestation.)
  if (handsFree) {
    const proofHash = String(validProof.data.queryHash || "");
    if (!proofHash || !currentHash || proofHash !== currentHash) {
      return block(
        `MIGRATION APPLY GUARD (hands-free run): the reviewer proof for "${migName || "(unnamed)"}" ` +
        `is not content-bound — autonomous applies require "queryHash" in the proof to be present and ` +
        `exactly match the SHA-256 of the transmitted SQL (expected: ${currentHash || "(no query text)"}). ` +
        `Re-confirm the reviewers against the CURRENT SQL, update the proof's queryHash, and retry.`);
    }
    // The proof must name BOTH required reviewers (Codex P1 2026-07-13 round
    // 5: a minimal hand-written proof with no reviewers array reached allow).
    // Still self-attestable — the residual documented in KNOWN_ISSUES §4b —
    // but it forces the /migration-review flow, which only writes the array
    // after the reviewer subagents actually returned clean.
    const reviewers = Array.isArray(validProof.data.reviewers) ? validProof.data.reviewers.map(String) : [];
    const missing = ["rls-security-reviewer", "migration-drift-reviewer"].filter(r => !reviewers.includes(r));
    if (missing.length) {
      return block(
        `MIGRATION APPLY GUARD (hands-free run): the reviewer proof for "${migName || "(unnamed)"}" ` +
        `does not record the required reviewers (missing: ${missing.join(", ")}). Autonomous applies ` +
        `require BOTH rls-security-reviewer and migration-drift-reviewer to have actually run clean ` +
        `this session (dispatch them via /migration-review, then write the proof with its "reviewers" ` +
        `array). Never add names for reviewers that did not run.`);
    }
    // The Codex gate is its own content-bound proof file — NOT a field in the
    // reviewer proof, NOT the mtime of a tee'd log (Codex P1 2026-07-13 round
    // 4: a stray codex-review-latest.txt from an unrelated or FAILED run
    // satisfied an mtime check). Required shape at
    // .claude/session-state/codex-review-mig-<safeName>.json:
    //   { "queryHash": <sha256 of the EXACT transmitted SQL>,
    //     "verdict": "clean" | "ship" | "ship-with-followups",
    //     "model": "gpt-5.6-sol",
    //     "reasoning_effort": "high",
    //     "timestamp": <ISO-8601, <30 min old> }
    // Write it ONLY after an ACTUAL /codex-review run on this migration this
    // session — a fabricated file violates Mason's codex-gate rule and is the
    // documented self-attestation residual (KNOWN_ISSUES §4b).
    // Searched across the same session-scoped directories as the reviewer proof
    // above, for the same reason. A candidate only WINS by satisfying
    // every criterion the single-directory version demanded — clean verdict,
    // exact queryHash, age inside [0, 30min]; the first parseable file is kept
    // only so the block message below can say which criterion failed.
    let codexProof = null;
    for (const dir of proofDirs) {
      let candidate = null;
      try { candidate = JSON.parse(readFileSync(path.join(dir, `codex-review-mig-${safeName}.json`), "utf8")); } catch { continue; }
      if (!candidate) continue;
      if (!codexProof) codexProof = candidate;
      const okVerdict = ["clean", "ship", "ship-with-followups"].includes(String(candidate.verdict || "").toLowerCase());
      const okHash = !!currentHash && String(candidate.queryHash || "") === currentHash;
      const okIdentity = candidate.model === REQUIRED_CODEX_MODEL
        && candidate.reasoning_effort === REQUIRED_CODEX_EFFORT;
      let okFresh = false;
      try {
        const candidateAge = now - new Date(candidate.timestamp).getTime();
        okFresh = candidateAge >= 0 && candidateAge <= MAX_AGE_MS;
      } catch { okFresh = false; }
      if (okVerdict && okHash && okIdentity && okFresh) { codexProof = candidate; break; }
    }
    const cvOk = codexProof && ["clean", "ship", "ship-with-followups"].includes(String(codexProof.verdict || "").toLowerCase());
    const cvHashOk = codexProof && currentHash && String(codexProof.queryHash || "") === currentHash;
    const cvIdentityOk = codexProof
      && codexProof.model === REQUIRED_CODEX_MODEL
      && codexProof.reasoning_effort === REQUIRED_CODEX_EFFORT;
    // Freshness = age inside [0, 30min]; a FUTURE-dated timestamp must not
    // count as fresh (Codex P2 round 5 — clock skew / typo / fabrication).
    let cvFresh = false;
    try {
      const cvAge = now - new Date(codexProof.timestamp).getTime();
      cvFresh = !!codexProof && cvAge >= 0 && cvAge <= MAX_AGE_MS;
    } catch { cvFresh = false; }
    if (!cvOk || !cvHashOk || !cvIdentityOk || !cvFresh) {
      return block(
        `MIGRATION APPLY GUARD (hands-free run): the Sol high-effort gate is not satisfied for ` +
        `"${migName || "(unnamed)"}" (${!codexProof ? "no Codex proof file" : !cvOk ? "verdict is not clean/ship" : !cvHashOk ? "queryHash does not match the transmitted SQL" : !cvIdentityOk ? `proof must record model=${REQUIRED_CODEX_MODEL} and reasoning_effort=${REQUIRED_CODEX_EFFORT}` : "proof timestamp is not within the last 30 minutes"}). ` +
        `Autonomous applies require a fresh, content-bound Codex verdict (Mason's settled 2026-07-13 ` +
        `policy). Run: node scripts/write-apply-proofs.mjs ${migName || "<migName>"} — it runs the ` +
        `trusted Codex CLI itself and mints the content-bound proof ONLY on a CLEAN machine verdict. ` +
        `Do NOT hand-write the proof JSON (review-proof-guard blocks any command naming it, by design). ` +
        `A BLOCKERS verdict or a failed Codex run does NOT qualify — fix the findings or PARK the ` +
        `migration for Mason. Never self-certify.`);
    }
  }
  return allow();
}

// No valid proof — block with explicit instructions.
return block(
  `MIGRATION APPLY GUARD: Cannot apply migration "${migName || "(unnamed)"}" without subagent review proof.\n\n` +
  `REQUIRED STEPS before retrying this call:\n` +
  `  1. Dispatch in PARALLEL (single message with two Agent tool calls):\n` +
  `       Agent: rls-security-reviewer    (scope: this migration)\n` +
  `       Agent: migration-drift-reviewer (scope: this migration)\n` +
  `  2. If either returns BLOCKER findings, FIX them and re-dispatch until clean.\n` +
  `  3. Once both return clean (or "blockers-fixed"), stamp the proof with the wrapper\n` +
  `     (it computes the content hash itself — do not hand-write the JSON):\n` +
  `       node scripts/write-apply-proofs.mjs ${migName || "<migName>"}\n` +
  `     (The wrapper ALWAYS runs a real Codex review of the file and mints nothing\n` +
  `      without a CLEAN machine verdict — a BLOCKERS or failed run means fix or park.)\n` +
  `  4. AUTHORIZATION — the proof gate is a floor, NOT the authorization: in an\n` +
  `     ordinary interactive session, get Mason's explicit in-chat OK before applying.\n` +
  `     (Only a Mason-pre-authorized hands-free run with autopilot armed may apply\n` +
  `      without the per-migration ask — settled 2026-07-13; destructive migrations never.)\n` +
  `  5. Retry the apply_migration call.\n\n` +
  `The proof file expires after 30 minutes — this catches stale reviews on long sessions.\n` +
  `The "queryHash" above is the SHA-256 of the exact SQL being applied; it binds this proof to\n` +
  `this content. If the migration is edited after review, the hash changes and this guard blocks\n` +
  `again — re-confirm the reviewers, then update queryHash to the new value printed here.\n` +
  `This guard exists because of the B7/B8/B9 incidents (2026-05-26) where migrations were\n` +
  `applied without the parallel-session reviewers catching anon-EXECUTE-able SECDEF DML.`
);
}

export function evaluateMigrationApply(args = {}) {
  return evaluateMigrationApplyMode({ ...args, useCachedTestEvidence: false });
}

export function evaluateMigrationApplyWithCachedTestEvidence(args = {}) {
  return evaluateMigrationApplyMode({ ...args, useCachedTestEvidence: true });
}
