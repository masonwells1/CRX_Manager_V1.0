## 2026-09-20 — correct four shipped comments that still called `adjust_inventory` a key-only replay, and record the control-character key gap as an accepted residual

`20260911120000_bind_adjust_inventory_receipt_to_intent` applied live on 2026-09-20 (ledger version
`20260920052149`). Four comments on `main` still described the pre-migration world and were false in
production as a result. They mattered: `src/lib/idempotency.ts` used the "no actor/payload binding"
claim as the stated reason a 64-bit FNV digest is the ONLY thing separating two payloads, which is
the argument a future reader would lean on when deciding whether to widen that helper.

**Corrected to match the live catalog, read read-only on 2026-09-20:**

| RPC | intent-bound live? | comment now says |
|---|---|---|
| `adjust_inventory` | yes (actor + fingerprint) | server is the boundary |
| `create_inventory_hold` | yes (actor + fingerprint) | server is the boundary |
| `retire_inventory_item` | no — still key-only | unchanged, still key-only |
| `save_blend_recipe` | no — still key-only | unchanged, still key-only |

- `src/lib/idempotency.ts` — the KNOWN LIMIT block named `adjust_inventory` as key-only. It now
  names `retire_inventory_item` and `save_blend_recipe`, and says explicitly that the two inventory
  RPCs left that set.
- `src/pages/InventoryPage.tsx` — the block above `adjustIntent` said both RPCs "replay on the
  idempotency KEY ALONE" and that the hold binding was "still parked". Both are applied. It now
  names the two migrations and their apply dates and keeps the reason the frozen payload still
  matters (a replayable retry rather than a refusal an operator must resolve).
- `src/lib/section9IntentBoundReplay.test.ts` and `src/lib/gauntletFrontendSafetyGuards.test.ts` —
  same stale premise in their regression-guard comments.

**Deliberately NOT changed:** `src/pages/InventoryPage.tsx:981` and
`src/hooks/useUnresolvedIntent.ts` describe `retire_inventory_item` and `save_blend_recipe` as
key-only. The live catalog confirms both still are. Only the claims live contradicts were touched.

No behaviour changed — comments only, plus one `docs/manual/KNOWN_ISSUES.md` entry.

**Known residual accepted by Mason in chat, 2026-09-20:** `adjust_inventory` still accepts an
idempotency key carrying an ASCII control character beside a printable one. No live defect and no
caller can reach it; closing it would cost a new forward migration on a live money path plus a full
review cycle. Recorded in `KNOWN_ISSUES.md`, including the fact that no test covers that case and
that the written fix on `claude/bind-adjust-inventory-receipt-delivery-20260917` (`143da828f`) can
never be applied, because it edits an applied migration and its preflight no longer matches live.

**Proof observed.** `npm run typecheck` exit 0. `npx vitest run src/lib/section9IntentBoundReplay.test.ts
src/lib/gauntletFrontendSafetyGuards.test.ts src/lib/idempotency.test.ts` — 3 files, 43 tests passed.
Live state confirmed by read-only query against `rhyzpcqhnizqbxphqdkr`: ledger 1004 rows, the
migration present at version `20260920052149`, live `adjust_inventory` 4334 chars / md5
`22f1f7d0bd190ce74efb5ad3a8379677`, cutover trigger installed, and the four-RPC binding table above.

**Not verified.** No browser run — these are comment and documentation changes with no rendered
surface. The control-character behaviour is untested and remains so, by decision.
