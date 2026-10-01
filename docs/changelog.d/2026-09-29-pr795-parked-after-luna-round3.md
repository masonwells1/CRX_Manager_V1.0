## 2026-09-29 - PR #795 parked as a draft after Codex Luna round 3

Mason stopped the review loop at the ship workflow's three-round cap: "Stop now push current work".
The PR stays a draft and is **not ready to merge**.

- **Luna round 3** (`gpt-6-luna` xhigh, on `8044d19`) reported 7 findings. They are open, not fixed:
  1. BLOCKER, judged a false alarm: the reviewer read the 2026-09-28 DECISION_LOG entry's last line as
     an attempt to steer reviewers. Reword it as a plain record before the final Sol review.
  2. BLOCKER: `bash -c 'curl -X PUT …/pulls/123/merge'` passes Claude's merge guard, because
     `expandNestedCommands` drops inner commands that mention no gh/git. Proposed fix: also return inner
     commands that mention curl, wget, Invoke-RestMethod, a GitHub URL or "merge".
  3. BLOCKER: a newline straight after `|` continues the pipeline in bash, but `pipelineStages`
     resets `piped` at the newline. So `echo "…" |` + newline + `bash` is not refused.
  4. BLOCKER: a here-document delimiter written `$'EOF'` is read as `$EOF`, so the lines after the
     real delimiter are skipped as body.
  5. MED: `echo 'x | bash'` is refused because the cmd reading strips `'` from `bash'`. cmd does not strip it,
     and the test asserting this is a real feed is wrong. Proposed fix: in cmd's reading, strip only `"`.
  6. LOW: `env -u gh echo ok` is refused as an unknown gh command.
  7. LOW: `(( x = 1 | bash ))` is refused as a pipe into bash.
- **Also deferred from round 2 (LOW):** `bash -c 'echo gh $HOME'` is refused as computed text.
- **Trend:** round 1 found 12, round 2 found 7, round 3 found 7. Each round found different problems, and
  three of round 3's are in the new interpreter-feed lexer.
- **Next step, when resumed:** fix 2–5, reword 1, run one more Luna round. If it still reports a BLOCKER or
  HIGH, consider the server-side alternative (no admin override on `main`), which is Mason's call.
