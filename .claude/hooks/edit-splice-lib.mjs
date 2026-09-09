// edit-splice-lib.mjs — shared, line-ending-safe Edit/MultiEdit simulation for
// PreToolUse guards that judge the FULL post-edit file rather than the fragment.
//
// THE CRLF BUG (2026-08-26, PR #401 branch): guards simulated an Edit with an
// exact `disk.split(old_string).join(new_string)`. On a Windows worktree with
// core.autocrlf the on-disk file is CRLF while the harness hands the hook
// LF-normalized old_string/new_string, so the splice silently no-oped and the
// guard evaluated the UNEDITED file. Deadlock: the guard demands a marker line
// (`-- caller-analysis:` / `-- idempotency-body-check: exempt`) but denies the
// very Edit that adds it, because it never sees the edit land.
//
// Fix: normalize BOTH sides to LF before splicing. Guards only ANALYZE the
// result (regex/lexer scans) and never write it back to disk, so wholesale
// LF-normalization is safe — and it keeps every index self-consistent for the
// length-preserving maskers that slice content by index.

import { existsSync, readFileSync } from "node:fs";

/** Normalize CRLF (and lone CR) to LF. */
export function toLF(s) {
  return String(s).replace(/\r\n?/g, "\n");
}

/**
 * Apply an Edit's old_string/new_string — or a MultiEdit's edits array, in
 * order — to on-disk content, line-ending-safely. Returns the LF-normalized
 * post-edit text for guard analysis. Matches every occurrence (a conservative
 * superset of the harness's replace semantics: a guard judging more replaced
 * text than the harness will apply can only see MORE of the change, not less).
 */
export function applyEditsForAnalysis(diskText, toolInput) {
  let text = toLF(diskText);
  const applyOne = (oldStr, newStr) => {
    if (typeof oldStr !== "string" || oldStr.length === 0 || typeof newStr !== "string") return;
    text = text.split(toLF(oldStr)).join(toLF(newStr));
  };
  if (Array.isArray(toolInput?.edits)) {
    for (const e of toolInput.edits) applyOne(e?.old_string, e?.new_string);
  } else {
    applyOne(toolInput?.old_string, toolInput?.new_string);
  }
  return text;
}

/**
 * The text a content guard should judge for a Write / Edit / MultiEdit call.
 *
 * Write: `content` IS the post-edit file. Edit and MultiEdit hand the hook only
 * fragments, so the full post-edit file is reconstructed from disk with
 * applyEditsForAnalysis; when the file cannot be read the fragments themselves
 * (every `edits[i].new_string`, joined) are judged instead. Either way the
 * MultiEdit `edits` array is never invisible.
 *
 * Why this exists (Codex gpt-5.6-sol High, PR #605 at 233dbf3c8): money-safety,
 * rls-on-new-tables, generated-column-check and env-guard each read
 * `content || new_string`, so a MultiEdit payload produced "" and every one of
 * them emitted `allow` — under `acceptEdits` an auto-accepted MultiEdit could
 * land float cents math, a table without RLS, a generated-column write, or
 * service_role material without the guard firing. Probe-confirmed on all four.
 *
 * Returns { content, reconstructed }: `reconstructed` is true when `content` is
 * the real post-edit file (a Write, or a successful splice), false when only the
 * fragments were available. LF-normalized.
 */
export function judgedContent(filePath, toolInput) {
  const input = toolInput || {};
  if (typeof input.content === "string") return { content: toLF(input.content), reconstructed: true };
  const isFragmentEdit = typeof input.old_string === "string" || Array.isArray(input.edits);
  if (!isFragmentEdit) return { content: "", reconstructed: false };
  const fragments = Array.isArray(input.edits)
    ? input.edits.map((e) => (typeof e?.new_string === "string" ? e.new_string : "")).join("\n")
    : (typeof input.new_string === "string" ? input.new_string : "");
  try {
    if (filePath && existsSync(filePath)) {
      return { content: applyEditsForAnalysis(readFileSync(filePath, "utf8"), input), reconstructed: true };
    }
  } catch {
    /* fall through to the fragments */
  }
  return { content: toLF(fragments), reconstructed: false };
}
