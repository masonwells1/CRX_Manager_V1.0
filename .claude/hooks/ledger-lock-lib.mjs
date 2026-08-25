// Cross-process mutex for the applied-source ledger (CodeRabbit PR #423):
// applied-snapshot-invalidate.mjs and stop-wrap.mjs both read-modify-write
// .claude/session-state/applied-source-ledger.json, and two overlapping
// recorder hooks (parallel apply_migration calls in one message) could lose an
// entry — silently disarming the C3 containment guard for that migration.
//
// mkdir is the lock primitive because it is atomic on every platform we run
// on. A holder that died is detected by lock age and evicted. If the lock
// still cannot be acquired inside timeoutMs, fn STILL runs but receives
// locked=false so each caller applies its own asymmetry (CodeRabbit PR #423
// round 4): an APPEND (recorder) writes anyway — recording with a residual
// race beats silently dropping the record, which would disarm the guard for
// that migration — while a REWRITE (the stop-wrap prune) must skip its write,
// because an unlocked rewrite could erase a concurrent recorder's append.
// Every caller is already fail-open by contract.

import { mkdirSync, rmdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

const STALE_LOCK_MS = 10_000;

// Content fingerprint shared by the recorder (applied-snapshot-invalidate.mjs)
// and the containment check (stop-wrap.mjs). Living here — the one module both
// already import — keeps the two normalizations from drifting apart, which
// would make every hash comparison silently fail toward blocking.
//
// Normalization: CRLF/CR → LF and outer whitespace trimmed, so a committed
// file that differs from the applied SQL only by line endings or a trailing
// newline still counts as the same source (Windows checkouts rewrite EOLs;
// editors add final newlines). Any REAL text difference still changes the hash.
export function normalizedSqlHash(sql) {
  return createHash("sha256")
    .update(String(sql ?? "").replace(/\r\n?/g, "\n").trim())
    .digest("hex");
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withFileLock(lockPath, fn, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let locked = false;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockPath);
      locked = true;
      break;
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
          rmdirSync(lockPath);
          continue;
        }
      } catch { /* holder released or evicted it first — retry */ }
      sleepMs(25);
    }
  }
  try {
    return fn(locked);
  } finally {
    if (locked) {
      try { rmdirSync(lockPath); } catch { /* best effort */ }
    }
  }
}
