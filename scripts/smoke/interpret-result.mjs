export const PASS_TOKEN = 'SMOKE_PASS_ROLLBACK';

/** PASS iff the chain's terminal PostgreSQL error is the pass token. */
export function interpretResult(outputText) {
  const lines = outputText.split(/\r?\n/).filter((line) => line.trim());
  const postgresErrorMessage = (line) => line.match(/^(?:psql:.*:\d+: )?ERROR:\s+(.+)$/)?.[1] || null;

  // ALLOWLIST the delimiters real pass messages use; do not enumerate the
  // characters that could extend an identifier. Three review rounds proved the
  // deny-the-extenders direction never terminates: bare startsWith() accepted
  // SMOKE_PASS_ROLLBACK_BUT_FAILED (Sol), excluding [A-Za-z0-9_] accepted the
  // $-extended form (CodeRabbit — identifiers may contain $), and excluding $
  // too still accepted non-ASCII identifier letters like é and λ (Sol,
  // reproduced read-only). Every real pass raise is either the bare token or
  // the token followed by a space or an open parenthesis — accept exactly
  // those shapes and nothing else.
  const isPassToken = (message) =>
    message === PASS_TOKEN ||
    message?.startsWith(PASS_TOKEN + ' ') ||
    message?.startsWith(PASS_TOKEN + '(');
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
