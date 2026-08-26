export const PASS_TOKEN = 'SMOKE_PASS_ROLLBACK';

/** PASS iff the chain's terminal PostgreSQL error is the pass token. */
export function interpretResult(outputText) {
  const lines = outputText.split(/\r?\n/).filter((line) => line.trim());
  const postgresErrorMessage = (line) => line.match(/^(?:psql:.*:\d+: )?ERROR:\s+(.+)$/)?.[1] || null;

  // The token must be the whole message or be followed by a non-identifier
  // character — bare startsWith() also accepted identifiers that merely EXTEND
  // the token, e.g. SMOKE_PASS_ROLLBACK_BUT_FAILED (Sol, 2026-08-26).
  const isPassToken = (message) =>
    message === PASS_TOKEN ||
    (message?.startsWith(PASS_TOKEN) && /^[^A-Za-z0-9_]/.test(message.slice(PASS_TOKEN.length)));
  if (lines.map(postgresErrorMessage).some(isPassToken)) {
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
