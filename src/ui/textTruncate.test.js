import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncateList } from './textTruncate.js';

test('si todo cabe, une las líneas tal cual', () => {
  assert.equal(truncateList(['a', 'b', 'c'], 100), 'a\nb\nc');
});

test('si no cabe todo, corta y añade "+N más" sin partir ninguna línea', () => {
  const lines = ['aaaa', 'bbbb', 'cccc', 'dddd'];
  // "aaaa\nbbbb" (9) + "\n… +2 más" (9) = 18 cabe justo; el string completo
  // (19) no, y añadir "cccc" tampoco.
  const result = truncateList(lines, 18);
  assert.equal(result, 'aaaa\nbbbb\n… +2 más');
});

test('si no cabe ni la primera línea con el sufijo, devuelve solo "+N más"', () => {
  const lines = ['línea muy larga que no cabe', 'otra'];
  const result = truncateList(lines, 10);
  assert.equal(result, '… +2 más');
});

test('lista vacía', () => {
  assert.equal(truncateList([], 100), '');
});

test('separator/formatSuffix personalizados: lista " · " con "+N"', () => {
  const lines = ['Maza Pesada ★★★★', 'HOJ ★', 'Santi ★★', 'Perma'];
  // "Maza Pesada ★★★★ · HOJ ★" (23) + " · +2" (5) = 28 cabe en 30; añadir "Santi ★★" no.
  const result = truncateList(lines, 30, { separator: ' · ', formatSuffix: (n) => `+${n}` });
  assert.equal(result, 'Maza Pesada ★★★★ · HOJ ★ · +2');
});
