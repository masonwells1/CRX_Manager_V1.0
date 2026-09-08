import assert from 'node:assert/strict';
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
assert.throws(
  () => authoritativeMainCommit({ execute: () => ({ status: 1, stdout: '', stderr: 'network unavailable' }) }),
  /could not read authoritative main from GitHub/,
);

console.log('protected-git: authoritative main binding checks passed');
