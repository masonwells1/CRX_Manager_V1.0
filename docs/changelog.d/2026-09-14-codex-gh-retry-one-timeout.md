## 2026-09-14 - Codex merge gate retries gh.exe only when gh is missing

- **What changed:** on Windows the Codex merge gate runs `gh`, and used to try the absolute `C:\Program Files\GitHub CLI\gh.exe` after ANY failure. It now tries the second path only when `gh` is not installed (the "file not found" error). A slow or failing `gh` is reported straight away.
- **Why:** the new merge-gate time budget (see 2026-09-13-merge-gate-time-budget.md) counts each GitHub lookup as one 5-second timeout. The old fall-through could make one lookup take two, so a chained merge command could still outrun the 15-second hook limit and go through unchecked. Found by the local gpt-5.6-sol review of PR #630 on 2026-09-14.
- **Proof:** with `gh` removed from PATH, the real guard still found gh.exe and read the PR's live review status. A source assertion pins the "missing only" retry, and removing the fix makes that test fail.
