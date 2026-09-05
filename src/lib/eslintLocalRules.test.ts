/**
 * Regression tests for the C6 local ESLint rules
 * (docs/audits/2026-06-10-error-prevention-review.md §4 C6):
 *
 *  - local-rules/assert-rpc-result-arg-shape — assertRpcResult(X) must get
 *    the unwrapped rpc `data`, never the whole {data,error} response
 *    (2026-05-28 P1B: passing the envelope makes the guard a no-op).
 *  - local-rules/idempotency-key-from-hook — p_idempotency_key must come
 *    from useIdempotencyKey().getKey(), never a key minted fresh at the
 *    callsite (financial-reversal double-execution class).
 *
 * The lint run itself proves zero false positives on the current codebase;
 * these tests prove the rules still CATCH the bug classes (true positives)
 * and pin the tuning decisions (what is allowed) against future edits.
 */
import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const argShapeRule = require('../../eslint-local-rules/rules/assert-rpc-result-arg-shape.cjs');
const idemKeyRule = require('../../eslint-local-rules/rules/idempotency-key-from-hook.cjs');
const handleSupabaseErrorRule = require('../../eslint-local-rules/rules/handle-supabase-error.cjs');
const requireCheckMutationResultRule = require('../../eslint-local-rules/rules/require-check-mutation-result.cjs');
const requireSupabaseErrorCaptureRule = require('../../eslint-local-rules/rules/require-supabase-error-capture.cjs');

// Wire RuleTester into vitest's describe/it
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

// -------------------------------------------------------------------------
// assert-rpc-result-arg-shape
// -------------------------------------------------------------------------

ruleTester.run('assert-rpc-result-arg-shape', argShapeRule, {
  valid: [
    // canonical destructure
    `async function f() {
      const { data, error } = await supabase.rpc('save_quote', {});
      if (error) throw error;
      assertRpcResult(data, 'save_quote');
    }`,
    // destructured alias (Reports.tsx batchResult pattern)
    `async function f() {
      const { data: batchResult, error } = await supabase.rpc('get_batch_year_end_summaries', {});
      assertRpcResult(batchResult, 'get_batch_year_end_summaries');
    }`,
    // member expression `.data` off a captured response
    `async function f() {
      const response = await supabase.rpc('save_quote', {});
      assertRpcResult(response.data, 'save_quote');
    }`,
    // unrelated identifier — not an rpc response
    `async function f() {
      const data = computeSomething();
      assertRpcResult(data, 'whatever');
    }`,
    // chained rpc call destructured (`.single()` etc.)
    `async function f() {
      const { data } = await supabase.rpc('x', {}).single();
      assertRpcResult(data, 'x');
    }`,
    // object literal WITHOUT the {data,error} pair
    `assertRpcResult({ data: rows }, 'x');`,
  ],
  invalid: [
    // THE P1B bug: whole response captured then asserted
    {
      code: `async function f() {
        const result = await supabase.rpc('reverse_write_off', {});
        assertRpcResult(result, 'reverse_write_off');
      }`,
      errors: [{ messageId: 'wholeResponse' }],
    },
    // whole response via a chained call
    {
      code: `async function f() {
        const result = await supabase.rpc('post_invoice', {}).throwOnError();
        assertRpcResult(result, 'post_invoice');
      }`,
      errors: [{ messageId: 'wholeResponse' }],
    },
    // whole response via later reassignment
    {
      code: `async function f() {
        let result;
        result = await supabase.rpc('void_order', {});
        assertRpcResult(result, 'void_order');
      }`,
      errors: [{ messageId: 'wholeResponse' }],
    },
    // inline await of the whole response
    {
      code: `async function f() {
        assertRpcResult(await supabase.rpc('cancel_order', {}), 'cancel_order');
      }`,
      errors: [{ messageId: 'inlineResponse' }],
    },
    // inline {data,error} pair (re-wrapping the envelope)
    {
      code: `assertRpcResult({ data, error }, 'x');`,
      errors: [{ messageId: 'dataErrorPair' }],
    },
  ],
});

// -------------------------------------------------------------------------
// idempotency-key-from-hook
// -------------------------------------------------------------------------

ruleTester.run('idempotency-key-from-hook', idemKeyRule, {
  valid: [
    // canonical: hook object + inline getKey()
    `async function f() {
      await supabase.rpc('complete_delivery', { p_idempotency_key: completeIdem.getKey() });
    }`,
    // canonical: getKey() into a const first (idemKey pattern)
    `async function f() {
      const idemKey = voidIdem.getKey();
      await supabase.rpc('void_delivery', { p_idempotency_key: idemKey });
    }`,
    // destructured getKey from the hook
    `async function f() {
      const { getKey } = useIdempotencyKey('batch_adjust', userId);
      await supabase.rpc('adjust_inventory', { p_idempotency_key: getKey() });
    }`,
    // data-object member (BulkOrderImport pattern — key persisted on the row)
    `async function f(order) {
      await supabase.rpc('bulk_import_order', { p_idempotency_key: order.idempotency_key });
    }`,
    // ref-cache pattern (Rebates transitionKeysRef — mixed writes stay allowed)
    `async function f() {
      let idempotencyKey = keysRef.current.get(scope);
      if (!idempotencyKey) {
        idempotencyKey = generateIdempotencyKey('transition_rebate_claim', userId);
        keysRef.current.set(scope, idempotencyKey);
      }
      await supabase.rpc('transition_rebate_claim', { p_idempotency_key: idempotencyKey });
    }`,
    // function parameter — unresolvable, fail-open
    `async function f(key) {
      await supabase.rpc('save_quote', { p_idempotency_key: key });
    }`,
  ],
  invalid: [
    // THE double-execution bug: fresh UUID per call
    {
      code: `async function f() {
        await supabase.rpc('reverse_write_off', { p_idempotency_key: crypto.randomUUID() });
      }`,
      errors: [{ messageId: 'freshKey' }],
    },
    // fresh UUID via intermediate const
    {
      code: `async function f() {
        const idemKey = crypto.randomUUID();
        await supabase.rpc('void_payment', { p_idempotency_key: idemKey });
      }`,
      errors: [{ messageId: 'freshKey' }],
    },
    // Date.now() key
    {
      code: `async function f() {
        await supabase.rpc('allocate_payment', { p_idempotency_key: 'pay:' + Date.now() });
      }`,
      errors: [{ messageId: 'freshKey' }],
    },
    // template literal minted at the callsite
    {
      code: `async function f() {
        await supabase.rpc('cancel_order', { p_idempotency_key: \`cancel:\${id}:\${Date.now()}\` });
      }`,
      errors: [{ messageId: 'freshKey' }],
    },
    // bare string literal (every user/click shares one key)
    {
      code: `async function f() {
        await supabase.rpc('post_invoice', { p_idempotency_key: 'post-invoice-key' });
      }`,
      errors: [{ messageId: 'freshKey' }],
    },
    // uuid library call
    {
      code: `async function f() {
        await supabase.rpc('save_job', { p_idempotency_key: uuidv4() });
      }`,
      errors: [{ messageId: 'freshKey' }],
    },
    // inline generateIdempotencyKey — fresh per call, must be hook/ref-cached
    {
      code: `async function f() {
        await supabase.rpc('save_field', { p_idempotency_key: generateIdempotencyKey('save_field', userId) });
      }`,
      errors: [{ messageId: 'freshKey' }],
    },
  ],
});

// -------------------------------------------------------------------------
// handle-supabase-error — C3 / Field Mode F4 + F6
// -------------------------------------------------------------------------

ruleTester.run('handle-supabase-error', handleSupabaseErrorRule, {
  valid: [
    // positive check: if (error) throw
    `async function f() {
      const { data, error } = await supabase.from('orders').select('*');
      if (error) throw error;
      return data;
    }`,
    // positive check on an aliased binding
    `async function f() {
      const { error: uploadError } = await supabase.storage.from('sigs').upload(p, blob);
      if (uploadError) { toast(uploadError.message); return; }
    }`,
    // !error gate WITH an else that handles the error
    `async function f() {
      const { data, error } = await supabase.from('jobs').select('*');
      if (!error) { setRows(data); } else { toast('failed'); throw error; }
    }`,
    // handed to the checkMutationResult convention
    `async function f() {
      const { data, error } = await supabase.from('invoices').update({ x: 1 }).eq('id', id).select();
      checkMutationResult({ data, error }, 'update invoice');
    }`,
    // ternary / member use counts as handling
    `async function f() {
      const { data, error } = await supabase.from('products').select('*');
      const rows = error ? [] : data;
      return rows;
    }`,
    // rpc() is intentionally NOT this rule's concern (require-assert-rpc-result owns it)
    `async function f() {
      const { data, error } = await supabase.rpc('save_quote', {});
      return data;
    }`,
    // not the supabase client — unrelated destructure
    `async function f() {
      const { data, error } = await fetchThing();
      return data;
    }`,
    // error not destructured at all — out of scope (different shape)
    `async function f() {
      const { data } = await supabase.from('orders').select('*');
      return data;
    }`,
  ],
  invalid: [
    // F6: error destructured from a select but never inspected
    {
      code: `async function f() {
        const { data, error } = await supabase.from('orders').select('*');
        setRows(data);
      }`,
      errors: [{ messageId: 'unhandled' }],
    },
    // F4: storage upload, only an `if (!error)` success-gate, no else / no throw
    {
      code: `async function f() {
        const { error: uploadError } = await supabase.storage.from('sigs').upload(p, blob);
        if (!uploadError) {
          await commitRecord();
        }
      }`,
      errors: [{ messageId: 'unhandled' }],
    },
    // single() detail fetch — error ignored
    {
      code: `async function f() {
        const { data, error } = await supabase.from('jobs').select('*').eq('id', id).single();
        return data;
      }`,
      errors: [{ messageId: 'unhandled' }],
    },
    // mutation with destructured-but-unused error
    {
      code: `async function f() {
        const { error } = await supabase.from('orders').delete().eq('id', id);
        toast('deleted');
      }`,
      errors: [{ messageId: 'unhandled' }],
    },
  ],
});

// -------------------------------------------------------------------------
// require-check-mutation-result — AGENTS.md CRX Hard Rule
// (fire-and-forget supabase .update()/.delete() whose result is discarded;
//  the gap handle-supabase-error leaves open — no destructure, no check).
// -------------------------------------------------------------------------

ruleTester.run('require-check-mutation-result', requireCheckMutationResultRule, {
  valid: [
    // canonical: captured + passed to checkMutationResult by name
    `async function f() {
      const result = await supabase.from('orders').update({ x: 1 }).eq('id', id).select();
      checkMutationResult(result, 'update order');
    }`,
    // canonical: delete captured + checked
    `async function f() {
      const result = await supabase.from('overrides').delete().eq('id', id).select();
      checkMutationResult(result, 'delete override');
    }`,
    // inline: checkMutationResult wrapping the awaited mutation
    `async function f() {
      checkMutationResult(await supabase.from('orders').update({ x: 1 }).eq('id', id).select(), 'update order');
    }`,
    // destructured { data, error } — handle-supabase-error owns this, do NOT double-report
    `async function f() {
      const { data, error } = await supabase.from('orders').update({ x: 1 }).eq('id', id).select();
      if (error) throw error;
      return data;
    }`,
    // destructured { error } only — also handle-supabase-error's
    `async function f() {
      const { error } = await supabase.from('orders').delete().eq('id', id);
      if (error) throw error;
    }`,
    // return await — caller checks
    `async function f() {
      return await supabase.from('orders').update({ x: 1 }).eq('id', id).select();
    }`,
    // arrow-body return — caller checks
    `const f = (id) => supabase.from('orders').delete().eq('id', id);`,
    // captured then handled via member access (Notifications/Rebates zero-rows-valid pattern)
    `async function f() {
      const result = await supabase.from('notifications').update({ is_read: true }).eq('id', id).select();
      if (result.error) throw result.error;
    }`,
    // captured then passed to another function (used in a larger expression)
    `async function f() {
      const result = await supabase.from('orders').update({ x: 1 }).eq('id', id).select();
      logIt(result);
    }`,
    // rpc() is NOT this rule's concern (require-assert-rpc-result owns it)
    `async function f() {
      await supabase.rpc('void_order', { p_order_id: id });
    }`,
    // a plain JS Map/Set .delete() — no .from(), so never matched
    `function f(map, id) {
      map.delete(id);
    }`,
    // a non-supabase client .update() — root identifier isn't 'supabase'
    `async function f() {
      await store.from('orders').update({ x: 1 });
    }`,
    // a supabase .select() (read, not a mutation) — not flagged
    `async function f() {
      await supabase.from('orders').select('*').eq('id', id);
    }`,
  ],
  invalid: [
    // THE fire-and-forget bug: bare-statement mutation, result discarded
    {
      code: `async function f() {
        await supabase.from('orders').update({ x: 1 }).eq('id', id);
      }`,
      errors: [{ messageId: 'discarded' }],
    },
    // fire-and-forget delete
    {
      code: `async function f() {
        await supabase.from('orders').delete().eq('id', id);
      }`,
      errors: [{ messageId: 'discarded' }],
    },
    // fire-and-forget with a trailing .select() (still discarded as a bare statement)
    {
      code: `async function f() {
        await supabase.from('orders').update({ x: 1 }).eq('id', id).select();
      }`,
      errors: [{ messageId: 'discarded' }],
    },
    // captured to a var that is NEVER read at all (a dead capture)
    {
      code: `async function f() {
        const result = await supabase.from('orders').update({ x: 1 }).eq('id', id).select();
      }`,
      errors: [{ messageId: 'discarded' }],
    },
  ],
});

// -------------------------------------------------------------------------
// require-supabase-error-capture — the OTHER half of handle-supabase-error:
// `data` taken from a .from()/.storage read but `error` never even captured
// (the AccountsReceivable prepay + Receiving Hub $0/empty bug class, 2026-06-24).
// -------------------------------------------------------------------------

ruleTester.run('require-supabase-error-capture', requireSupabaseErrorCaptureRule, {
  valid: [
    // both captured — handle-supabase-error then owns whether `error` is handled
    `async function f() {
      const { data, error } = await supabase.from('prepay_credits').select('balance_cents');
      if (error) throw error;
      return data;
    }`,
    // aliased data + error both captured
    `async function f() {
      const { data: rows, error: err } = await supabase.from('orders').select('*');
      if (err) throw err;
      return rows;
    }`,
    // error-only destructure (a mutation check) — nothing dropped
    `async function f() {
      const { error } = await supabase.from('orders').delete().eq('id', id);
      if (error) throw error;
    }`,
    // rpc() is out of scope (require-assert-rpc-result owns it)
    `async function f() {
      const { data } = await supabase.rpc('get_inventory_position');
      return assertRpcResult(data, 'get_inventory_position');
    }`,
    // not the supabase client
    `async function f() {
      const { data } = await fetchThing();
      return data;
    }`,
  ],
  invalid: [
    // the AccountsReceivable prepay bug: data taken, error dropped → silent $0
    {
      code: `async function f() {
        const { data: prepayRows } = await supabase.from('prepay_credits').select('balance_cents');
        return (prepayRows || []).reduce((s, r) => s + r.balance_cents, 0);
      }`,
      errors: [{ messageId: 'missingError' }],
    },
    // the Receiving Hub bug: a failed PO load looks like "nothing on order"
    {
      code: `async function f() {
        const { data } = await supabase.from('purchase_orders').select('*').in('status', ['submitted']);
        return data || [];
      }`,
      errors: [{ messageId: 'missingError' }],
    },
    // storage read with data-only
    {
      code: `async function f() {
        const { data } = await supabase.storage.from('sigs').createSignedUrl(p, 60);
        return data;
      }`,
      errors: [{ messageId: 'missingError' }],
    },
  ],
});
