#!/usr/bin/env node
// SessionStart hook: inject the project context reminders as additionalContext.
//
// Replaces two former `"type": "prompt"` hooks (the PreCompact money/RLS
// re-anchor and the SessionStart onboarding prompt). Prompt-type hooks only
// work in the interactive REPL — in the desktop app / SDK harness they fail
// with "Prompt stop hooks are not yet supported outside REPL", so both were
// silently dead there (observed live 2026-08-18; also the source of the
// hook_error noise on startup/resume in transcript telemetry). A command hook
// printing the same text through SessionStart additionalContext works in every
// harness, and landing the money rules AFTER the compact is equivalent to
// steering the summarizer: the rules are for future behavior, not the summary.
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
  "currently truncates excess precision and is insufficient without that validation; " +
  "binary-floating-point rounding is prohibited for money; .update()/.delete() need " +
  "checkMutationResult; RPC usage needs assertRpcResult; SECURITY DEFINER functions need " +
  "SET search_path = public, pg_temp. Treat files changed before the compact as UNVERIFIED " +
  "unless the summary says they were run and observed. Mason has zero coding experience — " +
  "explain in plain English.";

const SESSION_ONBOARDING =
  "You are starting a new session on the CRX Manager project. Silently read AGENTS.md (the " +
  "shared contract), CLAUDE.md (Claude-only routing), and docs/workflows/SAFE_DEVELOPMENT_RULES.md, " +
  "then briefly confirm context is loaded. CRITICAL CONTEXT: Mason has ZERO coding experience — " +
  "always explain in plain English; show a plan and wait for approval before multi-file or risky " +
  "edits; never assume he knows code terminology.";

emit(source === "compact" ? COMPACT_REANCHOR : SESSION_ONBOARDING);
