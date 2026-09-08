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

test('matches valid literal RPC call syntax beyond a direct dot call', () => {
  const snapshot = snapshotFor('src/lib/call.ts', `
client.rpc ('dangerous_rpc');
client.rpc /* explanatory comment */ ('dangerous_rpc');
client.rpc?.(\`dangerous_rpc\`);
client['rpc']('dangerous_rpc');
client["rpc"]?.( "dangerous_rpc" );`);
  const sites = applicationRpcCallSites('dangerous_rpc', snapshot);
  assert.equal(sites.length, 5);
  assert.equal(unresolvedApplicationRpcCallSites(snapshotFor('src/lib/call.ts', `client.rpc('dangerous_rpc')`)).length, 0);
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
