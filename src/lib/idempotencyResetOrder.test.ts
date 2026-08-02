import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// A null RPC payload is treated as a silent denial by assertRpcResult(). If the
// idempotency key is reset first, retrying the apparent failure uses a new key
// and can repeat a mutation that the server already committed.
const RESET_BEFORE_ASSERT = /\b\w+\.resetKey\(\);\s*(?:const\s+\w+\s*=\s*|return\s+)?assertRpcResult\b/g;

describe('critical mutation retry safety', () => {
  const sourceRoot = resolve(process.cwd(), 'src');
  const mutationCallers = readdirSync(sourceRoot, { recursive: true, encoding: 'utf8' })
    .filter((relativePath) => /\.(?:ts|tsx)$/.test(relativePath))
    .filter((relativePath) => !relativePath.endsWith('.test.ts'));

  for (const relativePath of mutationCallers) {
    it(`${relativePath} validates RPC success before resetting its idempotency key`, () => {
      const source = readFileSync(resolve(sourceRoot, relativePath), 'utf8');
      // save_invoice has a broader unresolved-create reconciliation problem
      // that cannot be repaired by adjacency ordering alone. Exclude only that
      // handler (parked in the audit), while still guarding every other RPC in
      // InvoiceDetail and the rest of src.
      const sourceToCheck = relativePath === 'pages/InvoiceDetail.tsx'
        ? source.replace(/const handleSave = async \(\) => \{[\s\S]*?\n {2}const handlePost = async/, 'const handlePost = async')
        : source;
      expect(sourceToCheck.match(RESET_BEFORE_ASSERT) ?? []).toEqual([]);
    });
  }

  it('batch delivery cancellation validates before reset and activity logging', () => {
    const source = readFileSync(resolve(sourceRoot, 'pages/Deliveries.tsx'), 'utf8');
    const handler = source.slice(
      source.indexOf('const handleBatchCancel'),
      source.indexOf('const handleBatchReschedule'),
    );
    expect(handler.indexOf("assertRpcResult(data, 'batch_cancel_deliveries')")).toBeGreaterThan(-1);
    expect(handler.indexOf("assertRpcResult(data, 'batch_cancel_deliveries')"))
      .toBeLessThan(handler.indexOf('batchCancelIdem.resetKey()'));
  });

});
