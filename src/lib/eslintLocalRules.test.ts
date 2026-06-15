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
