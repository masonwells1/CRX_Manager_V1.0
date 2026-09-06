// Shared dangerous-command pattern table for bash-safety.mjs (Bash|PowerShell
// PreToolUse) AND mcp-tool-guard.mjs (Desktop Commander start_process /
// interact_with_process PreToolUse). Single source of truth so a fix landed in
// one hook is a fix landed in both — Desktop Commander's process tools can run
// the exact same shell commands bash-safety.mjs was built to catch, and until
// this file existed, routing a command through Desktop Commander instead of the
// Bash tool silently skipped every one of these checks (2026-07-13 audit finding).
//
// Behavior of the checks below is UNCHANGED from the original inline bash-safety.mjs
// table — this is a pure extraction, plus one net-new pattern (shell-redirect writes
// to .env, explicitly called for by the audit) and the npm-script-indirection helpers.
// 2026-09-05: the maintenance-producer check became a by-name rule (see below).

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// The producer was retired unapplied on 2026-09-05 (Mason's decision, PR #622).
// Its four exact invocations used to be allow-listed here because the script
// itself enforced the committed-blob and exact-head-proof checks; with the
// script gone those checks are gone too, so a replacement file at the same path
// must not be runnable through the old exact spellings. Every mention now fails
// closed.
const MAINTENANCE_PRODUCER_NAME = "apply-live-testdata-maintenance-20260812.mjs";

// ── maintenance producer: denied BY NAME (2026-09-05) ──────────────────────
// scripts/apply-live-testdata-maintenance-20260812.mjs was the one reviewed,
// blob-pinned tool allowed to rewrite three protected guard files. From
// 2026-08-12 to 2026-09-05 this file also carried a ~350-line "opaque invocation"
// classifier that refused ANY command whose executable or script could not be
// read from its text — `node -e`, `bash -c`, `python -c`, `| xargs`, heredocs,
// `$X` or `[ -f x ]` in executable position, PowerShell script blocks — on the
// theory that such a command MIGHT run the producer without naming it. Measured
// over the fortnight 2026-08-21..09-04 it fired 849 times; 59 of those named the
// producer. The 2026-08-31 decision (docs/manual/DECISION_LOG.md) recorded it as
// ineffective — `node runner.mjs` or `make x` execute the producer freely — and
// named its removal the next harness task. Removed here. What remains is exact:
//   • any spelling of the producer's name or of its approval token that survives
//     quote/slash/whitespace/escape stripping (no exact spelling is allowed
//     since the retirement);
//   • a JavaScript runtime (node/nodejs/bun/deno) whose SCRIPT argument cannot be
//     read from the text (`node "$F"`, `node scripts/$(…)`, `node scripts/appl?-…`),
//     because that is the one shape that runs a file whose name this rule cannot
//     check. Only a segment whose head word EXECUTES what follows (the runtime, a
//     shell, a transparent launcher) is inspected, so `rg -n 'node "$F"' docs` is
//     data. Arguments AFTER the script and inline code (`-e`/`-p`/stdin) are not
//     scanned: `node scripts/x.mjs "$SINCE"` and `node -e "…${x}…"` are ordinary.
// A nameless launch is bounded by the PR pipeline every guard-file change must
// pass, not by this rule: the producer that used to enforce its own argv, blob,
// and proof checks no longer exists. The generated Codex production guard
// (.codex/hooks/production-action-guard.mjs) keeps the full classifier,
// blob-pinned, for the Codex session that holds production credentials.
export function maintenanceProducerNamed(command) {
  const compact = String(command || "")
    .toLowerCase()
    .replace(/[\s\\/"'`^]/g, "");
  return compact.includes(MAINTENANCE_PRODUCER_NAME)
    || compact.includes("--approved-by-mason=");
}

// A shell escape that splits a WORD (`n^ode`, `n\`ode`, `n\\ode`) is the runtime's
// name once the shell has run; a bash backslash or PowerShell backtick before a
// newline joins the next line (a cmd caret is deliberately NOT joined: in
// PowerShell `^` ends nothing, so the next line is a new statement). Nothing
// else is normalized, so `$(`, `!x!`, `%x%`, a glob, or a bare backtick
// substitution stays visible to the computed-token test below.
function wordEscapeView(text) {
  return String(text || "")
    .replace(/[\\`]\r?\n/g, " ")
    .replace(/([A-Za-z])\^([A-Za-z])/g, "$1$2")
    .replace(/([A-Za-z])`([A-Za-z])/g, "$1$2")
    .replace(/([A-Za-z])\\([A-Za-z])/g, "$1$2");
}
const JS_RUNTIME_NAMES = new Set(["node", "nodejs", "bun", "deno"]);
// A segment is inspected only when its HEAD word executes what follows: the
// runtime itself, a shell that will parse its argument as a command line, or a
// transparent launcher that runs its trailing argv. Any other head — `echo`,
// `rg`, `git commit -m`, `Write-Output` — makes a later `node "$F"` data, which
// is what the old classifier's invocation-position rule established and what
// the quoted-data cases below pin.
const SEGMENT_HEADS_THAT_EXECUTE = new Set([
  "command", "exec", "env", "nohup", "nice", "ionice", "timeout", "setsid", "stdbuf", "sudo", "doas", "xargs", "parallel", "time",
  "bash", "sh", "dash", "zsh", "ksh", "fish", "pwsh", "powershell", "cmd",
]);
// A redirection glued to the runtime's name (`node</dev/null "$F"`) is still a
// launch of Node, so `<` and `>` end the name exactly as whitespace does
// (Codex App P2, PR #619).
const JS_RUNTIME_TOKEN_RE = /(?:^|[\s;&|(){}"'`@])(?:node|nodejs|bun|deno)(?:\.exe)?["']?(?=[\s<>]|$)/i;
// Shell expansion, substitution, glob, brace, and PowerShell sub-expression
// starts — a token carrying one names a file only at run time.
const COMPUTED_TOKEN_RE = /[$%!`*?\[\]{}(]/;
const INLINE_CODE_OPTION_RE = /^-(?:-eval|-print|-interactive|[A-Za-z]*[epi][A-Za-z]*)(?:=|$)/;
// Options whose VALUE is a file Node loads before the script runs. A computed
// value here is a computed script.
const VALUE_OPTION_RE = /^(?:-r|--require|--import|--preload|--loader|--experimental-loader|--conditions|-C)$/;
// A redirection word: `<x`, `>x`, `2>x`, `>&2`, or a bare operator whose target
// is the next word (`> out`).
const REDIRECTION_WORD_RE = /^\d*[<>]+/;
const BARE_REDIRECTION_OPERATOR_RE = /^\d*[<>]+$/;
function quotedWord(text) {
  return /^"[^"]*"$|^'[^']*'$/.test(text);
}
// Split a command line into the segments a shell would run, honouring quotes:
// a `;`, `&`, `|`, or newline inside quotes is data, so
// `rg -n 'foo | node "$F"' docs` is one segment headed by `rg`, and
// `bash -c 'echo a; node "$F"'` is one segment headed by `bash` (Codex App P2,
// PR #619). A backslash escapes the next character outside single quotes. An
// unterminated quote swallows the rest of the line, which is what the shell
// would refuse to run at all.
export function splitShellSegments(text) {
  const segments = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === "\\" && quote === '"' && index + 1 < text.length) {
        current += char + text[index + 1];
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === "\\" && index + 1 < text.length) {
      current += char + text[index + 1];
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    // `>&2`, `2>&1`, `<&0`, and `&>file` are redirections; every other `&`
    // (including both halves of `&&`) ends a segment.
    const redirectionAmpersand = char === "&"
      && (text[index - 1] === ">" || text[index - 1] === "<" || text[index + 1] === ">");
    if ((char === "&" && !redirectionAmpersand) || char === ";" || char === "|" || char === "\r" || char === "\n") {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments;
}
// Split one segment into the WORDS a shell would pass, honouring quotes: a
// quoted redirection target with whitespace (`node > "out file" "$F"`) is one
// word, so skipping the target cannot leave half of it (`file"`) looking like a
// literal script (Codex App P2 on 939c2d3cf, PR #619). Quotes stay in the word;
// a backslash outside single quotes keeps its next character in the word.
export function splitShellWords(text) {
  const words = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === "\\" && quote === '"' && index + 1 < text.length) {
        current += char + text[index + 1];
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === "\\" && index + 1 < text.length) {
      current += char + text[index + 1];
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) words.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}
function segmentHead(segment) {
  const words = splitShellWords(segment.replace(/^[\s({@&]+/, ""));
  let index = 0;
  // Leading assignments (`F=x node …`) and redirections (`</dev/null node …`,
  // `> "out file" node …`) precede the head word without changing it; a bare
  // operator's target is the next whole word.
  while (index < words.length) {
    const word = words[index];
    if (!/^[A-Za-z_]\w*=/.test(word) && !REDIRECTION_WORD_RE.test(word)) break;
    index += BARE_REDIRECTION_OPERATOR_RE.test(word) ? 2 : 1;
  }
  const token = (/^[^<>]+/.exec(words[index] || "") || [""])[0];
  return token.replace(/^\$?["']+|["']+$/g, "").split(/[\\/]/).pop().replace(/\.exe$/i, "").toLowerCase();
}
export function computedJavaScriptScriptArgument(command) {
  const view = wordEscapeView(command);
  for (const segment of splitShellSegments(view)) {
    const head = segmentHead(segment);
    if (!JS_RUNTIME_NAMES.has(head) && !SEGMENT_HEADS_THAT_EXECUTE.has(head)) continue;
    const match = JS_RUNTIME_TOKEN_RE.exec(segment);
    if (!match) continue;
    const bunOrDeno = /bun|deno/i.test(match[0]);
    const tokens = splitShellWords(segment.slice(match.index + match[0].length));
    for (let index = 0; index < tokens.length; index += 1) {
      const raw = tokens[index];
      const token = raw.replace(/^["']+|["']+$/g, "");
      if (!token || token === "--") continue;
      if (BARE_REDIRECTION_OPERATOR_RE.test(token)) {
        // `node > out "$F"`: the next word is the redirection's target, not the script.
        index += 1;
        continue;
      }
      if (REDIRECTION_WORD_RE.test(token)) continue;
      if (token === "-" || INLINE_CODE_OPTION_RE.test(token)) break;
      if (token.startsWith("-")) {
        const separator = token.indexOf("=");
        const name = separator === -1 ? token : token.slice(0, separator);
        const inlineValue = separator === -1 ? "" : raw.replace(/^["']+/, "").slice(separator + 1);
        // A computed option NAME (`--$OPT`) may be anything at run time.
        if (COMPUTED_TOKEN_RE.test(name)) return true;
        if (VALUE_OPTION_RE.test(name)) {
          const value = separator === -1 ? (tokens[index + 1] || "") : inlineValue;
          if (COMPUTED_TOKEN_RE.test(value.replace(/^["']+|["']+$/g, ""))) return true;
          if (separator === -1) index += 1;
          continue;
        }
        // Any other option keeps the parser moving toward the script argument
        // (`node --title="$TITLE" scripts/safe.mjs`; Codex App P2, PR #619) —
        // but only while its computed value is QUOTED. An unquoted expansion
        // (`--title=$X`, `--title=%X%`) can word-split into a script argument
        // the rule never read, so it is still a computed script.
        if (COMPUTED_TOKEN_RE.test(inlineValue) && !quotedWord(inlineValue) && !quotedWord(raw)) return true;
        continue;
      }
      if (bunOrDeno && /^(?:run|serve|task|x)$/i.test(token)) continue;
      if (COMPUTED_TOKEN_RE.test(token)) return true;
      break;
    }
  }
  return false;
}

export function checkMaintenanceProducerInvocation(command) {
  const value = String(command || "").trim();
  if (maintenanceProducerNamed(value)) {
    return "Blocked maintenance producer invocation. The 2026-08-12 maintenance producer was retired unapplied on 2026-09-05 and no invocation of that path is allowed; chaining, wrappers, substitutions, alternate spellings, and indirect writers are denied as before.";
  }
  if (computedJavaScriptScriptArgument(value)) {
    return "Blocked JavaScript runtime launch of a script whose path is computed at run time (node \"$F\", node scripts/$(...), a glob). The maintenance producer runs only by its exact reviewed command; spell the script path out.";
  }
  return null;
}

// Ordered [pattern, reason] checks. First match wins. Verbatim from the
// original bash-safety.mjs inline table (2026-07 extraction), plus one addition
// marked below.
export const DANGEROUS_CMD_CHECKS = [
  [/(?:^|[\r\n;&|])\s*(?:(?:export|set|setx)\s+|env(?:\s+(?:-\S+|[A-Za-z_]\w*=\S+))*\s+)?(?:[A-Za-z_]\w*=\S+\s+)*NODE_OPTIONS\s*=|\bnode(?:\.exe)?\b[^\r\n;&|]*(?:--require(?:=|\s)|(?:^|\s)-r(?:\s|\S)|--import(?:=|\s)|--(?:experimental-)?loader(?:=|\s))/i, "Blocked Node pre-execution loading. NODE_OPTIONS, require/import, and loader hooks can run code before a reviewed script's own safety checks."],
  // PowerShell and .NET spellings of the same pre-execution loading. They lived
  // in the removed opaque-invocation classifier and are kept because they are
  // SPECIFIC, not because they are opaque. Anchored to a statement start so the
  // same text quoted as search data (`rg -n 'Set-Item Env:NODE_OPTIONS' docs`)
  // stays a read.
  [/(?:^|[;&|(){}\r\n])\s*(?:set-item|si|new-item|ni|set-content|sc|add-content|ac|clear-item|cli|remove-item|ri)\s+[^\r\n;&|]*\benv:\\?node_options\b/i, "Blocked NODE_OPTIONS mutation through a PowerShell item cmdlet. NODE_OPTIONS can run code before a reviewed script's own safety checks."],
  [/(?:^|[;&|(){}\r\n])\s*\$env:node_options\s*\+?=/i, "Blocked assignment to $env:NODE_OPTIONS. NODE_OPTIONS can run code before a reviewed script's own safety checks."],
  [/(?:^|[;&|(){}\r\n])\s*\[(?:System\.)?Environment\]::SetEnvironmentVariable\s*\(\s*['"]node_options['"]/i, "Blocked .NET mutation of NODE_OPTIONS. NODE_OPTIONS can run code before a reviewed script's own safety checks."],
  [/\bgit\b[^\r\n;&|]*\bpush\b[^\r\n;&|]*(?:--force(?:-with-lease)?(?:=\S+)?\b|--force-if-includes\b|(?:^|\s)-[A-Za-z]*f[A-Za-z]*\b|(?:^|\s)\+\S+)/, "Blocked force push. Force pushing any branch requires Mason's explicit approval."],
  // Tolerate intervening git options (`git -C <path> reset --hard`, `git -c x=y clean -fd`)
  // — the adjacent-words-only spellings were bypassable (Codex P1, PR #352).
  [/\bgit\b[^\r\n;&|]*\breset\b[^\r\n;&|]*--hard\b/, "Blocked `git reset --hard`. Permanently destroys uncommitted work. Use `git stash` or `git restore <file>`."],
  // `-- .` separator form and long/split clean options covered too
  // (Codex P1 round 2, PR #352: `checkout -- .` and `clean --force -d` bypassed).
  // Terminator grammar includes redirects (`checkout -- . >/tmp/out`) —
  // CodeRabbit major, PR #352.
  [/\bgit\b[^\r\n;&|]*\bcheckout\b[^\r\n;&|]*\s(?:--\s+)?\.\s*(?:$|[;&|<>]|2>)/, "Blocked discard-all. Use targeted `git restore <file>`."],
  // `checkout -f/--force` throws away local modifications wholesale — gate the
  // force option independently of the `.` pathspec (Codex P1 round 4, PR #352).
  [/\bgit\b[^\r\n;&|]*\bcheckout\b[^\r\n;&|]*\s(?:--force\b|-[A-Za-z]*f[A-Za-z]*\b)/, "Blocked force checkout. It throws away local modifications. Use `git stash` first, or targeted `git restore <file>`."],
  // `git switch -f` / `--discard-changes` is the same discard through the newer
  // subcommand (Codex P1 round 5, PR #352). `switch -c <branch>` stays allowed.
  [/\bgit\b[^\r\n;&|]*\bswitch\b[^\r\n;&|]*\s(?:--discard-changes\b|--force\b|-[A-Za-z]*f[A-Za-z]*\b)/, "Blocked force switch. It throws away local modifications. Use `git stash` first, then a plain `git switch <branch>`."],
  [/\bgit\b[^\r\n;&|]*\brestore\b[^\r\n;&|]*\s(?:--\s+)?\.\s*(?:$|[;&|<>]|2>)/, "Blocked discard-all. Use targeted `git restore <file>`."],
  [/\bgit\b[^\r\n;&|]*\bclean\b[^\r\n;&|]*\s(?:--force\b|-[A-Za-z]*[fdx][A-Za-z]*\b)/, "Blocked `git clean -f`. Permanently deletes untracked files. Review with `git clean -n` first."],
  [/--no-verify\b/, "Blocked `--no-verify`. Pre-commit hooks prevent bugs — fix the underlying issue."],
  [/\brm\s+-[A-Za-z]*r[A-Za-z]*f?[A-Za-z]*\s+(?:\.\.?\s*(?:$|;|&|\|)|\.\.?\/(?:src|supabase|docs)(?:\b|\/)|\/?(?:src|supabase|docs)(?:\b|\/))/, "Blocked recursive deletion of project source/migrations/docs."],
  // Long/split option spellings of the same recursive delete — `rm --recursive
  // --force src`, `rm -r --force src` (Codex P1 round 4, PR #352). A lookahead
  // detects ANY recursive flag form, then the same protected targets apply.
  [/\brm\b(?=[^\r\n;&|]*(?:\s--recursive\b|\s-[A-Za-z]*[rR]))[^\r\n;&|]*\s(?:\.\.?\s*(?:$|;|&|\|)|\.\.?\/(?:src|supabase|docs)(?:\b|\/)|\/?(?:src|supabase|docs)(?:\b|\/))/, "Blocked recursive deletion of project source/migrations/docs."],
  [/\bnpm\s+uninstall\s+(?:react|@supabase\/supabase-js|vite|typescript)\b/, "Blocked uninstall of a core dependency."],
  [/git\s+add\s+[^&|;]*\.env(?:\b|$)/, "Blocked staging of .env. Secrets must never be committed."],
  // npx-OPTIONAL (2026-07-16 scaffolding review B1): the bare `supabase db push`
  // spelling — the one older skill docs printed — sailed past the npx-only pattern.
  // db push applies ALL pending local migrations to the linked (live) DB at once;
  // the sanctioned apply path is /migration-review → apply_migration.
  [/(?:npx\s+)?supabase\s+db\s+push\b/, "Blocked `supabase db push`. It applies ALL pending local migrations to the linked database at once, bypassing the migration-review gate. Apply through /migration-review → apply_migration instead."],
  [/npx\s+supabase\s+migration\s+repair\b/, "Blocked `supabase migration repair`. Causes migration history drift."],
  // `migration up` is the same live-apply bypass as `db push` under another name
  // (Codex review of the 2026-07-16 scaffolding audit caught the sibling spelling).
  [/(?:npx\s+)?supabase\s+migration\s+up\b/, "Blocked `supabase migration up`. Like `db push`, it applies pending local migrations outside the migration-review gate. Apply through /migration-review → apply_migration (or per-statement execute_sql for CONCURRENTLY files)."],
  [/(?:npx\s+)?supabase\s+db\s+reset\b/, "Blocked `supabase db reset`. This wipes the entire local Supabase DB and re-runs all 356 migrations from scratch — minutes of work plus loss of any local test data. If you really need to reset, run it manually in a terminal where you can see the warnings."],
  [/\b(?:dropdb|createdb)\b/, "Blocked `dropdb`/`createdb`. Destructive at the database level — if you need a fresh DB, do it via Supabase dashboard with explicit confirmation."],
  [/\bgit\s+branch\s+(?:-D|--delete\s+--force)\s+(?:main|master|production)\b/, "Blocked force-delete of main/master/production branch. Almost never the right move."],
  [/\bgit\b[^\r\n;&|]*\bpush\b[^\r\n;&|]*(?:--mirror|--prune|--all|--branches)\b/, "Blocked bulk `git push` mode (`--all`/`--branches`/`--mirror`/`--prune`). Use one explicit branch/refspec at a time."],
  [/\bgit\s+filter-(branch|repo)\b/, "Blocked `git filter-branch`/`filter-repo`. Rewrites entire repo history — destructive and slow."],
  // send-pack/receive-pack are the plumbing spellings of push — `git send-pack
  // --force` walked straight past the force-push guard (Codex P1 round 3, PR #352).
  // No workflow here ever needs the plumbing form; porcelain `git push` is the path.
  [/\bgit\b[^\r\n;&|]*\b(?:send-pack|receive-pack)\b/, "Blocked `git send-pack`/`receive-pack`. Use plain `git push` — the plumbing form bypasses the force-push guard."],
  [/\brm\s+-[A-Za-z]*r[A-Za-z]*f?[A-Za-z]*\s+\/(?!tmp|var\/tmp|c\/CRX_Manager\/\.playwright-mcp|c\/CRX_Manager\/\.claude\/worktrees)/, "Blocked `rm -rf /<path>` outside known-safe scratch areas. Use a more specific path."],
  [/\bnpm\s+run\s+(?:reset|nuke|wipe)\b/, "Blocked suspicious `npm run reset/nuke/wipe`. Verify what this script does first."],
  // NET-NEW (2026-07-13 mcp-tool-guard audit): shell-redirect writes to .env were
  // only blocked at `git add` time, never at write time — a plain `echo X > .env`
  // (or Desktop Commander running the same shell command) sailed through. This
  // closes that gap for BOTH bash-safety.mjs and mcp-tool-guard.mjs.
  // NOTE: `\s*` after the redirect, not `\s+` — `echo SECRET>.env` is valid shell
  // with NO space (Codex P2 2026-07-13 caught the whitespace-required bypass).
  // Tracked non-secret templates (.env.example/.template/.sample) stay allowed,
  // matching env-guard.mjs's exemptions (Codex P2 round 4).
  [/(?:>>?\s*|\btee\b\s+)['"]?[^\s'";|&]*\.env(?!(?:\.[\w-]+)*\.(?:example|template|sample)\b)(?:\.[\w-]+)?\b/, "Blocked shell-redirect write to .env*. Secrets must never be written this way."],
];

// Production-deploy spellings that must PROMPT (permissionDecision "ask"), not
// auto-approve — added for PR #352 (Codex P1): with a broad Bash allow in
// settings.json, prefix-matched ask rules miss variant spellings like
// `npx vercel --prod`. These are deterministic content checks instead.
// First match wins. Consumed by bash-safety.mjs; mcp-tool-guard.mjs's Desktop
// Commander paths already route deploy tools through the settings ask list.
export const ASK_CMD_CHECKS = [
  [/\b(?:npx\s+)?vercel\b[^\r\n;&|]*(?:--prod\b|--production\b|\bpromote\b|\brollback\b)/, "Production Vercel deploy/promote/rollback — needs Mason's explicit OK (AGENTS.md hard gate)."],
  [/\b(?:npx\s+)?supabase\s+functions\s+deploy\b/, "Edge-function deploy — needs Mason's explicit OK (AGENTS.md hard gate)."],
];

export function checkAskCommand(cmd) {
  const text = String(cmd || "");
  if (!text) return null;
  for (const [re, reason] of ASK_CMD_CHECKS) {
    if (re.test(text)) return reason;
  }
  return null;
}

// Destructive raw SQL via psql/supabase CLI (kept as its own exported check
// since the original file ran it as a second, independent condition).
export function checkDestructiveSql(cmd) {
  const text = String(cmd || "");
  if (/\b(?:DROP\s+TABLE|DROP\s+SCHEMA|TRUNCATE)\b/i.test(text) && /(psql|supabase\s+sql|--?c\s)/i.test(text)) {
    return "Blocked destructive SQL via psql/supabase. Add a migration instead.";
  }
  return null;
}

// Run raw text against the ordered pattern table + the destructive-SQL rule.
// Returns the FIRST matching reason, or null. This is the literal-command check
// only — no npm-script resolution (see checkCommandDeep for that).
export function checkDangerousCommand(cmd) {
  const text = String(cmd || "");
  if (!text) return null;
  const producerReason = checkMaintenanceProducerInvocation(text);
  if (producerReason) return producerReason;
  for (const [re, reason] of DANGEROUS_CMD_CHECKS) {
    if (re.test(text)) return reason;
  }
  return checkDestructiveSql(text);
}

// Bash-based modification of an EXISTING file under supabase/migrations/ (via
// output redirect, or sed/perl/awk -i). Returns a reason or null. Verbatim
// extraction of the original bash-safety.mjs logic.
const MIGRATION_MODIFY_RES = [
  /(?:>>?|2>&1\s*>>?)\s*['"]?([^\s'";|&<>]*supabase[\\/]migrations[\\/][^\s'";|&<>]+)/g,
  /(?:sed|perl|awk)\s+-[A-Za-z]*i[A-Za-z]*\b[^|;&]*?([^\s'";|&<>]*supabase[\\/]migrations[\\/][^\s'";|&<>]+)/g,
];

export function checkMigrationModify(cmd, cwd) {
  const text = String(cmd || "");
  if (!text) return null;
  const base = cwd || process.cwd();
  for (const re of MIGRATION_MODIFY_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const target = m[1].replace(/^['"]|['"]$/g, "");
      const abs = path.isAbsolute(target) ? target : path.resolve(base, target);
      try {
        if (existsSync(abs)) {
          return `Blocked modification of existing migration file: ${target}. Existing migrations must never be edited — create a NEW migration that supersedes it.`;
        }
      } catch { /* ignore, fail open on this one path */ }
    }
  }
  return null;
}

// ── npm-script indirection (FIX 2, 2026-07-13) ──────────────────────────────
// `npm run foo` can hide an arbitrary dangerous command inside package.json's
// scripts.foo, which the literal-command regex table above never sees. Resolve
// the script's body text (recursing into scripts IT calls, max depth 3) and run
// the same checks against the resolved text too.

export function extractNpmRunNames(cmd) {
  const names = [];
  // Accepts valid npm variants (Codex P1 2026-07-13 round 3): options before
  // and after the subcommand (`npm -s run x`, `npm run --silent x`) and the
  // `run-script` alias — option tokens must not be mistaken for script names.
  const re = /\bnpm\s+(?:-{1,2}[\w-]+(?:=\S+)?\s+)*(?:run|run-script)\s+(?:-{1,2}[\w-]+(?:=\S+)?\s+)*([\w:.-]+)/g;
  let m;
  const text = String(cmd || "");
  while ((m = re.exec(text)) !== null) names.push(m[1]);
  return names;
}

// Resolve one script name to an array of script-body texts: itself, plus every
// script reachable via `npm run X` inside it, up to maxDepth levels, with a
// `seen` set so a cyclical script graph can't recurse forever.
export function resolveNpmScriptChain(scripts, name, depth = 0, maxDepth = 3, seen = new Set()) {
  if (depth > maxDepth || !scripts || typeof scripts !== "object") return [];
  if (seen.has(name)) return [];
  seen.add(name);
  const out = [];
  const text = scripts[name];
  if (typeof text === "string") {
    out.push(text);
    for (const nested of extractNpmRunNames(text)) {
      out.push(...resolveNpmScriptChain(scripts, nested, depth + 1, maxDepth, seen));
    }
  }
  // npm auto-runs pre<name>/post<name> around any script — a dangerous command
  // hidden there rides along with an innocent `npm run <name>` (Codex P1
  // 2026-07-13 round 4). Resolve them even when scripts[name] itself is absent.
  for (const lifecycle of [`pre${name}`, `post${name}`]) {
    if (typeof scripts[lifecycle] === "string") {
      out.push(...resolveNpmScriptChain(scripts, lifecycle, depth + 1, maxDepth, seen));
    }
  }
  return out;
}

// Read package.json's `scripts` map from `cwd`. Returns null (never throws) if
// the file is unreadable or unparsable — callers MUST warn-and-allow (skip the
// script-body check, do not block) in that case; a broken/missing package.json
// must never brick the hook.
export function readPackageScripts(cwd) {
  try {
    const raw = readFileSync(path.join(cwd || process.cwd(), "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.scripts === "object" && parsed.scripts !== null ? parsed.scripts : {};
  } catch {
    return null;
  }
}

// The full command check used by both hooks: literal command text first, then
// (only if clean) every `npm run X` target's resolved script body, recursively.
// Returns the first matching reason, or null.
export function checkCommandDeep(cmd, cwd) {
  const direct = checkDangerousCommand(cmd);
  if (direct) return direct;

  const names = extractNpmRunNames(cmd);
  if (names.length === 0) return null;

  const scripts = readPackageScripts(cwd);
  if (scripts === null) {
    // FAIL-OPEN, but loud: package.json missing/unparsable — skip the resolved-
    // script check rather than block or crash.
    process.stderr.write("bash-safety-lib: could not read/parse package.json — skipping npm-script-body check (warn-and-allow)\n");
    return null;
  }

  const seen = new Set();
  for (const name of names) {
    for (const resolved of resolveNpmScriptChain(scripts, name, 0, 3, seen)) {
      if (maintenanceProducerNamed(resolved) || computedJavaScriptScriptArgument(resolved)) {
        return "Blocked indirect maintenance producer invocation. Run the exact repository-relative node command directly; npm scripts and lifecycle wrappers are denied.";
      }
      // Run BOTH check families on the resolved body — a script that rewrites an
      // existing migration is as dangerous as one that force-pushes (Codex P1
      // 2026-07-13: only checkDangerousCommand ran here, so npm indirection
      // still bypassed the migration-immutability guard).
      const reason = checkDangerousCommand(resolved) || checkMigrationModify(resolved, cwd);
      if (reason) return `${reason} (found inside \`npm run ${name}\`'s script body)`;
    }
  }
  return null;
}

// Ask-tier twin of checkCommandDeep: literal text first, then resolved npm-script
// bodies, so `npm run deploy-prod` can't hide a production deploy either.
export function checkAskDeep(cmd, cwd) {
  const direct = checkAskCommand(cmd);
  if (direct) return direct;

  const names = extractNpmRunNames(cmd);
  if (names.length === 0) return null;
  const scripts = readPackageScripts(cwd);
  if (scripts === null) return null;

  const seen = new Set();
  for (const name of names) {
    for (const resolved of resolveNpmScriptChain(scripts, name, 0, 3, seen)) {
      const reason = checkAskCommand(resolved);
      if (reason) return `${reason} (found inside \`npm run ${name}\`'s script body)`;
    }
  }
  return null;
}

export { MIGRATION_MODIFY_RES };
