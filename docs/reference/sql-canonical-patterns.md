# SQL & code canonical patterns (CRX Manager)

> Extracted from `CLAUDE.md` on 2026-06-15 to keep the always-loaded file lean. **Read this before writing any
> migration, RPC, or `.update()/.delete()`.** These are the copy-paste templates and canonical conventions; the
> deterministic hooks in `.claude/hooks/` enforce the critical ones automatically (see `docs/reference/agent-guardrails.md`).

---

### ⚠️ COPY-PASTE CHECKLIST — Read Before Writing ANY Code ⚠️

**Before writing a SQL function that touches `idempotency_keys`:**
PREFER the canonical `check_idempotency`/`save_idempotency` helpers (see
"Canonical Patterns for New RPCs" below). If you must inline, copy this
exactly — the lookup MUST be scoped to the function's own operation name
(an unscoped key-only lookup returns ANY operation's cached row on a key
collision — the restore_quote_version bug class; 22 live RPCs had to be
swept because this snippet used to omit the filter — 20 via the staged
`idempotency_operation_scope_sweep` migration, 2 via the planned-holds
drawn-sync rebuild):
```sql
-- CORRECT inline pattern — copy this exactly (v_existing is jsonb):
IF p_idempotency_key IS NOT NULL THEN
  SELECT result INTO v_existing
    FROM idempotency_keys
    WHERE idempotency_key = p_idempotency_key   -- NOT "key"
      AND operation = 'my_rpc_name';            -- ALWAYS scope to THIS function's name
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
END IF;

-- At end of function (result column is jsonb — NEVER a bare ::text value):
INSERT INTO idempotency_keys (idempotency_key, operation, result)  -- NOT key/entity_type/entity_id
VALUES (p_idempotency_key, 'my_rpc_name', jsonb_build_object('id', v_id));
```

**Before writing a SECURITY DEFINER function:**
```sql
SECURITY DEFINER
SET search_path = public, pg_temp   -- ALWAYS include pg_temp
```

**Before writing a supabase `.update()` or `.delete()`:**
```typescript
const result = await supabase.from('table').update({ col: val }).eq('id', id).select();
checkMutationResult(result, 'Context description');  // ALWAYS — import from lib/db
```

**Before writing a confirmation dialog:**
```typescript
// NEVER: confirm(), window.confirm(), alert(), window.alert()
// ALWAYS: ConfirmModal component — see existing usage in any page
```

**Before writing `logActivity()`:**
```typescript
// Uses object parameter — NOT positional args
// performedBy is ALWAYS profile.id — never a string like 'delivery'
await logActivity({ event: 'event_type', description: 'Description', performedBy: profile.id, entityType: 'entity_type', entityId: entityId });
```

**Before importing Sentry:**
```typescript
// NEVER: import * as Sentry from '@sentry/react'
// ALWAYS: import { Sentry } from '../lib/sentry'
```

### Canonical Patterns for New RPCs (MANDATORY going forward)

These patterns avoid the drift the 2026-05-07 final-wave-review surfaced (3 coexisting error-shape conventions, 2 idempotency patterns, fragile substring-matching of error tokens).

**Error tokens (machine-readable):**
- SQL raises `'TOKEN'` or `'TOKEN: human readable suffix'` — short SCREAMING_SNAKE codes, never freeform English-only messages.
- Register every new token in the `RpcErrorCodes` const in [src/lib/db.ts](../../src/lib/db.ts). The `as const` + `RpcErrorCode` indexed-access type makes typos at callsites a compile error.
- TS callers detect with `hasRpcCode(err, RpcErrorCodes.X)` — NEVER `message.includes('TOKEN')` (substring matching false-positives if the token text appears in a user-supplied note).

**Idempotency (helper-function pattern preferred):**
```sql
-- At top of body, BEFORE any mutation:
IF p_idempotency_key IS NOT NULL THEN
  v_existing := check_idempotency(p_idempotency_key, 'my_rpc_name');
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
END IF;

-- ... do the mutation ...

-- At end:
IF p_idempotency_key IS NOT NULL THEN
  PERFORM save_idempotency(p_idempotency_key, 'my_rpc_name', v_result);
END IF;
```
The `check_idempotency` / `save_idempotency` helpers (defined in `20260210000000_tier3_idempotency_and_triggers.sql`, both have `search_path = public, pg_temp`) are the canonical pattern. Inline raw-SQL idempotency lookups still exist in some 2026-05-07 migrations (`create_inventory_hold`, `mark_inventory_row_verified`) — those are NOT precedent for new code. The guard recognizes correctly paired helper calls, so normal helper use requires no exemption marker. Reserve the file-level `-- idempotency-body-check: exempt` marker for valid SQL the guard cannot parse or a wrapper that genuinely delegates idempotency; because it disables this check for the whole migration file, a manual review must inspect every function in that file.

**Strict-actor pattern (until shared helper exists):**
```sql
v_actor := auth.uid();
IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
  RAISE EXCEPTION 'ACTOR_MISMATCH';
END IF;
```
Use `IS DISTINCT FROM` (handles NULL safely) and the machine-readable codes above. Two spellings of this block currently coexist in the codebase; this one is the canonical going-forward shape.

**Return shape (mutating RPCs):**
- Mutating RPCs SHOULD return `jsonb_build_object('success', true, ...payload)`.
- Idempotent no-op RPCs (e.g. "already verified") return `'success', true, 'no_op', true, 'reason', 'why'` so the UI can differentiate "did the work" from "didn't need to."
- TS callers MUST wrap result data with `assertRpcResult<T>(data, 'rpc_name')` (enforced by `local-rules/require-assert-rpc-result` ESLint rule).

