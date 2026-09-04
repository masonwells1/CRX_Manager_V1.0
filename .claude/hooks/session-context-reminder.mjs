#!/usr/bin/env node
// SessionStart hook: inject the project context reminders as additionalContext.
//
// Replaces two former `"type": "prompt"` hooks (the PreCompact money/RLS
// re-anchor and the SessionStart onboarding prompt). Prompt-type hooks only
// work in the interactive REPL — in the desktop app / SDK harness they fail
// with "Prompt stop hooks are not yet supported outside REPL", so both were
// silently dead there (observed live 2026-08-18; also the source of the
// hook_error noise on startup/resume in transcript telemetry). A command hook
// printing that text through SessionStart additionalContext works on the one
// harness this hook is wired to (Claude only — it is declared in CLAUDE_ONLY_HOOKS
// and is absent from .codex/hooks.json; verified on the desktop harness 2026-08-18).
// Only the old PreCompact re-anchor's rules half was carried forward here (as
// COMPACT_REANCHOR, fired on source === "compact"), and not verbatim: the old
// prompt's "Always include these reminders:" connective became the "POST-COMPACT
// RULE RE-ANCHOR" header, .update/.delete gained parentheses, one semicolon became
// a period, and the "treat files changed before the compact as UNVERIFIED" rule is
// new here, with no ancestor in the old prompt. Otherwise the rules text is
// carried over byte-for-byte.
// The old prompt's other half — its opening summarizer instruction — was dropped
// with no replacement. Reasoning (not measured): additionalContext on a SessionStart
// source === "compact" fires after the compact has run, so it cannot shape the
// summary. The repo records no test of whether a PreCompact *command* hook could
// have carried that half.
//
// Branches on the SessionStart payload's `source`:
//   compact              → the money/idempotency/RLS re-anchor
//   startup/resume/clear → the onboarding reminder
//
// FAIL-OPEN: any error → emit nothing. A reminder must never brick a session.

import { readFileSync } from "node:fs";

function emit(text) {
  if (text) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
    }));
  }
  process.exit(0);
}

let payload = {};
try { payload = JSON.parse(readFileSync(0, "utf8")); } catch { emit(null); }

const source = String(payload?.source || "");

const COMPACT_REANCHOR =
  "POST-COMPACT RULE RE-ANCHOR (these must survive summarization): " +
  "idempotency_keys columns are idempotency_key/operation/result (jsonb, no ::text); " +
  "money = exact whole cents — new storage uses bigint cents, documented legacy PostgreSQL " +
  "numeric-dollar columns keep exact numeric math and whole-cent constraints once clean, and " +
  "authoritative TypeScript rejects amounts with more than two fractional digits or applies one " +
  "approved exact decimal rounding rule before converting to integer cents; parseDollarsToCents() " +
  "REFUSES more than two decimals by returning null (since 2026-09-03) — callers must check for " +
  "null and show MONEY_PRECISION_MESSAGE, never coerce null to 0 on a saved or authoritative " +
  "path (persisted, sent to an RPC, or gating/computing a saved amount); a display-only preview " +
  "may coerce with ?? 0 ONLY when the value never reaches a save AND the same field's save path " +
  "already refuses null by name — both halves, or it is a BLOCKER; " +
  "binary-floating-point rounding is prohibited for money; .update()/.delete() need " +
  "checkMutationResult; RPC usage needs assertRpcResult; SECURITY DEFINER functions need " +
  "SET search_path = public, pg_temp. Treat files changed before the compact as UNVERIFIED " +
  "unless the summary says they were run and observed. Mason has zero coding experience — " +
  "explain in plain English.";

const SESSION_ONBOARDING =
  "You are starting a new session on the CRX Manager project. Silently read AGENTS.md (the " +
  "shared contract) and CLAUDE.md (Claude-only routing), then load only the workflow and reference " +
  "documents that AGENTS.md routes for the current task. Briefly confirm context is loaded. " +
  "CRITICAL CONTEXT: Mason cannot read code or safely review a diff. Own routine technical choices, " +
  "and explain outcomes and risk in plain English. Before multi-file work or work touching data, money, " +
  "security, or a live system, get his approval after a short plan; then continue routine implementation " +
  "without repeated pauses. Every hard-gated live action listed in AGENTS.md—including each live migration, " +
  "Edge Function deployment, and data deletion—requires Mason's current approval immediately beforehand. " +
  "Only the armed hands-free migration path waives per-migration approval, never for a destructive migration. " +
  "Clearly identify the rare action or business decision only Mason can make.";

emit(source === "compact" ? COMPACT_REANCHOR : SESSION_ONBOARDING);
