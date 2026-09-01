import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDebouncer } from './debounce.js';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('trigger() no ejecuta la tarea antes de que pase delayMs', async () => {
  const debouncer = createDebouncer(40);
  let calls = 0;
  debouncer.trigger('k', () => {
    calls++;
  });
  await wait(10);
  assert.equal(calls, 0);
  await wait(60);
  assert.equal(calls, 1);
});

test('trigger() repetido REINICIA la espera (debounce, no throttle): una sola ejecución, con la última tarea', async () => {
  const debouncer = createDebouncer(40);
  const seen = [];

  debouncer.trigger('k', () => seen.push('primera'));
  await wait(20); // dentro de la ventana: debe reiniciar, no disparar aún
  debouncer.trigger('k', () => seen.push('segunda'));
  await wait(20); // sigue dentro de la ventana reiniciada
  debouncer.trigger('k', () => seen.push('tercera'));

  await wait(20);
  assert.deepEqual(seen, [], 'no debe haber disparado todavía (cada trigger reinicia los 40ms)');

  await wait(40);
  assert.deepEqual(seen, ['tercera'], 'debe ejecutar UNA sola vez, con la ÚLTIMA tarea pasada');
});

test('cancel() evita que se ejecute la tarea pendiente', async () => {
  const debouncer = createDebouncer(30);
  let calls = 0;
  debouncer.trigger('k', () => {
    calls++;
  });
  debouncer.cancel('k');
  await wait(60);
  assert.equal(calls, 0);
});

test('has() refleja si hay algo pendiente para una key', async () => {
  const debouncer = createDebouncer(30);
  assert.equal(debouncer.has('k'), false);
  debouncer.trigger('k', () => {});
  assert.equal(debouncer.has('k'), true);
  debouncer.cancel('k');
  assert.equal(debouncer.has('k'), false);
});

test('flush() ejecuta YA la tarea pendiente sin esperar delayMs', async () => {
  const debouncer = createDebouncer(10_000); // deliberadamente largo
  let calls = 0;
  debouncer.trigger('k', () => {
    calls++;
  });

  const start = Date.now();
  await debouncer.flush('k');
  const elapsed = Date.now() - start;

  assert.equal(calls, 1);
  assert.ok(elapsed < 500, `flush() debe ser inmediato, tardó ${elapsed}ms`);
  assert.equal(debouncer.has('k'), false, 'tras flush() ya no debe quedar nada pendiente');
});

test('flush() es un no-op si no hay nada pendiente para esa key', async () => {
  const debouncer = createDebouncer(30);
  await assert.doesNotReject(() => debouncer.flush('inexistente'));
});

test('flush() espera a que la tarea termine (incluida una tarea async lenta)', async () => {
  const debouncer = createDebouncer(10_000);
  let done = false;
  debouncer.trigger('k', async () => {
    await wait(50);
    done = true;
  });

  await debouncer.flush('k');
  assert.equal(done, true, 'flush() debe esperar a que la tarea async termine, no solo dispararla');
});

test('flushAll() ejecuta YA todas las tareas pendientes de todas las keys', async () => {
  const debouncer = createDebouncer(10_000);
  const seen = new Set();
  debouncer.trigger('a', () => seen.add('a'));
  debouncer.trigger('b', () => seen.add('b'));
  debouncer.trigger('c', () => seen.add('c'));

  await debouncer.flushAll();

  assert.deepEqual([...seen].sort(), ['a', 'b', 'c']);
});

test('un error en la tarea agrupada no revienta el proceso (se atrapa dentro del propio disparo)', async () => {
  const debouncer = createDebouncer(20);
  debouncer.trigger('k', () => {
    throw new Error('boom');
  });
  // Si esto no lanza y el test runner sigue vivo después de la ventana,
  // el error quedó contenido dentro de trigger() (se loguea, no se propaga).
  await wait(60);
  assert.ok(true);
});

test('dos keys distintas se agrupan de forma independiente', async () => {
  const debouncer = createDebouncer(30);
  const seen = [];
  debouncer.trigger('a', () => seen.push('a'));
  await wait(10);
  debouncer.trigger('b', () => seen.push('b')); // no debe afectar a la ventana de "a"

  await wait(40);
  assert.ok(seen.includes('a'), '"a" debe haber disparado ya (su ventana de 30ms desde su propio trigger)');

  await wait(30);
  assert.ok(seen.includes('b'));
});
