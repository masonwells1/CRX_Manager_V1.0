import assert from 'node:assert/strict';
import test from 'node:test';
import { applicationRpcCallSites } from './rpc-call-site-matcher.mjs';

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
});
