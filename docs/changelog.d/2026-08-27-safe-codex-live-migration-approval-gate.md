## 2026-08-27 — Safe Codex live-migration approval gate

Codex previously blocked every live migration even after Mason explicitly approved it. The first
candidate fix used text from UserPromptSubmit as an approval token, but exact-commit adversarial
review proved that relayed machine text could be mistaken for Mason's authorship. That design was
removed before release.

The replacement uses Codex's native approval system. Both supported Supabase `apply_migration`
channels are configured to prompt, and Supabase app approvals are routed to the user rather than
the automatic reviewer. The production guard allows only those two exact tool identities to reach
the existing migration apply guard; unknown, rogue, or UUID-qualified lookalikes fail closed.

The gate is additive. The existing exact project, ordered migration snapshot, reviewed SQL hash,
proof freshness, destructive-content refusal, and second-model requirements can still deny the
call. Passing them does not approve production: Codex must still show its native prompt and Mason
must approve that specific tool call. Raw mutating SQL, CLI migration commands, the large-file apply
script, edge-function deploys, and Supabase lifecycle tools remain blocked.

Prevention tests verify the native prompt/user-reviewer configuration, exact allowed identities,
lookalike denial, and protection of the gate configuration and its reviewed maintenance producer.
The protected guard, configuration, and workflow command are changed only after a fresh exact-head
gpt-5.6-sol/high proof validates the producer and its expected preimages.
