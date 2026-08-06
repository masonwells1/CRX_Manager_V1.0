#!/usr/bin/env node

import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildFactorySnapshot,
  FACTORY_AUTHORITY_NOTICE,
  FACTORY_MAX_ACTIVE_LANES,
  resolveFactoryPaths,
  safeId,
} from "./factory-state-lib.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

export const STAGE_LABELS = {
  "needs-ticket-ok": "Needs your ticket OK",
  queued: "Approved and queued",
  building: "Building",
  verifying: "Running proof",
  "in-review": "Independent review",
  "awaiting-morning-review": "Ready for your review",
  parked: "Parked safely",
  "approved-to-land": "Approved to land",
  live: "Live and verified",
  rejected: "Rejected",
  superseded: "Superseded",
};

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function evidenceHref(jobId, filename) {
  return `/evidence/${encodeURIComponent(jobId)}/${encodeURIComponent(filename)}`;
}

function jobCard(job) {
  const proofItems = [
    ...job.evidence,
    ...(job.reviews || []).map((item) => ({
      label: `Independent ${item.reviewer} review: ${String(item.verdict || "unknown").toUpperCase()}`,
      kind: item.model ? `${item.model}/${item.reasoningEffort || "unknown effort"}` : "review",
      filename: item.filename,
    })),
  ];
  const evidence = proofItems.length
    ? `<ul class="proof-list">${proofItems.map((item) =>
      `<li><a href="${evidenceHref(job.id, item.filename)}" target="_blank" rel="noopener">${escapeHtml(item.label)}</a><span>${escapeHtml(item.kind)}</span></li>`,
    ).join("")}</ul>`
    : `<p class="muted">No machine-attached proof yet.</p>`;
  const summary = job.behaviorSummary
    ? `<p class="summary">${escapeHtml(job.behaviorSummary)}</p>`
    : `<p class="muted">Behavior summary will appear after proof and independent review.</p>`;
  const blocker = job.blocker
    ? `<div class="needs"><strong>Needs attention:</strong> ${escapeHtml(job.blocker)}</div>`
    : "";
  const worktree = job.worktree
    ? `<p class="timestamp"><strong>Working in:</strong> <code>${escapeHtml(job.worktree)}</code></p>`
    : `<p class="timestamp"><strong>Working in:</strong> Not assigned yet.</p>`;
  return `
    <article class="job" data-stage="${escapeHtml(job.stage)}">
      <div class="job-main">
        <div>
          <p class="eyebrow">${escapeHtml(job.id)}</p>
          <h2>${escapeHtml(job.title)}</h2>
        </div>
        <span class="stage">${escapeHtml(STAGE_LABELS[job.stage] || job.stage)}</span>
      </div>
      ${summary}
      ${blocker}
      <details>
        <summary>Proof and timing</summary>
        ${evidence}
        ${worktree}
        <p class="timestamp">Last activity: ${escapeHtml(job.lastActivity)}</p>
      </details>
    </article>`;
}

export function renderFactoryBoard(snapshot) {
  const held = snapshot.held
    ? `<section class="banner danger"><strong>Factory paused.</strong> ${escapeHtml(snapshot.holdReason || "No new work will start.")}</section>`
    : `<section class="banner good"><strong>Factory ready.</strong> ${escapeHtml(FACTORY_AUTHORITY_NOTICE)}</section>`;
  const warning = snapshot.warning
    ? `<section class="banner warn"><strong>Ledger warning.</strong> ${escapeHtml(snapshot.warning)}</section>`
    : "";
  const jobs = snapshot.jobs.length
    ? snapshot.jobs.map(jobCard).join("")
    : `<section class="empty"><h2>No factory jobs yet</h2><p>Describe the first job in ordinary Claude or Codex chat. The session will prepare the ticket for your yes or no.</p></section>`;
  const awaiting = snapshot.jobs.filter((job) => job.stage === "awaiting-morning-review").length;
  const active = snapshot.activeLaneCount ?? 0;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="15">
  <title>CRX Factory Board</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#f5f7f4; color:#152117; }
    * { box-sizing:border-box; }
    body { margin:0; min-width:0; }
    main { width:min(1040px, 100%); margin:0 auto; padding:24px 18px 56px; }
    header { display:flex; gap:18px; justify-content:space-between; align-items:flex-end; margin-bottom:18px; }
    h1 { margin:0; font-size:clamp(28px, 5vw, 44px); letter-spacing:-.04em; }
    h2 { margin:2px 0 0; font-size:20px; }
    p { line-height:1.5; }
    .sub { color:#526058; margin:6px 0 0; }
    .counts { display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end; }
    .count { background:white; border:1px solid #dce4dc; border-radius:12px; padding:10px 13px; min-width:112px; }
    .count strong { display:block; font-size:24px; }
    .count span { color:#637069; font-size:13px; }
    .banner { border-radius:14px; padding:13px 16px; margin:10px 0; border:1px solid; }
    .good { background:#edf8ef; border-color:#badfc1; color:#184f25; }
    .warn { background:#fff8e7; border-color:#ecd28e; color:#6e4c00; }
    .danger { background:#fff0ef; border-color:#e5b4b0; color:#74231e; }
    .jobs { display:grid; gap:12px; margin-top:18px; }
    .job, .empty { background:white; border:1px solid #dce4dc; border-radius:16px; padding:18px; box-shadow:0 6px 18px rgba(31,53,35,.05); min-width:0; }
    .job-main { display:flex; gap:14px; justify-content:space-between; align-items:flex-start; }
    .eyebrow { margin:0; color:#718078; font-size:12px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; overflow-wrap:anywhere; }
    .stage { flex:0 0 auto; border-radius:999px; background:#e9f1e9; color:#24452a; padding:7px 10px; font-size:13px; font-weight:700; }
    .summary { margin:14px 0 8px; font-size:16px; }
    .muted, .timestamp { color:#6c7771; }
    .needs { margin:12px 0; padding:11px 12px; background:#fff8e7; border-left:4px solid #d89e16; border-radius:8px; }
    details { margin-top:12px; border-top:1px solid #edf0ed; padding-top:11px; }
    summary { cursor:pointer; font-weight:700; }
    .proof-list { list-style:none; padding:0; display:grid; gap:7px; }
    .proof-list li { display:flex; justify-content:space-between; gap:12px; }
    a { color:#176a31; font-weight:700; overflow-wrap:anywhere; }
    .proof-list span { color:#79837d; font-size:13px; }
    .timestamp { font-size:13px; overflow-wrap:anywhere; }
    footer { color:#718078; font-size:13px; margin-top:18px; }
    @media (max-width:640px) {
      main { padding:18px 12px 40px; }
      header, .job-main { align-items:stretch; flex-direction:column; }
      .counts { justify-content:flex-start; }
      .count { flex:1 1 120px; }
      .stage { align-self:flex-start; white-space:normal; }
      .proof-list li { flex-direction:column; gap:2px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Factory Board</h1>
        <p class="sub">One read-only coordination view of CRX jobs. Approvals happen in ordinary chat.</p>
      </div>
      <div class="counts" aria-label="Factory summary">
        <div class="count"><strong>${active}/${snapshot.maxActiveLanes || FACTORY_MAX_ACTIVE_LANES}</strong><span>working now</span></div>
        <div class="count"><strong>${awaiting}</strong><span>ready for you</span></div>
      </div>
    </header>
    ${held}
    ${warning}
    <section class="jobs" aria-label="Factory jobs">${jobs}</section>
    <footer>Refreshes every 15 seconds · Read-only coordination record · No merge, deploy, migration, or data controls</footer>
  </main>
</body>
</html>`;
}

export function safeEvidencePath(paths, jobId, filename) {
  const safeJob = safeId(jobId);
  const safeFile = path.basename(filename);
  if (safeFile !== filename || !/^[A-Za-z0-9._-]+$/.test(safeFile)) throw new Error("Unsafe evidence filename.");
  const root = path.resolve(paths.evidenceDir);
  const target = path.resolve(root, safeJob, safeFile);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error("Evidence path escapes the factory directory.");
  return target;
}

export function projectFactoryBoardState(snapshot) {
  return {
    schemaVersion: snapshot.schemaVersion,
    held: snapshot.held,
    holdReason: snapshot.holdReason,
    degraded: snapshot.degraded,
    warning: snapshot.warning,
    activeLaneCount: snapshot.activeLaneCount,
    maxActiveLanes: snapshot.maxActiveLanes,
    jobs: snapshot.jobs.map((job) => ({
      id: job.id,
      title: job.title,
      stage: job.stage,
      worktree: job.worktree,
      behaviorSummary: job.behaviorSummary,
      blocker: job.blocker,
      evidence: job.evidence.map((item) => ({
        label: item.label,
        kind: item.kind,
        filename: item.filename,
        sha256: item.sha256,
        verified: item.verified,
        sourceCommand: item.sourceCommand,
      })),
      reviews: (job.reviews || []).map((item) => ({
        reviewer: item.reviewer,
        model: item.model,
        reasoningEffort: item.reasoningEffort,
        verdict: item.verdict,
        filename: item.filename,
        sha256: item.sha256,
      })),
      lastActivity: job.lastActivity,
    })),
  };
}

export function createFactoryBoardServer({ cwd = ROOT, env = process.env } = {}) {
  const paths = resolveFactoryPaths(cwd, env);
  return createServer((request, response) => {
    if (!["GET", "HEAD"].includes(request.method || "")) {
      response.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
      response.end("Read-only board.");
      return;
    }
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname === "/") {
        const html = renderFactoryBoard(buildFactorySnapshot(paths));
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        });
        response.end(request.method === "HEAD" ? "" : html);
        return;
      }
      if (url.pathname === "/api/state") {
        const state = projectFactoryBoardState(buildFactorySnapshot(paths));
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        response.end(request.method === "HEAD" ? "" : `${JSON.stringify(state, null, 2)}\n`);
        return;
      }
      const match = /^\/evidence\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (match) {
        const target = safeEvidencePath(paths, decodeURIComponent(match[1]), decodeURIComponent(match[2]));
        if (!existsSync(target) || !statSync(target).isFile()) {
          response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("Evidence not found.");
          return;
        }
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `inline; filename="${path.basename(target).replaceAll('"', "")}"`,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        });
        response.end(request.method === "HEAD" ? "" : readFileSync(target));
        return;
      }
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found.");
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end(`Factory Board unavailable: ${error.message}`);
    }
  });
}

function parsePort(argv) {
  const index = argv.indexOf("--port");
  if (index === -1) return 4177;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error("--port must be 1024-65535.");
  return value;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const port = parsePort(process.argv.slice(2));
    const server = createFactoryBoardServer();
    server.listen(port, "127.0.0.1", () => {
      process.stdout.write(`CRX Factory Board: http://127.0.0.1:${port}\n`);
    });
  } catch (error) {
    process.stderr.write(`Factory Board blocked: ${error.message}\n`);
    process.exitCode = 1;
  }
}
