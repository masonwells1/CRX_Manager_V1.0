#!/usr/bin/env node
// Claude Code usage report — where the tokens went, from the transcripts on this PC.
//
//   node scripts/claude-usage-report.mjs                 # last 14 days, ending now
//   node scripts/claude-usage-report.mjs --days 30
//   node scripts/claude-usage-report.mjs --start 2026-08-21 --end 2026-09-04
//   node scripts/claude-usage-report.mjs --titles        # include the first prompt of each top session
//   node scripts/claude-usage-report.mjs --denials out.json   # write the refused tool calls for adjudication
//   node scripts/claude-usage-report.mjs --root <dir>    # transcript root (default ~/.claude/projects)
//
// READ-ONLY, with one declared exception: --denials <path> writes the refused tool calls (tool name,
// the command or path that was refused, the guard's reason) to a NEW file so they can be adjudicated.
// It refuses to overwrite an existing file. That output quotes command text verbatim — it is the
// subject of the audit, so it is not redacted — which is why it belongs in a scratchpad, never in
// the repository: a destination inside ANY git checkout (a `.git` entry somewhere above it) is
// refused before anything is written (Codex App review of #613). Nothing is sent anywhere, and no
// prompt text is printed unless --titles is passed.
//
// Method (each rule answers a finding from the gpt-6-astra adversarial review, 2026-09-04):
//  - events are filtered by their OWN `timestamp` inside an explicit [start, end) window; a
//    transcript's modification time only decides whether the file is opened at all;
//  - one API response = one usage record: records are grouped by message.id and the first record
//    that carries a usage object wins, so a split response is never counted twice and a record
//    without usage never shadows one that has it;
//  - tool calls are deduplicated by tool_use id and tool results by tool_use_id;
//  - synthetic / zero-usage assistant records are counted in diagnostics, never as calls;
//  - human prompts exclude compaction summaries, meta lines, and machine envelopes — the envelope
//    list is the hooks' own (`isMachineGenerated` in .claude/hooks/prompt-source-lib.mjs) plus the
//    desktop app's <ci-monitor-event>, so a scheduled-task or heartbeat record is never counted as
//    a prompt Mason typed, nor shown as a session title under --titles (Codex App review of #613);
//  - main and subagent transcripts are tracked separately on the session record, and the global
//    human-prompt total counts main transcripts only — a subagent's opening task was written by
//    its parent agent (Codex App review of #613);
//  - parse failures, missing timestamps, and out-of-window records are reported, not dropped silently;
//  - hook denials are attributed to the exact tool_use they answered.
//
// The "weighted share" line uses Anthropic's published price RATIOS (cache read 0.1x base input,
// cache write 1.25x, output 5x). It ranks the cost buckets; it is not a dollar figure and it does
// not account for per-model base prices or a subscription allowance.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { authoredByMason, isMachineGenerated } from "../.claude/hooks/prompt-source-lib.mjs";

const args = process.argv.slice(2);
const opt = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const has = (flag) => args.includes(flag);

const root = opt("--root", path.join(os.homedir(), ".claude", "projects"));
const end = args.includes("--end") ? Date.parse(opt("--end")) : Date.now();
const days = Number(opt("--days", "14")) || 14;
const start = args.includes("--start") ? Date.parse(opt("--start")) : end - days * 864e5;
const showTitles = has("--titles");
const denialsOut = opt("--denials", "");
if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
  console.error("Bad window: --start must be before --end (ISO dates).");
  process.exit(2);
}
if (!fs.existsSync(root)) {
  console.error(`Transcript root not found: ${root}`);
  process.exit(2);
}

const files = [];
for (const dir of fs.readdirSync(root)) {
  const p = path.join(root, dir);
  let st; try { st = fs.statSync(p); } catch { continue; }
  if (!st.isDirectory()) continue;
  for (const f of fs.readdirSync(p)) {
    const fp = path.join(p, f);
    let fst; try { fst = fs.statSync(fp); } catch { continue; }
    if (fst.isDirectory()) {
      const sub = path.join(fp, "subagents");
      if (fs.existsSync(sub)) for (const g of fs.readdirSync(sub)) {
        if (!g.endsWith(".jsonl")) continue;
        const subFp = path.join(sub, g);
        let subSt; try { subSt = fs.statSync(subFp); } catch { continue; }
        if (subSt.mtimeMs < start) continue; // same window pre-filter as the main transcripts (CodeRabbit, PR #613)
        files.push({ fp: subFp, dir, sub: true });
      }
      continue;
    }
    if (!f.endsWith(".jsonl")) continue;
    if (fst.mtimeMs < start) continue; // cannot hold in-window events
    files.push({ fp, dir, sub: false });
  }
}

const diag = { files: files.length, lines: 0, parseFail: 0, noTimestamp: 0, outOfWindow: 0, dupUsageDisagree: 0, syntheticOrZero: 0, unpairedDenials: 0 };
const byModel = {};
const sessions = new Map();
const callBuckets = { "<100k": 0, "100-200k": 0, "200-400k": 0, "400-600k": 0, ">600k": 0 };
const bucketTok = { "<100k": 0, "100-200k": 0, "200-400k": 0, "400-600k": 0, ">600k": 0 };
const toolCounts = {};
const toolById = new Map();
const seenToolUse = new Set();
const seenToolResult = new Set();
const denied = [];
const denialKinds = { "review-proof": 0, "maintenance-producer": 0, "hold-latch": 0, "other-hook": 0 };
let humanPrompts = 0, apiCalls = 0;
const projectOf = (dir) => /crx/i.test(dir) ? "CRX" : /farmrx/i.test(dir) ? "FarmRx" : "other";
const bucketOf = (ctx) => ctx < 1e5 ? "<100k" : ctx < 2e5 ? "100-200k" : ctx < 4e5 ? "200-400k" : ctx < 6e5 ? "400-600k" : ">600k";
// Machine envelopes: the hook library's list (task-notification, scheduled-task, system-reminder,
// local-command-caveat, command-name, local-command-stdout, heartbeat — anywhere in the text or as
// the opening tag) plus the desktop app's CI monitor event, which the hooks do not carry.
const CI_MONITOR_ENVELOPE_RE = /^\s*<ci-monitor-event\b/i;
const isEnvelope = (text) => isMachineGenerated(text) || CI_MONITOR_ENVELOPE_RE.test(text);
// A peer session's <cross-session-message> is deliberately NOT a machine envelope
// in the hooks (a sibling agent chose those words), but it is not a prompt Mason
// typed either. `authoredByMason` strips peer blocks (and fenced/inline code and
// quoted lines) and keeps what he wrote around them; a record whose authored
// remainder is empty is not counted, and the title comes from that remainder so a
// peer block never becomes the session title under --titles (Codex App, PR #613).
const PEER_ENVELOPE_RE = /<cross-session-message\b/i;
const masonWords = (text) => {
  if (isEnvelope(text)) return "";
  const authored = authoredByMason(text).replace(/\s+/g, " ").trim();
  if (authored) return authored;
  return PEER_ENVELOPE_RE.test(text) ? "" : text;
};

function session(f) {
  const id = path.basename(f.fp, ".jsonl");
  if (!sessions.has(id)) sessions.set(id, { id, dir: f.dir, sub: f.sub, calls: 0, cacheRead: 0, cacheWrite: 0, in: 0, out: 0, prompts: 0, tools: 0, maxCtx: 0, denials: 0, title: "" });
  return sessions.get(id);
}

for (const f of files) {
  const s = session(f);
  const usageByMsg = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(f.fp) });
  for await (const line of rl) {
    diag.lines++;
    let o; try { o = JSON.parse(line); } catch { diag.parseFail++; continue; }
    const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
    if (Number.isNaN(ts)) { diag.noTimestamp++; continue; }
    if (ts < start || ts >= end) { diag.outOfWindow++; continue; }

    if (o.type === "user" && o.message) {
      const c = o.message.content;
      const isHuman = !o.isMeta && !o.isCompactSummary && !o.isVisibleInTranscriptOnly;
      // A subagent transcript's first user record is the task its parent agent wrote, not a
      // prompt Mason typed: it stays on the subagent's own session record (prompts, title) but
      // never enters the global human-prompt total (Codex App review of #613).
      const noteHuman = (text) => { if (!f.sub) humanPrompts++; s.prompts++; if (!s.title) s.title = text.slice(0, 80).replace(/\s+/g, " "); };
      if (typeof c === "string") {
        const words = isHuman ? masonWords(c) : "";
        if (words) noteHuman(words);
      } else if (Array.isArray(c)) {
        let text = "";
        for (const part of c) {
          if (part.type === "text") text += part.text || "";
          if (part.type === "tool_result") {
            const rid = part.tool_use_id;
            if (rid && seenToolResult.has(rid)) continue;
            if (rid) seenToolResult.add(rid);
            const txt = typeof part.content === "string" ? part.content : JSON.stringify(part.content || "");
            const head = txt.slice(0, 400);
            let kind = null;
            if (/REVIEW PROOF GUARD/.test(head)) kind = "review-proof";
            else if (/Blocked (?:indirect )?maintenance producer/.test(head)) kind = "maintenance-producer";
            else if (/HOLD LATCH|hold-latch|HOLD is latched/i.test(head)) kind = "hold-latch";
            else if (part.is_error && /\b(?:hook|guard)\b/i.test(head) && /\b(?:denied|blocked|refus)/i.test(head)) kind = "other-hook";
            if (kind) {
              // Count a denial only when its tool_use is in the window too: the rate's
              // denominator is in-window unique tool calls, so a result whose call fell
              // before `start` would inflate the numerator alone (CodeRabbit, PR #613).
              const tu = toolById.get(rid);
              if (!tu) { diag.unpairedDenials++; continue; }
              denialKinds[kind]++; s.denials++;
              denied.push({ kind, tool: tu.name || "?", command: tu.command || "", session: s.id.slice(0, 8), msg: head.slice(0, 160) });
            }
          }
        }
        const words = text && isHuman ? masonWords(text) : "";
        if (words) noteHuman(words);
      }
    }

    if (o.type === "assistant" && o.message) {
      const m = o.message.model || "unknown";
      const mid = o.message.id || o.uuid;
      for (const part of (o.message.content || [])) {
        if (part.type === "tool_use" && part.id && !seenToolUse.has(part.id)) {
          seenToolUse.add(part.id);
          toolCounts[part.name] = (toolCounts[part.name] || 0) + 1; s.tools++;
          const inp = part.input || {};
          toolById.set(part.id, { name: part.name, command: String(inp.command || inp.pattern || inp.file_path || inp.path || "").slice(0, 300) });
        }
      }
      const u = o.message.usage;
      const total = u ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0) : 0;
      if (!u || total === 0 || m === "<synthetic>") { if (u && total === 0) diag.syntheticOrZero++; continue; }
      if (usageByMsg.has(mid)) {
        const prev = usageByMsg.get(mid);
        if (prev.input_tokens !== u.input_tokens || prev.output_tokens !== u.output_tokens) diag.dupUsageDisagree++;
        continue;
      }
      usageByMsg.set(mid, u);
      apiCalls++;
      const b = (byModel[m] ||= { calls: 0, in: 0, cacheRead: 0, cacheWrite: 0, out: 0 });
      b.calls++; b.in += u.input_tokens || 0; b.cacheRead += u.cache_read_input_tokens || 0; b.cacheWrite += u.cache_creation_input_tokens || 0; b.out += u.output_tokens || 0;
      s.calls++; s.in += u.input_tokens || 0; s.cacheRead += u.cache_read_input_tokens || 0; s.cacheWrite += u.cache_creation_input_tokens || 0; s.out += u.output_tokens || 0;
      const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (ctx > s.maxCtx) s.maxCtx = ctx;
      const bk = bucketOf(ctx); callBuckets[bk]++; bucketTok[bk] += ctx;
    }
  }
}

const fmt = (n) => Math.round(n).toLocaleString("en-US");
const all = [...sessions.values()].filter((s) => s.calls > 0 || s.prompts > 0);
const mains = all.filter((s) => !s.sub), subs = all.filter((s) => s.sub);
const tot = Object.values(byModel).reduce((a, b) => ({ in: a.in + b.in, cr: a.cr + b.cacheRead, cw: a.cw + b.cacheWrite, out: a.out + b.out }), { in: 0, cr: 0, cw: 0, out: 0 });
const W = { in: 1, cr: 0.1, cw: 1.25, out: 5 };
const weighted = { in: tot.in * W.in, cr: tot.cr * W.cr, cw: tot.cw * W.cw, out: tot.out * W.out };
const wsum = (weighted.in + weighted.cr + weighted.cw + weighted.out) || 1;
const pct = (n, d) => (100 * n / (d || 1)).toFixed(1);

console.log(`Claude usage report — window ${new Date(start).toISOString()} .. ${new Date(end).toISOString()} (events filtered by their own timestamp)`);
console.log(`transcript root: ${root}`);
console.log(`diagnostics: ${JSON.stringify(diag)}`);
console.log(`main sessions ${mains.length} | subagent transcripts ${subs.length} | human prompts ${fmt(humanPrompts)} | API calls ${fmt(apiCalls)} | unique tool calls ${fmt(seenToolUse.size)}`);
console.log(`\n== tokens (all models) ==\nfresh-in ${fmt(tot.in)} | cache-read ${fmt(tot.cr)} | cache-write ${fmt(tot.cw)} | out ${fmt(tot.out)} | avg context/call ${fmt((tot.in + tot.cr + tot.cw) / (apiCalls || 1))}`);
console.log(`weighted share (in 1x, cache-read 0.1x, cache-write 1.25x, out 5x): cache-read ${pct(weighted.cr, wsum)}% | cache-write ${pct(weighted.cw, wsum)}% | out ${pct(weighted.out, wsum)}% | fresh ${pct(weighted.in, wsum)}%`);
console.log("\n== by model ==");
for (const [m, b] of Object.entries(byModel).sort((a, b) => b[1].cacheRead - a[1].cacheRead)) console.log(`${m.padEnd(20)} calls ${fmt(b.calls).padStart(7)} | cache-read ${fmt(b.cacheRead).padStart(15)} | cache-write ${fmt(b.cacheWrite).padStart(12)} | out ${fmt(b.out).padStart(11)}`);
console.log("\n== API calls by context at call time ==");
const callsSum = Object.values(callBuckets).reduce((a, b) => a + b, 0), tokSum = Object.values(bucketTok).reduce((a, b) => a + b, 0);
for (const k of Object.keys(callBuckets)) console.log(`${k.padEnd(9)} calls ${fmt(callBuckets[k]).padStart(7)} (${pct(callBuckets[k], callsSum).padStart(5)}%) | context tokens ${fmt(bucketTok[k]).padStart(15)} (${pct(bucketTok[k], tokSum).padStart(5)}%)`);
const byProj = {};
for (const s of all) { const p = (byProj[projectOf(s.dir)] ||= { calls: 0, cacheRead: 0, out: 0 }); p.calls += s.calls; p.cacheRead += s.cacheRead; p.out += s.out; }
console.log("\n== by project ==", JSON.stringify(byProj));
console.log("== subagent share ==", JSON.stringify(subs.reduce((a, s) => ({ calls: a.calls + s.calls, cacheRead: a.cacheRead + s.cacheRead, out: a.out + s.out }), { calls: 0, cacheRead: 0, out: 0 })));
console.log("\n== hook denials (attributed to unique tool calls) ==", JSON.stringify(denialKinds), `total ${denied.length} = ${(100 * denied.length / (seenToolUse.size || 1)).toFixed(2)}% of unique tool calls`);
const denialTools = {}; for (const d of denied) denialTools[d.tool] = (denialTools[d.tool] || 0) + 1;
console.log("denied by tool:", JSON.stringify(denialTools));
console.log("\n== top tools ==");
for (const [k, v] of Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`${String(v).padStart(6)}  ${k}`);
console.log("\n== main sessions: peak-context distribution ==");
const dist = { "<100k": 0, "100-200k": 0, "200-400k": 0, "400-600k": 0, ">600k": 0 };
for (const s of mains) dist[bucketOf(s.maxCtx)]++;
console.log(JSON.stringify(dist), `| main sessions with <=2 human prompts: ${mains.filter((s) => s.prompts <= 2).length}`);
console.log("\n== top 12 main sessions by context re-read (cache-read) ==");
for (const s of [...mains].sort((a, b) => b.cacheRead - a.cacheRead).slice(0, 12)) {
  console.log(`${s.id.slice(0, 8)} calls ${String(s.calls).padStart(5)} tools ${String(s.tools).padStart(5)} prompts ${String(s.prompts).padStart(4)} peak ${fmt(s.maxCtx).padStart(8)} cacheRead ${fmt(s.cacheRead).padStart(14)} out ${fmt(s.out).padStart(10)} denials ${String(s.denials).padStart(3)}${showTitles ? ` | ${s.title}` : ""}`);
}
if (denialsOut) {
  // The export quotes refused command text verbatim. Inside a git checkout a later broad
  // `git add` would commit it, so any destination with a `.git` entry somewhere above it is
  // refused — decided by that shape, not by this checkout's name, so a sibling worktree or an
  // unrelated repository is refused the same way (Codex App review of #613 at 1097d85e6).
  // The walk runs over the REAL location as well as the spelled one: a parent that is a
  // symlink or junction into a checkout (`/tmp/export -> <repo>/docs`) keeps the spelled chain
  // clear of `.git` while the file lands inside the repository (Codex App review of #613 at
  // 18c2faf17). The nearest existing ancestor is canonicalised with realpath, the missing tail
  // re-attached, and BOTH chains are walked; either one reaching `.git` refuses.
  const destination = path.resolve(denialsOut);
  const checkoutRootAbove = (file) => {
    let probe = path.dirname(file);
    for (;;) {
      if (fs.existsSync(path.join(probe, ".git"))) return probe;
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  };
  const realDestination = (() => {
    let existing = path.dirname(destination);
    const missing = [path.basename(destination)];
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) return destination;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
    try { return path.join(fs.realpathSync.native(existing), ...missing); } catch { return destination; }
  })();
  const checkoutRoot = checkoutRootAbove(realDestination) ?? checkoutRootAbove(destination);
  if (checkoutRoot != null) {
    console.error(`\n--denials refuses to write inside a git checkout (${checkoutRoot}): the export quotes refused command text verbatim and must not be committable. Write it under a scratch directory instead.`);
    process.exit(2);
  }
  if (fs.existsSync(denialsOut)) {
    console.error(`\n--denials refuses to overwrite an existing file: ${denialsOut} (pick a new path)`);
    process.exit(1);
  }
  fs.writeFileSync(denialsOut, JSON.stringify(denied, null, 1), { flag: "wx" });
  console.log(`\nwrote ${denied.length} denied tool calls to ${denialsOut}`);
}
