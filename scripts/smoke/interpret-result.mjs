export const PASS_TOKEN = 'SMOKE_PASS_ROLLBACK';

/** PASS iff the chain's terminal PostgreSQL error is the pass token. */
export function interpretResult(outputText) {
  const lines = outputText.split(/\r?\n/).filter((line) => line.trim());
  const postgresErrorMessage = (line) => line.match(/^(?:psql:.*:\d+: )?ERROR:\s+(.+)$/)?.[1] || null;

  if (lines.map(postgresErrorMessage).some((message) => message?.startsWith(PASS_TOKEN))) {
    return { pass: true };
  }

  const prereqLine = lines.find((line) => postgresErrorMessage(line)?.startsWith('SMOKE_PREREQ:'));
  if (prereqLine) return { pass: false, prereq: true, message: prereqLine.trim() };

  const errLine =
    lines.find((line) => /SMOKE_FAIL|SMOKE_SETUP/.test(line)) ||
    lines.find((line) => /ERROR:|FATAL:/.test(line)) ||
    lines[lines.length - 1] ||
    '(no output)';
  return { pass: false, message: errLine.trim() };
}
