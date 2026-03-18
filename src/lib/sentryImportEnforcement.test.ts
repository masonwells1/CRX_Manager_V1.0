import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const ALLOWED_FILES = ['sentry.ts', 'AuthContext.tsx', 'useOCRProcessor.ts'];

function findSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory() && !entry.includes('node_modules')) {
      results.push(...findSourceFiles(fullPath));
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.includes('.test.')) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('Sentry import enforcement', () => {
  it('no files import directly from @sentry/react except allowed exceptions', () => {
    const srcDir = join(__dirname, '..');
    const files = findSourceFiles(srcDir);
    const violations: string[] = [];

    for (const file of files) {
      const isAllowed = ALLOWED_FILES.some((f) => file.endsWith(f));
      if (isAllowed) continue;

      const content = readFileSync(file, 'utf-8');
      if (
        content.includes("from '@sentry/react'") ||
        content.includes('from "@sentry/react"')
      ) {
        const relPath = file.replace(srcDir, 'src');
        violations.push(relPath);
      }
    }

    expect(
      violations,
      `Found ${violations.length} files importing directly from @sentry/react:\n` +
        violations.join('\n')
    ).toHaveLength(0);
  });
});
