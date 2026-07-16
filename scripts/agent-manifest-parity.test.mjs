#!/usr/bin/env node
// Tests for the hook-manifest parity logic (scripts/agent-manifest-parity.mjs)
// and a live check that the real two manifests are in parity.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractClaudeHookRefs,
  hookManifestParity,
  CLAUDE_ONLY_HOOKS,
  CODEX_ONLY_HOOKS,
} from "./agent-manifest-parity.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); pass++; };

// ── extractClaudeHookRefs ────────────────────────────────────────────────────
eq([...extractClaudeHookRefs('node ".../.claude/hooks/sql-safety.mjs"')], ["sql-safety.mjs"], "extracts a POSIX-style ref");
// One backslash per separator (source '\\' === one backslash in the string).
eq([...extractClaudeHookRefs("node \".claude\\hooks\\bash-safety.mjs\"")], ["bash-safety.mjs"], "extracts a single-backslash Windows-style ref");
eq([...extractClaudeHookRefs("no hooks here")], [], "no refs → empty set");
eq(new Set(extractClaudeHookRefs("a/.claude/hooks/x.mjs b/.claude/hooks/x.mjs")).size, 1, "dedupes repeats");

// ── hookManifestParity: symmetric, allowlist-aware ──────────────────────────
eq(hookManifestParity({ claudeHooks: ["a.mjs", "b.mjs"], codexHooks: ["a.mjs", "b.mjs"] }).ok, true, "identical sets → parity");

let r = hookManifestParity({ claudeHooks: ["a.mjs", "new.mjs"], codexHooks: ["a.mjs"] });
eq(r.ok, false, "a NEW Claude-only hook (undeclared) breaks parity");
eq(r.claudeOnlyUnexpected, ["new.mjs"], "names the undeclared Claude-only hook");

r = hookManifestParity({ claudeHooks: ["a.mjs", "new.mjs"], codexHooks: ["a.mjs"], claudeOnly: new Set(["new.mjs"]) });
eq(r.ok, true, "declaring it Claude-only restores parity");

r = hookManifestParity({ claudeHooks: ["a.mjs"], codexHooks: ["a.mjs", "codexnew.mjs"] });
eq(r.ok, false, "a NEW Codex-only hook (undeclared) breaks parity");
eq(r.codexOnlyUnexpected, ["codexnew.mjs"], "names the undeclared Codex-only hook");

r = hookManifestParity({ claudeHooks: ["a.mjs"], codexHooks: ["a.mjs", "codexnew.mjs"], codexOnly: new Set(["codexnew.mjs"]) });
eq(r.ok, true, "declaring it Codex-only restores parity");

// ── LIVE: the real manifests must be in parity under the shipped allowlists ──
const settings = readFileSync(path.join(ROOT, ".claude", "settings.json"), "utf8");
const codexHooksJson = readFileSync(path.join(ROOT, ".codex", "hooks.json"), "utf8");
const live = hookManifestParity({
  claudeHooks: extractClaudeHookRefs(settings),
  codexHooks: extractClaudeHookRefs(codexHooksJson),
});
ok(live.ok, `LIVE manifests must be in parity — unexpected claudeOnly=[${live.claudeOnlyUnexpected}] codexOnly=[${live.codexOnlyUnexpected}]`);

// Every allowlisted hook must ACTUALLY be one-sided in the live manifests —
// otherwise the allowlist entry is stale and should be removed.
const claudeSet = extractClaudeHookRefs(settings);
const codexSet = extractClaudeHookRefs(codexHooksJson);
for (const h of CLAUDE_ONLY_HOOKS) {
  ok(claudeSet.has(h) && !codexSet.has(h), `CLAUDE_ONLY allowlist entry "${h}" is genuinely Claude-only in the live manifests (else remove it)`);
}
for (const h of CODEX_ONLY_HOOKS) {
  ok(codexSet.has(h) && !claudeSet.has(h), `CODEX_ONLY allowlist entry "${h}" is genuinely Codex-only in the live manifests`);
}

console.log(`agent-manifest-parity: ${pass} assertions passed`);
