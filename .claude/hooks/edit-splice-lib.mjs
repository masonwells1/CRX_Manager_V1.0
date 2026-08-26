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
