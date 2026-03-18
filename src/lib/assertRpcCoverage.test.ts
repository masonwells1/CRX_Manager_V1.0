import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

function findSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory() && !entry.includes('node_modules') && !entry.includes('.test')) {
      results.push(...findSourceFiles(fullPath));
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.includes('.test.')) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('assertRpcResult coverage', () => {
  it('every supabase.rpc() call that uses data must call assertRpcResult', () => {
    const srcDir = join(__dirname, '..');
    const files = findSourceFiles(srcDir);
    const violations: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const rpcPattern = /\{\s*data[^}]*\}\s*=\s*await\s+supabase\.rpc\(\s*['"]([^'"]+)['"]/g;
      let match;

      while ((match = rpcPattern.exec(content)) !== null) {
        const rpcName = match[1];
        if (!content.includes('assertRpcResult')) {
          const lineNum = content.substring(0, match.index).split('\n').length;
          const relPath = file.replace(srcDir, 'src');
          violations.push(
            `${relPath}:${lineNum} — ${rpcName} data used without assertRpcResult`
          );
        }
      }
    }

    expect(
      violations,
      `Found ${violations.length} RPC calls without assertRpcResult:\n${violations.join('\n')}`
    ).toHaveLength(0);
  });
});
