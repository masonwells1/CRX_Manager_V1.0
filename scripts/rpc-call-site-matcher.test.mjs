import assert from 'node:assert/strict';
import test from 'node:test';
import { applicationRpcCallSites, unresolvedApplicationRpcCallSites } from './rpc-call-site-matcher.mjs';

function snapshotFor(file, text) {
  return {
    paths(prefix, filter) {
      return file.startsWith(prefix) && filter(file) ? [file] : [];
    },
    text() { return text; },
  };
}

test('matches literal RPC routine names containing regular-expression characters', () => {
  for (const name of ['price$check', 'price^check', 'price[check]']) {
    const snapshot = snapshotFor('src/lib/call.ts', `const result = client.rpc('${name}');`);
    const sites = applicationRpcCallSites(name, snapshot);
    assert.equal(sites.length, 1, name);
    assert.match(sites[0], /frontend RPC: src\/lib\/call\.ts:1/);
  }
});

test('matches literal calls from every receiver and decodes JavaScript string escapes', () => {
  const snapshot = snapshotFor('src/lib/call.ts', `
client.rpc ('dangerous_rpc');
supabaseUntyped.rpc /* explanatory comment */ ('dangerous\\x5frpc');
api.rpc?.(\`dangerous_rpc\`);
service['rpc']('dangerous_rpc');
other["rpc"]?.( "dangerous_rpc" );`);
  const sites = applicationRpcCallSites('dangerous_rpc', snapshot);
  assert.equal(sites.length, 5);
  assert.equal(unresolvedApplicationRpcCallSites(snapshotFor('src/lib/call.ts', `client.rpc('dangerous_rpc')`)).length, 0);
});

test('does not treat strings, comments, or regular expressions as executable RPC access', () => {
  const snapshot = snapshotFor('src/lib/call.ts', `
const url = "https://example.test/api.rpc('not_a_call')";
const matcher = /client\\.rpc\\('not_a_call'\\)/;
// supabase.rpc('comment_only');
/* supabaseUntyped.rpc('block_comment_only'); */
supabaseUntyped.rpc('actual_rpc');`);
  assert.equal(applicationRpcCallSites('actual_rpc', snapshot).length, 1);
  assert.equal(applicationRpcCallSites('not_a_call', snapshot).length, 0);
  assert.deepEqual(unresolvedApplicationRpcCallSites(snapshot), []);
});

test('handles apostrophes in TSX prose without losing a following RPC call', () => {
  const snapshot = snapshotFor('src/lib/call.tsx', `<p>This customer's saved view is ready.</p>; supabaseUntyped.rpc('actual_rpc');`);
  assert.equal(applicationRpcCallSites('actual_rpc', snapshot).length, 1);
  assert.deepEqual(unresolvedApplicationRpcCallSites(snapshot), []);
});

test('handles multiline TSX attribute literals without losing a following RPC call', () => {
  const snapshot = snapshotFor('src/lib/call.tsx', `<input className="one\n  two" />; supabaseUntyped.rpc('actual_rpc');`);
  assert.equal(applicationRpcCallSites('actual_rpc', snapshot).length, 1);
  assert.deepEqual(unresolvedApplicationRpcCallSites(snapshot), []);
});

test('handles optional chaining inside a TSX template expression', () => {
  const snapshot = snapshotFor('src/lib/call.tsx', "<QuickTaskModal prefillContent={`Customer: ${customer?.farm_name || 'Unknown'}`} />; supabaseUntyped.rpc('actual_rpc');");
  assert.equal(applicationRpcCallSites('actual_rpc', snapshot).length, 1);
  assert.deepEqual(unresolvedApplicationRpcCallSites(snapshot), []);
});

test('handles a nested template expression without desynchronizing later source', () => {
  const snapshot = snapshotFor('src/lib/call.tsx', "const message = `outer ${condition ? `inner ${value}` : ''}`; supabaseUntyped.rpc('actual_rpc');");
  assert.equal(applicationRpcCallSites('actual_rpc', snapshot).length, 1);
  assert.deepEqual(unresolvedApplicationRpcCallSites(snapshot), []);
});

test('reports variable and interpolated RPC routine names as unresolved exposure', () => {
  const snapshot = snapshotFor('src/lib/call.ts', `
const routine = 'dangerous_rpc';
client.rpc(routine, {});
// client.rpc(commentOnly, {});
client.rpc(\`dangerous_\${suffix}\`, {});`);
  const sites = unresolvedApplicationRpcCallSites(snapshot);
  assert.equal(sites.length, 2);
  assert.match(sites[0], /src\/lib\/call\.ts:3/);
  assert.match(sites[1], /src\/lib\/call\.ts:5/);
});

test('fails closed for template expressions, computed calls, and indirect RPC access', () => {
  const snapshot = snapshotFor('src/lib/call.ts', [
    'const alias = client.rpc;',
    'alias(dynamicName);',
    'const message = `${client.rpc(dynamicName)}`;',
    'client[`rpc`](dynamicName);',
    '(client.rpc)(dynamicName);',
    "client[rpcKey]('dangerous_rpc');",
    "Reflect.get(client, 'rpc')('dangerous_rpc');",
    'const dispatch = client[rpcKey];',
    'dispatch(dynamicName);',
    "const reflectedDispatch = Reflect.get(client, 'rpc');",
    'reflectedDispatch(dynamicName);',
    'const api = supabase;',
    "api[rpcKey]('dangerous_rpc');",
    'const { rpc } = client;',
    'rpc(dynamicName);',
    'const { rpc: rawRpc } = client;',
    "rawRpc.bind(client)('dangerous_rpc');",
  ].join('\n'));
  const sites = unresolvedApplicationRpcCallSites(snapshot);
  assert.equal(sites.length, 11);
  assert.ok(sites.some((site) => site.includes(':1')));
  assert.ok(sites.some((site) => site.includes(':3')));
  assert.ok(sites.some((site) => site.includes(':4')));
  assert.ok(sites.some((site) => site.includes(':5')));
  assert.ok(sites.some((site) => site.includes(':6')));
  assert.ok(sites.some((site) => site.includes(':7')));
  assert.ok(sites.some((site) => site.includes(':8')));
  assert.ok(sites.some((site) => site.includes(':10')));
  assert.ok(sites.some((site) => site.includes(':13')));
  assert.ok(sites.some((site) => site.includes(':14')));
  assert.ok(sites.some((site) => site.includes(':16')));
  assert.equal(applicationRpcCallSites('literal_rpc', snapshotFor('src/lib/call.ts', "(client.rpc)('literal_rpc')")).length, 1);
});

test('fails closed for an RPC-looking call inside a template interpolation', () => {
  const snapshot = snapshotFor('src/lib/call.tsx', "const message = `${supabaseUntyped.rpc('hidden_rpc')}`;");
  assert.equal(applicationRpcCallSites('hidden_rpc', snapshot).length, 0);
  assert.equal(unresolvedApplicationRpcCallSites(snapshot).length, 1);
});

test('recovers direct callers after an unparseable template without treating a dynamic name as literal', () => {
  const snapshot = snapshotFor('src/lib/call.tsx', "const broken = `unterminated; supabaseUntyped.rpc('actual_rpc'); client.rpc(dynamicName);");
  assert.equal(applicationRpcCallSites('actual_rpc', snapshot).length, 1);
  assert.equal(unresolvedApplicationRpcCallSites(snapshot).length, 1);
});

test('captures escaped rpc member names and fails closed for malformed identifier escapes', () => {
  const escaped = snapshotFor('src/lib/call.ts', String.raw`client.r\u0070c('escaped_rpc');`);
  assert.equal(applicationRpcCallSites('escaped_rpc', escaped).length, 1);
  assert.deepEqual(unresolvedApplicationRpcCallSites(escaped), []);

  const malformed = snapshotFor('src/lib/call.ts', String.raw`client.r\u00GGc('missing_rpc');`);
  assert.equal(applicationRpcCallSites('missing_rpc', malformed).length, 0);
  assert.equal(unresolvedApplicationRpcCallSites(malformed).length, 1);
});
