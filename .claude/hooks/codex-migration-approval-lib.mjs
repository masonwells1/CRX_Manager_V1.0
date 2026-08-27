import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CRX_LIVE_PROJECT_ID = "rhyzpcqhnizqbxphqdkr";
export const APPROVAL_PREFIX = "APPROVE CRX LIVE MIGRATION";
export const APPROVAL_TTL_MS = 5 * 60 * 1000;
export const APPROVAL_FORMAT = "crx-codex-live-migration-approval-v1";

const MIGRATION_NAME_RE = /^\d{14}_[a-z0-9_]+$/;
const APPROVAL_RE = new RegExp(`^${APPROVAL_PREFIX} project=(${CRX_LIVE_PROJECT_ID}) migration=(\\d{14}_[a-z0-9_]+)$`);

function sha256(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

export function normalizeApprovalSql(value) {
  return String(value || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

export function approvalSqlHash(value) {
  return sha256(normalizeApprovalSql(value));
}

export function parseMigrationApprovalPrompt(value) {
  const prompt = String(value || "").trim();
  const match = APPROVAL_RE.exec(prompt);
  if (!match) return null;
  return { projectId: match[1], migrationName: match[2] };
}

function identityHash(value) {
  const text = String(value || "");
  return text ? sha256(text) : "";
}

function stateDirectory(repoRoot) {
  return path.join(path.resolve(repoRoot), ".claude", "session-state");
}

export function migrationApprovalPath(repoRoot, sessionId) {
  const sessionHash = identityHash(sessionId);
  if (!sessionHash) return "";
  return path.join(stateDirectory(repoRoot), `codex-migration-approval-${sessionHash.slice(0, 24)}.json`);
}

export function clearMigrationApproval(repoRoot, sessionId) {
  const approvalPath = migrationApprovalPath(repoRoot, sessionId);
  if (!approvalPath) return;
  try { rmSync(approvalPath, { force: true }); } catch { }
}

function resolveMigrationFile(repoRoot, migrationName) {
  if (!MIGRATION_NAME_RE.test(String(migrationName || ""))) {
    throw new Error("migration name must be a 14-digit timestamp plus lowercase slug");
  }
  const migrationsRoot = path.join(path.resolve(repoRoot), "supabase", "migrations");
  const filePath = path.join(migrationsRoot, `${migrationName}.sql`);
  if (!existsSync(filePath)) throw new Error(`migration file not found: supabase/migrations/${migrationName}.sql`);
  const realRoot = realpathSync.native(migrationsRoot);
  const realFile = realpathSync.native(filePath);
  const relative = path.relative(realRoot, realFile);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("migration file resolves outside supabase/migrations");
  }
  return { filePath: realFile, relativePath: path.posix.join("supabase", "migrations", `${migrationName}.sql`) };
}

function writeApprovalAtomically(approvalPath, token) {
  mkdirSync(path.dirname(approvalPath), { recursive: true });
  const temporaryPath = `${approvalPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(token)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { renameSync(temporaryPath, approvalPath); }
  finally { try { rmSync(temporaryPath, { force: true }); } catch { } }
}

export function mintMigrationApproval({ repoRoot, sessionId, turnId, projectId, migrationName, headSha, nowMs = Date.now() } = {}) {
  if (!sessionId || !turnId) throw new Error("Codex session_id and turn_id are required");
  if (projectId !== CRX_LIVE_PROJECT_ID) throw new Error("approval targets the wrong Supabase project");
  if (!/^[0-9a-f]{40}$/i.test(String(headSha || ""))) throw new Error("current Git HEAD is required");
  const { filePath, relativePath } = resolveMigrationFile(repoRoot, migrationName);
  const sql = readFileSync(filePath, "utf8");
  if (!sql.trim()) throw new Error("migration file is empty");
  const approvalPath = migrationApprovalPath(repoRoot, sessionId);
  if (!approvalPath) throw new Error("approval state path could not be derived");
  const token = {
    format: APPROVAL_FORMAT,
    projectId,
    migrationName,
    migrationPath: relativePath,
    sqlHash: approvalSqlHash(sql),
    headSha: String(headSha).toLowerCase(),
    sessionHash: identityHash(sessionId),
    turnHash: identityHash(turnId),
    createdAtMs: nowMs,
    expiresAtMs: nowMs + APPROVAL_TTL_MS,
  };
  writeApprovalAtomically(approvalPath, token);
  return token;
}

function rejected(reason) { return { allowed: false, reason }; }

export function claimMigrationApproval({ repoRoot, sessionId, turnId, toolUseId, projectId, migrationName, query, headSha, nowMs = Date.now() } = {}) {
  if (!sessionId || !turnId || !toolUseId) {
    return rejected("Codex did not provide session_id, turn_id, and tool_use_id, so approval cannot be bound to this tool call");
  }
  const approvalPath = migrationApprovalPath(repoRoot, sessionId);
  if (!approvalPath) return rejected("no session-bound approval path exists");
  const claimPath = `${approvalPath}.claim-${identityHash(toolUseId).slice(0, 24)}`;
  try { renameSync(approvalPath, claimPath); }
  catch { return rejected("no unused Mason-authored approval exists for this Codex session"); }
  try {
    let token;
    try { token = JSON.parse(readFileSync(claimPath, "utf8")); }
    catch { return rejected("the approval token is unreadable"); }
    if (token?.format !== APPROVAL_FORMAT) return rejected("the approval token format is invalid");
    if (token.sessionHash !== identityHash(sessionId) || token.turnHash !== identityHash(turnId)) {
      return rejected("the approval belongs to a different Codex session or turn");
    }
    if (!Number.isFinite(token.createdAtMs) || !Number.isFinite(token.expiresAtMs) || token.createdAtMs > nowMs + 30_000 || token.expiresAtMs < nowMs || token.expiresAtMs - token.createdAtMs !== APPROVAL_TTL_MS) {
      return rejected("the approval is expired, future-dated, or has an invalid lifetime");
    }
    if (projectId !== CRX_LIVE_PROJECT_ID || token.projectId !== projectId) {
      return rejected("the approval does not target this exact live Supabase project");
    }
    if (token.migrationName !== migrationName || !MIGRATION_NAME_RE.test(String(migrationName || ""))) {
      return rejected("the approval does not target this exact migration name");
    }
    if (String(token.headSha || "").toLowerCase() !== String(headSha || "").toLowerCase()) {
      return rejected("Git HEAD moved after Mason approved the migration");
    }
    if (!String(query || "").trim() || approvalSqlHash(query) !== token.sqlHash) {
      return rejected("the transmitted SQL does not match the SQL Mason approved");
    }
    let currentSql;
    try {
      const { filePath, relativePath } = resolveMigrationFile(repoRoot, migrationName);
      if (relativePath !== token.migrationPath) return rejected("the approved migration path changed");
      currentSql = readFileSync(filePath, "utf8");
    } catch (error) {
      return rejected(`the approved migration file cannot be resolved: ${error?.message || error}`);
    }
    if (approvalSqlHash(currentSql) !== token.sqlHash) return rejected("the on-disk migration changed after Mason approved it");
    return { allowed: true, token };
  } finally {
    try { rmSync(claimPath, { force: true }); } catch { }
  }
}
