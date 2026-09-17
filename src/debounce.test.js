import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDebouncer } from './debounce.js';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('agrupa varios triggers de la misma key en UNA sola ejecución, con la última función registrada', async () => {
  const debouncer = createDebouncer(20);
  const seen = [];

  debouncer.trigger('a', () => seen.push('primera'));
  debouncer.trigger('a', () => seen.push('segunda'));
  debouncer.trigger('a', () => seen.push('tercera'));

  await wait(40);
  assert.deepEqual(seen, ['tercera']);
});

test('keys distintas no se agrupan entre sí', async () => {
  const debouncer = createDebouncer(20);
  const seen = [];

  debouncer.trigger('a', () => seen.push('a'));
  debouncer.trigger('b', () => seen.push('b'));

  await wait(40);
  assert.deepEqual(seen.sort(), ['a', 'b']);
});

test('un nuevo trigger reinicia la ventana de esa key', async () => {
  const debouncer = createDebouncer(30);
  const seen = [];

  debouncer.trigger('a', () => seen.push('primera'));
  await wait(20); // no debe disparar been menos de 30ms
  debouncer.trigger('a', () => seen.push('segunda')); // reinicia la ventana
  await wait(20);
  assert.deepEqual(seen, []); // todavía no, la segunda ventana no ha vencido (20 < 30)

  await wait(20);
  assert.deepEqual(seen, ['segunda']);
});

test('flush ejecuta ya la tarea pendiente sin esperar la ventana', async () => {
  const debouncer = createDebouncer(10_000);
  const seen = [];

  debouncer.trigger('a', () => seen.push('a'));
  await debouncer.flush('a');
  assert.deepEqual(seen, ['a']);
});

test('flush sobre una key sin nada pendiente no hace nada', async () => {
  const debouncer = createDebouncer(10_000);
  await assert.doesNotReject(() => debouncer.flush('no-existe'));
});

test('flushAll ejecuta todas las tareas pendientes de golpe', async () => {
  const debouncer = createDebouncer(10_000);
  const seen = [];

  debouncer.trigger('a', () => seen.push('a'));
  debouncer.trigger('b', () => seen.push('b'));
  debouncer.trigger('c', () => seen.push('c'));

  await debouncer.flushAll();
  assert.deepEqual(seen.sort(), ['a', 'b', 'c']);
});

test('cancel descarta la tarea pendiente de una key sin ejecutarla', async () => {
  const debouncer = createDebouncer(20);
  const seen = [];

  debouncer.trigger('a', () => seen.push('a'));
  debouncer.cancel('a');

  await wait(40);
  assert.deepEqual(seen, []);
});

test('cancel sobre una key sin nada pendiente no hace nada', () => {
  const debouncer = createDebouncer(10_000);
  assert.doesNotThrow(() => debouncer.cancel('no-existe'));
});

test('tras cancel, un trigger posterior de la misma key funciona con normalidad', async () => {
  const debouncer = createDebouncer(20);
  const seen = [];

  debouncer.trigger('a', () => seen.push('descartada'));
  debouncer.cancel('a');
  debouncer.trigger('a', () => seen.push('nueva'));

  await wait(40);
  assert.deepEqual(seen, ['nueva']);
});

test('un error en la tarea no rompe el debouncer ni bloquea futuros triggers', async () => {
  const debouncer = createDebouncer(10);
  const seen = [];

  debouncer.trigger('a', () => {
    throw new Error('forzado');
  });
  await wait(30);

  debouncer.trigger('a', () => seen.push('sigue funcionando'));
  await wait(30);

  assert.deepEqual(seen, ['sigue funcionando']);
});
