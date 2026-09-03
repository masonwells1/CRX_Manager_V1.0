## 2026-09-02 — close three inherited actor-forgery bypasses and a CI guard that passed on its own comment

Round 3 of the exact-SHA `gpt-5.6-sol` proof, on `b032afe34`. Unlike rounds 1 and 2, three of the
four findings are **pre-existing** — bypasses PR #449 carried and this branch inherited. Fixed
anyway, because shipping them is shipping them.

### MEDIUM — the new static CI guard passed by matching an obsolete comment

The guard asserted `executable_src !~* 'financial_audit_log'`, an expression that after round 2
exists **only inside a comment describing the rejected draft**. Codex: "one raw match and zero
executable-code matches". A guard satisfiable by its own documentation is worse than no guard —
it reports coverage it does not have.

Comments are now stripped at read time, before **every** structural assertion, and the assertion
pins the current executable shape (the no-credited-refusal gate). The suite still passes with
comments stripped, which confirms the remaining assertions were matching real code.

### HIGH — quoted identifiers spoofed the control-flow balance

The lexer must leave double-quoted identifiers intact (`"public"."f"` is how a routine is named),
but the reachability check counted textual `IF` / `END IF` / `LOOP` / `CASE`. A legal
`DECLARE "END IF" integer;` inside `IF false THEN …` balances the prefix, so an **unreachable**
refusal is credited and everything after it disappears from analysis.

**This was the one unresolved thread on PR #449 itself** and was never closed there. Quoted
identifiers are now blanked before the tokens are counted.

### HIGH — `INTO` is an assignment path the rebinding rule never read

`SELECT p_target_id INTO p_actor_source` overwrites the actor exactly as `:=` does, after a
canonical refusal has already passed. Recorded as an open residual in the 2026-09-01 cap entry
("the `INTO`-target form is proven STILL OPEN … both sweeps miss it too"). Both predicates now treat
the actor parameter, or `v_actor`, appearing as any target in an `INTO` list as a rebinding.
Measured live: **zero** routines use that form, so it costs nothing.

### Declined, with reasons — null-tolerant guards as a truncation point

Codex also asked that a null-tolerant refusal (`p_x IS NOT NULL AND p_x IS DISTINCT FROM v_actor`)
stop being treated as a cutoff, since it proves nothing when the caller passes NULL.

The soundness point is correct in the abstract and the practical risk is low: after such a guard the
parameter is either NULL or provably the caller. Writing NULL is an attribution gap, not forgery,
and a NULL in a role lookup denies. Meanwhile the null-tolerant form **is** the house pattern — 10
live routines use it — so refusing to credit it returns the sweep from 21 rows to ~31 and undoes the
change's whole purpose.

Recorded as an accepted limit rather than silently ignored. These predicates are over-broad
heuristics, not proofs; the 2026-09-01 cap entry is the authority for not funding real PL/pgSQL
dataflow analysis here.

### Proof

Two new DENY canaries — `actor_into_rebound_param_forward` and
`actor_quoted_identifier_block_spoof` — both mutation-tested: removing the quoted-identifier masking
turns the spoof canary red and nothing else. Container suite green, static guard green, live count
unchanged at 21.
