## 2026-09-05 - make the guidance guard actually pin the routing rows and the approval gates

Answers the third CodeRabbit review of PR #600, on `41bc681b`. Two P2 comments, both accepted —
both are the same failure class: a green check that tests less than its name claims.

### The routing table was guarded by a count

`record(routedGuidance.length >= 15, "AGENTS.md retains the complete task-routing table")` counted
extracted links. The table has 18, so **three whole rows could be deleted while the check stayed
green** and CI reported success — silently un-routing agents from required guidance.

Replaced with one assertion per task → destination pairing, and **both halves are asserted**.
Pinning only the path would be satisfied by a row whose task label was rewritten; pinning only the
label would be satisfied by the row that CodeRabbit actually deleted. Pinning one half would have
been satisfied by the very defect this replaces.

### The approval gates were guarded by one sentence fragment

`record(/explicit approval in the current conversation/i.test(agents), "AGENTS.md defines
current-conversation approval gates")` proved only that the phrase appeared *somewhere*. The list of
what is actually gated was untested: CodeRabbit deleted the entire Edge Function / data-deletion /
secrets / authentication / permissions / billing / domains / ownership clause and the check still
passed. A name promising it "defines the approval gates" over a test that could not see them go.

Every protected action is now asserted individually — force-pushing, live migrations and live-data
changes, Edge Function and out-of-band production deploys, deleting data, and the
secrets/authentication/permissions/billing/domains/ownership clause — matched against
whitespace-flattened text so a rewrap cannot break the pin. The hands-free migration exception and
its "never permits destructive migrations" constraint were already pinned separately and are
unchanged.

## Verification

Mutation test — break `AGENTS.md` in ways the old checks demonstrably tolerated, and require the new
ones to go red naming the right assertion. **6 mutants, 6 caught, 0 no-op**, `AGENTS.md` restored
byte-identical:

| Mutant | Result |
| --- | --- |
| delete the Frontend/UI routing row | caught (label missing; path unrouted) |
| drop `UI_PATTERNS.md` but KEEP the Frontend/UI label | caught (path unrouted) |
| delete the secrets/auth/permissions/billing/domains/ownership clause | caught |
| delete the Edge Function deploy gate | caught |
| delete the force-push gate | caught |
| delete the deleting-data gate | caught |

The first mutant initially reported **NO-OP** — its pattern used `\n` while git materializes
`AGENTS.md` with CRLF here, so it changed nothing and proved nothing. It was rewritten to `\r?\n`
rather than counted as a pass; a vacuous mutant is how a mutation suite fakes its own coverage.

`npm run test:agent-workflows` passes.
