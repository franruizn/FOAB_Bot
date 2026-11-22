import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renameWithRetry } from './fileStore.js';

const fsError = (code) => Object.assign(new Error(code), { code });

/** rename falso que falla las primeras `failures` veces con `code`. */
function flakyRename(failures, code = 'EPERM') {
  const fn = async () => {
    fn.calls++;
    if (fn.calls <= failures) throw fsError(code);
  };
  fn.calls = 0;
  return fn;
}

const options = (renameFn, platform = 'win32') => {
  const waits = [];
  return { platform, renameFn, waits, wait: async (ms) => waits.push(ms) };
};

test('rename: sin fallo no espera', async () => {
  const renameFn = flakyRename(0);
  const opts = options(renameFn);
  await renameWithRetry('a', 'b', opts);
  assert.equal(renameFn.calls, 1);
  assert.deepEqual(opts.waits, []);
});

test('rename: en Windows reintenta EPERM y acaba bien', async () => {
  const renameFn = flakyRename(3);
  const opts = options(renameFn);
  await renameWithRetry('a', 'b', opts);
  assert.equal(renameFn.calls, 4);
  assert.deepEqual(opts.waits, [20, 50, 100]);
});

test('rename: tras tres reintentos propaga el error', async () => {
  const renameFn = flakyRename(10);
  await assert.rejects(renameWithRetry('a', 'b', options(renameFn)), { code: 'EPERM' });
  assert.equal(renameFn.calls, 4);
});

test('rename: otro error no se reintenta', async () => {
  const renameFn = flakyRename(10, 'ENOSPC');
  await assert.rejects(renameWithRetry('a', 'b', options(renameFn)), { code: 'ENOSPC' });
  assert.equal(renameFn.calls, 1);
});

test('rename: en Linux EPERM no se reintenta', async () => {
  const renameFn = flakyRename(10);
  await assert.rejects(renameWithRetry('a', 'b', options(renameFn, 'linux')), { code: 'EPERM' });
  assert.equal(renameFn.calls, 1);
});
