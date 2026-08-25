#!/usr/bin/env node
// Patrol collector — READ-ONLY. Emits one snapshot per run.
//
// Every request here is a read: `gh api` GETs and `git` queries that do not mutate.
// There is no write action in this file, so there is nothing to bypass.
//
// Source status is the load-bearing idea. Each source reports OK / INCOMPLETE / ERROR
// with counts. A source that failed emits an explicit SCAN_ERROR item downstream, so an
// empty list from a broken source can never be mistaken for a genuinely empty list.
// `complete` covers the REQUIRED sources; a failed optional source still blocks the
// all-clear (via its SCAN_ERROR item) but lets the rest of the report render.
//
// v1 LIMITATIONS, declared rather than papered over:
//   - Sol proof state is not evaluated (`solProof: "unknown"`), so patrol never claims a
//     PR is missing one. Reading the proof registry is deliberately left to the existing
//     validator, which is the only thing entitled to judge it.
//   - parkedMigrations and gateHealth are not implemented; they report INCOMPLETE, which
//     surfaces as a visible "could not determine" item and suppresses the all-clear.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MIN_STABLE_INTERVAL_MS, SNAPSHOT_TTL_MS } from "./patrol-classify.mjs";
import { collectLoops, collectParkedMigrations, collectGateHealth } from "./patrol-sources.mjs";
import { git as trustedGit, gh as trustedGh, worktreeFilterRisk } from "./trusted-exec.mjs";

const SCHEMA_VERSION = 1;
const CODERABBIT_CONTEXT = "CodeRabbit";
const CODERABBIT_CREATOR_ID = 136622811; // coderabbitai[bot]; identity, not just a name
const STATE_DIR = path.join(process.env.LOCALAPPDATA || process.env.TMPDIR || ".", "crx-patrol");
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

// Fixed trusted executables and a minimal environment — see trusted-exec.mjs. Patrol runs
// unattended on a schedule, so PATH-resolved binaries and inherited Git configuration are
// an ambient-code path, not a convenience.
function ghJson(argv) { return JSON.parse(trustedGh(argv) || "null"); }
function git(argv, cwd) { return trustedGit(["-C", cwd, ...argv]).trim(); }
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ── required checks: union of branch protection AND every active ruleset ────
// Resolving from branch protection alone is not enough — this repo's `protect-main`
// ruleset requires a Vercel check that protection does not list. Missing it would let a
// PR read as green when a required check had not run.
//
// The expected PRODUCER travels with each context. Matching a required check by name
// alone means any integration with status-write access can post a lookalike success and
// make patrol report green — the actor-forgery shape CRX treats as a red line.
function requiredContexts(repo, baseRef) {
  const byContext = new Map(); // context → expected app/integration id
  let degraded = null;
  try {
    const prot = ghJson(["api", `repos/${repo}/branches/${baseRef}/protection`]);
    for (const c of prot?.required_status_checks?.checks ?? []) byContext.set(c.context, c.app_id ?? null);
  } catch (e) { degraded = `branch protection unreadable: ${String(e.message).slice(0, 120)}`; }
  try {
    for (const rs of ghJson(["api", `repos/${repo}/rulesets`]) ?? []) {
      const full = ghJson(["api", `repos/${repo}/rulesets/${rs.id}`]);
      if (full?.enforcement !== "active") continue;
      for (const rule of full.rules ?? []) {
        if (rule.type !== "required_status_checks") continue;
        for (const c of rule.parameters?.required_status_checks ?? []) {
          byContext.set(c.context, c.integration_id ?? c.app_id ?? byContext.get(c.context) ?? null);
        }
      }
    }
  } catch (e) { degraded = `${degraded ? `${degraded}; ` : ""}rulesets unreadable: ${String(e.message).slice(0, 120)}`; }
  return { required: [...byContext].map(([context, appId]) => ({ context, appId })), degraded };
}

// Check runs carry `app.id` directly, so their producer verifies generically. Commit
// statuses do not expose the producing app at all, so the few required checks that arrive
// as statuses have their producing account pinned here. An unlisted producer fails closed
// rather than being trusted on its context name.
const STATUS_CREATOR_BY_APP_ID = new Map([
  [8329, 35613825], // vercel → vercel[bot]
]);

const FAILING = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED", "ERROR", "STARTUP_FAILURE"]);
const RUNNING = new Set(["IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "REQUESTED"]);
const PASSING = new Set(["SUCCESS", "COMPLETED"]);

// Both APIs carry DUPLICATE entries per context (a rerun leaves the old one behind).
// Selecting anything but the newest verified run is how a stale green wins.
export function checksVerdict({ required, checkRuns = [], statuses = [] }) {
  if (!required || required.length === 0) return "unknown"; // could not resolve → fail closed

  let pending = false;
  for (const { context, appId } of required) {
    // A required context with NO app binding cannot be producer-verified at all, so any
    // app posting that context name would have counted as green — the actor-forgery
    // condition this binding exists to prevent. An unbound producer is unknown, not green.
    if (appId == null) return "unknown";

    const candidates = [];
    for (const r of checkRuns) {
      // Producer verified generically: the run must come from the required app.
      if (r?.name !== context) continue;
      if (r?.app?.id !== appId) continue;
      candidates.push({ at: Date.parse(r.started_at ?? r.completed_at ?? 0) || 0, state: String(r.conclusion ?? r.status ?? "").toUpperCase() });
    }
    const expectedCreator = STATUS_CREATOR_BY_APP_ID.get(appId);
    for (const s of statuses) {
      if (s?.context !== context) continue;
      if (expectedCreator == null || s?.creator?.id !== expectedCreator) continue;
      candidates.push({ at: Date.parse(s.created_at ?? 0) || 0, state: String(s.state ?? "").toUpperCase() });
    }
    if (candidates.length === 0) return "unknown"; // no VERIFIED run for a required context

    candidates.sort((a, b) => b.at - a.at);
    const state = candidates[0].state;
    if (FAILING.has(state)) return "failing";
    if (RUNNING.has(state)) { pending = true; continue; }
    if (!PASSING.has(state)) return "unknown"; // NEUTRAL/SKIPPED/unknown → fail closed
  }
  return pending ? "pending" : "green";
}

// Only a verified SUCCESS counts as a completed review. Mapping "anything that is not
// pending" to complete silently absorbed `failure` and `error`, which cleared the
// missing-review blocker and could print "no blockers found" when no review had actually
// succeeded — the exact false-all-clear this tool exists to prevent.
export function coderabbitStateFrom(statuses) {
  // Identity, not just a context name: another credential with status-write access could
  // otherwise post a lookalike status.
  const mine = (statuses ?? []).filter((s) => s?.context === CODERABBIT_CONTEXT && s?.creator?.id === CODERABBIT_CREATOR_ID);
  if (mine.length === 0) return { state: "missing", description: null };
  mine.sort((a, b) => Date.parse(b.updated_at ?? 0) - Date.parse(a.updated_at ?? 0));
  const latest = mine[0];
  // The description is how CodeRabbit announces a rate limit or a reached spend cap,
  // which the gate-health source reads to tell "gate down" from "gate says no".
  const description = latest.description ?? null;
  if (latest.state === "pending") return { state: "in_flight", description };
  if (latest.state === "success") return { state: "success_claimed", description };
  return { state: "failed", description }; // failure / error → fail closed
}

// A GREEN CodeRabbit status is not evidence a review happened. docs/reference/gotchas.md
// records PR #411: the check row read "Review completed" while CodeRabbit's own comment
// said "Review failed" and zero findings were ever submitted (PR #402 was the milder
// rate-limited version). Trusting the status row would let patrol hide a missing mandatory
// review behind "no blockers found".
// `reviewsAtHead` counts ONLY reviews bound to the head commit being judged. Counting every
// historical review on the PR meant a review of commit A validated commit B: push B, let
// CodeRabbit post its known false-green status with no review submitted, and A's old review
// silently cleared the blocker for an unreviewed head.
export function coderabbitCompletion({ statusState, evidence }) {
  if (statusState !== "success_claimed") return statusState; // missing / in_flight / failed
  if (!evidence?.ok) return "unknown";                       // could not verify → fail closed
  if (evidence.reviewsAtHead > 0) return "complete";         // a review of THIS head exists
  if (evidence.latestSaysFailed) return "failed";            // green row, failure in the body
  return "unknown";                                          // green row, nothing at this head
}

const CODERABBIT_ACTOR = /^coderabbitai(\[bot\])?$/i;
const CR_FAILURE_TEXT = /review failed|rate limit|error occurred during the review/i;

// REST rather than `gh pr view`: the reviews endpoint exposes `commit_id`, which is the
// only way to bind a review to the head being judged.
function coderabbitEvidence(repo, number, headSha) {
  try {
    const reviews = ghJson(["api", `repos/${repo}/pulls/${number}/reviews`, "--paginate"]) ?? [];
    const atHead = reviews.filter((r) =>
      CODERABBIT_ACTOR.test(r?.user?.login ?? "") && r?.commit_id === headSha);
    const comments = ghJson(["api", `repos/${repo}/issues/${number}/comments`, "--paginate"]) ?? [];
    const mine = comments.filter((c) => CODERABBIT_ACTOR.test(c?.user?.login ?? ""));
    const latest = mine[mine.length - 1];
    return { ok: true, reviewsAtHead: atHead.length, latestSaysFailed: CR_FAILURE_TEXT.test(latest?.body ?? "") };
  } catch {
    return { ok: false };
  }
}

// ── pull requests ───────────────────────────────────────────────────────────
// `commits` is deliberately absent: asking for it across every open PR fans out the
// authors connection past GitHub's GraphQL node ceiling and fails the whole scan. Head
// commit identity is fetched per PR below instead.
// `statusCheckRollup` is deliberately absent: it omits the producing app, so a context
// resolved from it cannot be bound to the integration the branch rule requires. Checks
// come from the REST check-runs and statuses endpoints instead.
const PR_FIELDS = "number,title,state,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,mergeable,mergeStateStatus,updatedAt,author,labels";

// Markers that mean "held by a decision". LABELS ONLY — a PR title is written by the PR
// author, so honouring a title marker let any contributor move their own PR out of the
// actionable lane just by naming it "PARKED". Applying a label needs write access, so it
// is an authorization signal; a title is not. Documenting that risk was not mitigating it.
const PARKED_LABELS = new Set(["hold", "parked", "on-hold", "do-not-merge", "blocked"]);
export function isParked(pr) {
  return (pr.labels ?? []).some((l) => PARKED_LABELS.has(String(l.name).toLowerCase()));
}

function collectPullRequests(repo) {
  const src = { name: "pullRequests", required: true, status: "OK", expected: null, received: 0 };
  try {
    const list = (argv) => ghJson(["pr", "list", "--repo", repo, "--state", "open", "--limit", "200", "--json", argv]);
    const readA = list(PR_FIELDS);
    const tA = new Date().toISOString();

    // Independent observation from a DIFFERENT API (REST), which also forces GitHub to
    // compute mergeability. Two GraphQL reads can agree by sharing one cache.
    const rest = new Map();
    const headCommit = new Map();
    const checkData = new Map();
    for (const p of readA) {
      try {
        const r = ghJson(["api", `repos/${repo}/pulls/${p.number}`]);
        rest.set(p.number, { head: r.head?.sha, state: String(r.mergeable_state || "").toUpperCase() });
      } catch { /* absent → compareObserved false below */ }
      try {
        const c = ghJson(["api", `repos/${repo}/commits/${p.headRefOid}`]);
        headCommit.set(p.number, { login: c?.author?.login ?? "", date: c?.commit?.committer?.date ?? null });
      } catch { /* absent → activity stays unknown, never "fresh" */ }
      // Check runs and commit statuses, not the GraphQL rollup: the rollup omits the
      // producing app entirely, so a check resolved from it cannot be attributed to the
      // integration the branch rule actually requires.
      let checkRuns = null;
      let statuses = null;
      try { checkRuns = ghJson(["api", `repos/${repo}/commits/${p.headRefOid}/check-runs`])?.check_runs ?? []; } catch { checkRuns = null; }
      try { statuses = ghJson(["api", `repos/${repo}/commits/${p.headRefOid}/statuses`]) ?? []; } catch { statuses = null; }
      checkData.set(p.number, { checkRuns, statuses });
    }

    sleep(MIN_STABLE_INTERVAL_MS + 250); // defeat a shared cache between the two reads
    const readB = list(PR_FIELDS);
    const tB = new Date().toISOString();

    const byNumB = new Map(readB.map((p) => [p.number, p]));
    const { required, degraded } = requiredContexts(repo, "main");
    if (degraded) { src.status = "INCOMPLETE"; src.detail = degraded; }

    const crDescriptions = [];
    const prs = readA.map((a) => {
      const b = byNumB.get(a.number);
      const r = rest.get(a.number);
      const mk = (p, observedAt) => p && ({
        headRefOid: p.headRefOid, baseRefOid: p.baseRefOid,
        mergeable: p.mergeable, mergeStateStatus: p.mergeStateStatus, observedAt,
      });
      const lastHuman = lastHumanActivity(a, headCommit.get(a.number));
      const cd = checkData.get(a.number) ?? { checkRuns: null, statuses: null };
      // An API that failed is not an empty result: unreadable check or status data must
      // fail closed to "unknown", never read as "nothing failing".
      const checks = cd.checkRuns === null || cd.statuses === null
        ? "unknown"
        : checksVerdict({ required, checkRuns: cd.checkRuns, statuses: cd.statuses });
      const crStatus = cd.statuses === null ? { state: "missing", description: null } : coderabbitStateFrom(cd.statuses);
      if (crStatus.description) crDescriptions.push(crStatus.description);
      // Only pay for the extra review lookup when the status CLAIMS success — that is the
      // only case where the status row and reality can disagree.
      const cr = {
        state: coderabbitCompletion({
          statusState: crStatus.state,
          evidence: crStatus.state === "success_claimed" ? coderabbitEvidence(repo, a.number, a.headRefOid) : null,
        }),
      };
      return {
        number: a.number, title: a.title, state: a.state, isDraft: a.isDraft,
        headRefName: a.headRefName, headRefOid: a.headRefOid,
        baseRefName: a.baseRefName, baseRefOid: a.baseRefOid,
        mergeStateStatus: a.mergeStateStatus, mergeable: a.mergeable,
        mergeStateObservation: {
          readA: mk(a, tA), readB: mk(b, tB),
          compareObserved: Boolean(r && r.head === a.headRefOid && r.state === a.mergeStateStatus),
        },
        parked: isParked(a),
        checks,
        coderabbit: cr.state,
        solProof: "unknown",       // v1 does not evaluate the proof registry
        requiresSolProof: false,   // so it never claims one is missing
        lastHumanActivityAt: lastHuman,
        firstSeenAt: lastHuman,
      };
    });
    src.expected = readA.length;
    src.received = prs.length;
    if (src.expected !== src.received) { src.status = "INCOMPLETE"; src.detail = "pull request count changed mid-scan"; }
    return { src, prs, crDescriptions };
  } catch (e) {
    src.status = "ERROR";
    src.detail = String(e.message).slice(0, 200);
    return { src, prs: [], crDescriptions: [] };
  }
}

// An actor that cannot be resolved is ambiguous and is NOT counted as human, so bot
// noise cannot reset an abandonment clock.
const BOT_LOGIN = /\[bot\]$|^dependabot|^coderabbitai|^github-actions/i;
function lastHumanActivity(pr, head) {
  // The head commit's own author/date is the cheapest signal that is actually about a
  // human touching the branch. `updatedAt` is not usable: a bot comment bumps it, which
  // would silently reset an abandonment clock.
  if (head?.date && head.login && !BOT_LOGIN.test(head.login)) return head.date;
  if (head?.date && !head.login) return null; // unresolved actor is ambiguous, not human
  const author = pr.author?.login ?? "";
  if (head?.date && author && !BOT_LOGIN.test(author)) return head.date;
  return null; // unknown → isStale() returns null, never "fresh"
}

// ── worktrees ───────────────────────────────────────────────────────────────
function collectWorktrees(repoRoot, openPrBranches) {
  const src = { name: "worktrees", required: true, status: "OK", expected: null, received: 0 };
  const out = [];
  try {
    const porcelain = git(["worktree", "list", "--porcelain"], repoRoot);
    const blocks = porcelain.split(/\n\n+/).filter(Boolean);
    src.expected = blocks.length;
    for (const block of blocks) {
      const wtPath = /^worktree (.+)$/m.exec(block)?.[1];
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? "(detached)";
      if (!wtPath) continue;
      const wt = { path: wtPath, branch, dirtyCount: 0, merged: false, hasOpenPr: openPrBranches.has(branch), lastHumanActivityAt: null };
      // `git status` runs the worktree conversion pipeline, so a repository-local
      // filter.<name>.clean command would EXECUTE here — hourly, under Mason's account,
      // once patrol is scheduled. No environment switch disables repo-local filters, so a
      // risky worktree is reported as unobservable instead of being scanned.
      const risk = worktreeFilterRisk(wtPath);
      if (risk) {
        wt.observationError = risk;
        out.push(wt);
        continue;
      }
      try {
        wt.dirtyCount = git(["status", "--porcelain"], wtPath).split("\n").filter((l) => l.trim()).length;
        const head = git(["rev-parse", "HEAD"], wtPath);
        wt.merged = git(["branch", "--remotes", "--contains", head], wtPath).split("\n").some((l) => l.trim() === "origin/main");
        wt.lastHumanActivityAt = git(["log", "-1", "--format=%cI"], wtPath) || null;
      } catch (e) { wt.observationError = String(e.message).slice(0, 160); }
      out.push(wt);
    }
    src.received = out.length;
  } catch (e) {
    src.status = "ERROR";
    src.detail = String(e.message).slice(0, 200);
  }
  return { src, worktrees: out };
}

// ── snapshot assembly ───────────────────────────────────────────────────────
function collectorBuild() {
  try {
    const head = git(["rev-parse", "HEAD"], SCRIPT_DIR);
    // This `git status` enters Git's conversion pipeline exactly like the worktree scan
    // does, so it needs the same guard. It was missed because it looks like harmless
    // provenance bookkeeping — but a configured content filter would execute here on every
    // run. Interactive-only scope removes UNATTENDED execution; it does not remove this.
    if (worktreeFilterRisk(SCRIPT_DIR)) return `${head}-unverified`;
    const dirty = git(["status", "--porcelain", "--", SCRIPT_DIR], SCRIPT_DIR).trim().length > 0;
    return dirty ? `${head}-dirty` : head;
  } catch { return "unknown"; }
}

export function buildSnapshot({ repo, repoRoot, runId }) {
  const { src: prSrc, prs, crDescriptions } = collectPullRequests(repo);
  const openBranches = new Set(prs.map((p) => p.headRefName));
  const { src: wtSrc, worktrees } = collectWorktrees(repoRoot, openBranches);
  const { src: loopSrc, loops } = collectLoops(repoRoot);
  const { src: parkedSrc, parked } = collectParkedMigrations(repoRoot);
  const { src: gateSrc, gates } = collectGateHealth(repoRoot, { coderabbitDescriptions: crDescriptions });

  const sources = [prSrc, wtSrc, loopSrc, parkedSrc, gateSrc];
  const generatedAt = new Date();
  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    repoId: repo,
    collectorCommit: collectorBuild(),
    ghVersion: (() => { try { return gh(["--version"]).split("\n")[0].trim(); } catch { return "unknown"; } })(),
    generatedAt: generatedAt.toISOString(),
    expiresAt: new Date(generatedAt.getTime() + SNAPSHOT_TTL_MS).toISOString(),
    // `complete` covers REQUIRED sources. An optional source that failed still emits a
    // visible SCAN_ERROR item downstream, which suppresses the all-clear.
    complete: sources.filter((s) => s.required).every((s) => s.status === "OK"),
    sources,
    pullRequests: prs,
    worktrees,
    loops,
    parkedMigrations: parked,
    gateHealth: gates,
    queuePath: path.join(STATE_DIR, `snapshot-${runId}.json`),
  };
  snapshot.contentHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  return snapshot;
}

// Persisting the snapshot is what makes the report's "Full queue" path real. A report
// that cites a file which was never written is its own small lie, so every caller that
// renders a report must call this.
export function writeSnapshot(snapshot) {
  mkdirSync(STATE_DIR, { recursive: true });
  const finalPath = path.join(STATE_DIR, `snapshot-${snapshot.runId}.json`);
  const tmpPath = `${finalPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(snapshot, null, 1), "utf8");
  renameSync(tmpPath, finalPath); // atomic: a reader never sees a half-written snapshot
  return finalPath;
}

// Deliberately NOT written by writeSnapshot. The heartbeat is the dead-man monitor's only
// evidence that patrol is alive and doing its job, so it must be stamped only after a run
// has actually DELIVERED a report. Writing it at persistence time meant a crash during
// classification or rendering left the monitor reporting healthy while Mason saw nothing.
export function writeHeartbeat(snapshot, snapshotPath) {
  if (!snapshot?.complete) return null; // a degraded scan never refreshes the heartbeat
  mkdirSync(STATE_DIR, { recursive: true });
  const hb = path.join(STATE_DIR, "heartbeat.json");
  const hbTmp = `${hb}.tmp`;
  writeFileSync(hbTmp, JSON.stringify({
    schemaVersion: SCHEMA_VERSION, runId: snapshot.runId, at: snapshot.generatedAt, snapshot: snapshotPath,
  }), "utf8");
  renameSync(hbTmp, hb);
  return hb;
}

function main() {
  const repoRoot = argOf("--repo-root", path.resolve(SCRIPT_DIR, "..", ".."));
  let repo = argOf("--repo", null);
  if (!repo) {
    const url = git(["remote", "get-url", "origin"], repoRoot);
    repo = /github\.com[:/](.+?)(?:\.git)?$/.exec(url)?.[1] ?? "";
  }
  const runId = argOf("--run-id", randomUUID());
  const snapshot = buildSnapshot({ repo, repoRoot, runId });
  const finalPath = writeSnapshot(snapshot);

  if (args.includes("--path-only")) process.stdout.write(`${finalPath}\n`);
  else process.stdout.write(`${JSON.stringify(snapshot)}\n`);
}

// pathToFileURL, not string surgery: on Windows a hand-built `file://C:/...` has two
// slashes where Node's import.meta.url has three, so the comparison silently never
// matched and this CLI produced no output at all.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
