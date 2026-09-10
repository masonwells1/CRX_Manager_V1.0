import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AUTHORITATIVE_MAIN_REMOTE, authoritativeMainCommit, parseAuthoritativeMainRef } from './protected-git.mjs';

const mainSha = '0123456789abcdef0123456789abcdef01234567';

assert.equal(parseAuthoritativeMainRef(`${mainSha}\trefs/heads/main\n`), mainSha);
assert.throws(() => parseAuthoritativeMainRef(''), /ambiguous ref list/);
assert.throws(() => parseAuthoritativeMainRef(`${mainSha}\trefs/heads/other\n`), /full main commit SHA/);
assert.throws(() => parseAuthoritativeMainRef(`${mainSha}\trefs/heads/main\n${mainSha}\trefs/heads/main\n`), /ambiguous ref list/);

let invocation;
const commit = authoritativeMainCommit({
  execute(binary, args, options) {
    invocation = { binary, args, options };
    return { status: 0, stdout: `${mainSha}\trefs/heads/main\n`, stderr: '' };
  },
});
assert.equal(commit, mainSha);
assert.match(invocation.binary, /git(?:\.exe)?$/i);
assert.deepEqual(invocation.args, ['--no-replace-objects', 'ls-remote', '--refs', AUTHORITATIVE_MAIN_REMOTE, 'refs/heads/main']);
assert.equal(invocation.options.timeout, 1500);
assert.equal(invocation.options.env.GIT_DIR, undefined);
assert.equal(invocation.options.env.GIT_CEILING_DIRECTORIES, invocation.options.cwd);
assert.equal(existsSync(path.join(invocation.options.cwd, '.git')), false);
assert.throws(
  () => authoritativeMainCommit({ execute: () => ({ status: 1, stdout: '', stderr: 'network unavailable' }) }),
  /could not read authoritative main from GitHub/,
);

// A checkout can rewrite the literal GitHub URL through url.*.insteadOf. The
// lookup must use its own empty cwd, so that hostile local configuration is not
// even eligible for Git to read.
const hostileCheckout = mkdtempSync(path.join(tmpdir(), 'crx-hostile-git-config-'));
const originalCwd = process.cwd();
try {
  mkdirSync(path.join(hostileCheckout, '.git'));
  writeFileSync(
    path.join(hostileCheckout, '.git', 'config'),
    `[url \"file:///attacker-controlled-repository\"]\n\tinsteadOf = ${AUTHORITATIVE_MAIN_REMOTE}\n`,
  );
  process.chdir(hostileCheckout);
  let hostileInvocation;
  authoritativeMainCommit({
    execute(binary, args, options) {
      hostileInvocation = { binary, args, options };
      return { status: 0, stdout: `${mainSha}\trefs/heads/main\n`, stderr: '' };
    },
  });
  assert.notEqual(path.resolve(hostileInvocation.options.cwd), path.resolve(hostileCheckout));
  assert.equal(hostileInvocation.options.env.GIT_CEILING_DIRECTORIES, hostileInvocation.options.cwd);
  assert.equal(existsSync(path.join(hostileInvocation.options.cwd, '.git')), false);
} finally {
  process.chdir(originalCwd);
  rmSync(hostileCheckout, { recursive: true, force: true, maxRetries: 3 });
}

console.log('protected-git: authoritative main binding checks passed');
