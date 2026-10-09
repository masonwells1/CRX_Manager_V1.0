## 2026-10-08 — Sol review wrapper falls back to the installed Codex when the app build's sandbox fails to start

**What broke.** On 2026-10-07 the Codex desktop app auto-installed `0.162.0-alpha.2`. The Sol proof wrapper (`scripts/write-codex-push-proof.mjs`) always picks the newest app build, and that build's elevated Windows sandbox cannot apply any deny-read entry. Every Sol review exited 1 in about a second with `Failed to create session ... windows sandbox failed` and empty output. Nothing was reviewed, so no PR could get its required Sol proof. The npm-installed Codex (`0.156.1`) runs the identical sandbox profile without the error.

**What changed (Mason approved "change the script", 2026-10-08).**
- The wrapper still runs the newest app build first, with no other change.
- It retries only when that run is a sandbox **startup** failure: a non-zero exit, nothing on stdout, and stderr containing both `Failed to create session` and a sandbox-setup error. The retry happens once, on the npm-installed Codex at its fixed path under `%APPDATA%\npm\…\codex.exe`, with the same arguments, model (Sol), effort (high), permission profile, and prompt. The path is derived from the home directory, so no PATH lookup or environment variable can choose the reviewer.
- Every other outcome is final and is never retried: a verdict of any kind, findings, any model output, a timeout, an auth or credit error. A missing fallback, or a fallback that also fails, mints no proof, exactly as before. This keeps verdict-shopping impossible.
- A one-line `NOTICE` is printed when the fallback runs. The review capture records which binary ran, and the "proof written" line names it.
- `scripts/write-apply-proofs.mjs` (migration-apply proofs) shared the binary resolver, so it now uses the same shared runner (`runCodexWithSandboxFallback`) instead of its own copy of the spawn call. Its capture records the binary as well.
- `scripts/overnight-codex-gate.mjs` has its own resolver and mints no merge proof, so it is unchanged.

**Sol caught two problems during the work, and both are fixed.**
- BLOCKER: an early draft let `run()` accept a caller-supplied `spawn` and binary resolver so tests could drive it. Any script could then have minted a proof the guard accepts from a fake Codex. `run()` now takes only its arguments and hard-wires the real binaries and spawn. A test asserts it stays that way.
- LOW: whitespace-only stdout counted as "no output", which allowed a retry. The check now requires stdout to be exactly empty.

**Proof.**
- Real wrapper run on this branch. The app alpha started normally this time (it had stopped reproducing its failure by then), so no fallback was needed. Sol/high on 0.162.0-alpha.2 returned CLEAN with the LOW finding above.
- Real fallback run. A one-off driver in a throwaway clone replaced only the first spawn with the alpha's recorded startup failure. The wrapper printed the `NOTICE`, then really ran the npm Codex (`v0.156.1`, `gpt-6-sol`, read-only sandbox, all deny paths). That run produced a genuine review: BLOCKERS, which was the `run()` injection finding above. The capture recorded both binaries and the primary's error.
- `scripts/write-codex-push-proof.test.mjs` covers all five cases through the shared runner, the real verdict parser, and the proof builder. A startup failure gets exactly one fallback run, with the same arguments and prompt, and its CLEAN result passes `proofValid`. Findings, partial output, a timeout, and an auth error get no retry. A missing or same-path fallback, or a fallback that also fails, produces no proof.
- `--dry-run` picks the app alpha as the primary and the npm `codex.exe` as the fallback.

**Owner note.** This changes which program the gate trusts, so Sol cannot review its own fix while the app build is broken. Mason merges this PR by hand.
