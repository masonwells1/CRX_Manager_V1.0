import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('logActivity signature safety', () => {
  it('logActivity accepts a single object param, not positional strings', () => {
    const filePath = join(__dirname, 'activityLogger.ts');
    const content = readFileSync(filePath, 'utf-8');

    expect(content).toContain('interface LogActivityParams');
    expect(content).toContain('params: LogActivityParams');

    // Verify old positional signature is gone
    expect(content).not.toMatch(/logActivity\(\s*eventType:\s*string/);
    expect(content).not.toMatch(/logActivity\(\s*\n\s*eventType:\s*string/);
  });

  it('LogActivityParams has required performedBy field', () => {
    const filePath = join(__dirname, 'activityLogger.ts');
    const content = readFileSync(filePath, 'utf-8');

    // performedBy must be required (no ? mark)
    expect(content).toMatch(/performedBy:\s*string\s*[;,]/);
    expect(content).not.toMatch(/performedBy\?:\s*string/);
  });
});
