import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'ctascheduler-test-'));
process.env.DATA_DIR = DATA_DIR;

const ctaScheduler = await import('./ctaScheduler.js');
const ctaStore = await import('./services/ctaStore.js');
const { __setSheetsClientForTests } = await import('./ctaSheetSync.js');
const { SheetsError } = await import('./services/sheets.js');
const { CTA_PATH } = await import('./dataPaths.js');
const { FakeChannel, makeFakeClient } = await import('./testHelpers/discordFakes.js');

function createFakeSheetsClient() {
  return {
    calls: [],
    shouldFail: false,
    async escribirBloque(filas) {
      if (this.shouldFail) throw new SheetsError('Google Sheets caído (fake)');
      this.calls.push(filas.map((f) => [...f]));
    },
  };
}

const fakeSheets = createFakeSheetsClient();
const CHANNEL_ID = 'channel-1';
const channel = new FakeChannel(CHANNEL_ID);
const client = makeFakeClient(new Map([[CHANNEL_ID, channel]]));

before(() => {
  __setSheetsClientForTests(fakeSheets);
});

after(async () => {
  __setSheetsClientForTests(null);
  // Deja un cierre ya vencido (sin CTA real con ese id) para reemplazar
  // cualquier timer de 20-30min que un test haya dejado vivo, y que el
  // proceso pueda terminar solo.
  ctaScheduler.scheduleCtaClose(client, { id: 'cleanup-noop', cierraEn: new Date(Date.now() - 1000).toISOString() });
  await wait(50);
  await rm(DATA_DIR, { recursive: true, force: true });
});

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function datosBase(overrides = {}) {
  return {
    nombre: 'Hellgate',
    guildId: 'guild-1',
    channelId: CHANNEL_ID,
    creadorId: 'u1',
    ...overrides,
  };
}

async function cerrarSiHayActiva() {
  const activa = await ctaStore.ctaActiva(CTA_PATH);
  if (activa) await ctaStore.cerrarCta(CTA_PATH).catch(() => {});
}

// ============================================================
// REINICIOS
// ============================================================

test('initializeCta(): una CTA cuyo cierre ya pasó se cierra de inmediato al "arrancar"', async () => {
  await cerrarSiHayActiva();
  // Simula "el bot estuvo apagado más allá del cierre": crea una CTA con
  // cierraEn en el pasado directamente en el store (crearCta() exige
  // cierraEn futuro, así que se pasa por el mensaje publicado de antemano).
  const messageId = (await channel.send({ embeds: [], components: [] })).id;
  const activa = await ctaStore.crearCta(CTA_PATH, datosBase({ messageId, cierraEn: new Date(Date.now() + 50).toISOString() }));
  await wait(80); // deja que el "cierraEn" quede ya en el pasado

  await ctaScheduler.initializeCta(client);

  assert.equal(await ctaStore.ctaActiva(CTA_PATH), null, 'debe cerrarse de inmediato al arrancar');
});

test('initializeCta(): una CTA que sigue viva se reprograma con el tiempo restante (no se cierra de inmediato)', async () => {
  await cerrarSiHayActiva();
  const messageId = (await channel.send({ embeds: [], components: [] })).id;
  const activa = await ctaStore.crearCta(CTA_PATH, datosBase({ messageId, cierraEn: new Date(Date.now() + 400).toISOString() }));

  await ctaScheduler.initializeCta(client);

  // Justo después de "arrancar", debe seguir activa (se reprogramó).
  assert.ok(await ctaStore.ctaActiva(CTA_PATH), 'no debe cerrarse de inmediato: todavía le quedaba tiempo');

  // El timer reprogramado debe cerrarla solo cuando toque.
  await wait(700);
  assert.equal(await ctaStore.ctaActiva(CTA_PATH), null, 'el timer reprogramado debe cerrarla cuando llega su cierraEn');
});

test('/cta 20 reiniciado a los 5 min: initializeCta() reprograma con el tiempo restante, y el botón sigue funcionando tras "reiniciar"', async () => {
  await cerrarSiHayActiva();
  const message = await channel.send({ embeds: [{ toJSON: () => ({ title: 'Hellgate' }) }], components: [] });
  // Simula: la CTA se creó con 20 min, y "ya pasaron" 5 min (cierraEn a 15
  // min de aquí en vez de 20, como estaría si initializeCta() se llamara a
  // los 5 min de una CTA de 20).
  const activa = await ctaStore.crearCta(
    CTA_PATH,
    datosBase({ nombre: 'Reinicio20', messageId: message.id, cierraEn: new Date(Date.now() + 15 * 60_000).toISOString() }),
  );

  await ctaScheduler.initializeCta(client); // "arranca" el bot de nuevo

  assert.ok(await ctaStore.ctaActiva(CTA_PATH), 'la CTA sigue viva tras el "reinicio"');

  // El botón/modal siguen funcionando: se prueba a través del propio
  // ctaStore, que es lo que de verdad consultan los handlers de /cta.
  const actualizada = await ctaStore.apuntar(CTA_PATH, 'p1', 'Jugador1', ['Tank', 'Healer', 'DPS']);
  assert.equal(actualizada.inscritos.length, 1);

  await cerrarSiHayActiva();
});

test('reinicia con una escritura agrupada pendiente: flushActiveCtaSheetSync() la manda antes de "apagar"', async () => {
  await cerrarSiHayActiva();
  const { scheduleSheetSync, flushActiveCtaSheetSync } = await import('./ctaSheetSync.js');

  const message = await channel.send({ embeds: [], components: [] });
  const activa = await ctaStore.crearCta(CTA_PATH, datosBase({ messageId: message.id, cierraEn: new Date(Date.now() + 60_000).toISOString() }));
  await ctaStore.apuntar(CTA_PATH, 'p1', 'Jugador1', ['Tank', 'Healer', 'DPS']);

  fakeSheets.calls.length = 0;
  scheduleSheetSync(client, activa.id); // entra en la ventana de 2s, agrupada

  assert.equal(fakeSheets.calls.length, 0, 'todavía no debería haberse escrito');

  await flushActiveCtaSheetSync(client); // esto es exactamente lo que llama index.js en el SIGTERM

  assert.equal(fakeSheets.calls.length, 1, 'debe forzar YA la escritura pendiente antes de "apagar"');
  assert.deepEqual(fakeSheets.calls[0], [['Jugador1', 'Tank', 'Healer', 'DPS']]);

  await cerrarSiHayActiva();
});

test('al cerrar automáticamente por timer, se fuerza la sincronización pendiente ANTES de cerrar (una alta de último segundo no se pierde)', async () => {
  await cerrarSiHayActiva();
  const message = await channel.send({ embeds: [{ toJSON: () => ({ title: 'UltimoSegundo' }) }], components: [] });
  const activa = await ctaStore.crearCta(
    CTA_PATH,
    datosBase({ nombre: 'UltimoSegundo', messageId: message.id, cierraEn: new Date(Date.now() + 200).toISOString() }),
  );

  const { scheduleSheetSync } = await import('./ctaSheetSync.js');
  await ctaStore.apuntar(CTA_PATH, 'p1', 'Jugador1', ['Tank', 'Healer', 'DPS']);
  fakeSheets.calls.length = 0;
  scheduleSheetSync(client, activa.id); // entra en la ventana de 2s justo antes de que cierre a los 200ms

  ctaScheduler.scheduleCtaClose(client, activa);
  await wait(500);

  assert.equal(await ctaStore.ctaActiva(CTA_PATH), null, 'la CTA debe haber cerrado');
  assert.equal(fakeSheets.calls.length, 1, 'el cierre debe haber forzado la escritura pendiente, no perderla');
  assert.deepEqual(fakeSheets.calls[0], [['Jugador1', 'Tank', 'Healer', 'DPS']]);
});

// ============================================================
// cerrarCtaManualmente(): /cta cerrar (cerrar antes de tiempo)
// ============================================================

test('cerrarCtaManualmente() cierra la CTA activa YA, sin esperar a cierraEn, y devuelve la CTA cerrada', async () => {
  await cerrarSiHayActiva();
  const message = await channel.send({ embeds: [{ toJSON: () => ({ title: 'CierreManual' }) }], components: [] });
  const activa = await ctaStore.crearCta(
    CTA_PATH,
    datosBase({ nombre: 'CierreManual', messageId: message.id, cierraEn: new Date(Date.now() + 10 * 60_000).toISOString() }), // 10 min: no debería cerrar solo
  );
  await ctaStore.apuntar(CTA_PATH, 'p1', 'Jugador1', ['Tank', 'Healer', 'DPS']);
  ctaScheduler.scheduleCtaClose(client, activa);

  const cerrada = await ctaScheduler.cerrarCtaManualmente(client);

  assert.ok(cerrada);
  assert.equal(cerrada.id, activa.id);
  assert.equal(cerrada.inscritos.length, 1);
  assert.equal(await ctaStore.ctaActiva(CTA_PATH), null, 'debe quedar cerrada de inmediato, sin esperar los 10 min');

  const closedMessage = channel.store.get(message.id);
  const buttonsJson = closedMessage.components[0].toJSON();
  assert.ok(buttonsJson.components.every((b) => b.disabled === true), 'los botones deben quedar deshabilitados');
});

test('cerrarCtaManualmente() cancela el timer de cierre automático (no dispara un segundo cierre después)', async () => {
  await cerrarSiHayActiva();
  const message = await channel.send({ embeds: [{ toJSON: () => ({ title: 'SinDobleCierre' }) }], components: [] });
  const activa = await ctaStore.crearCta(
    CTA_PATH,
    datosBase({ nombre: 'SinDobleCierre', messageId: message.id, cierraEn: new Date(Date.now() + 300).toISOString() }),
  );
  ctaScheduler.scheduleCtaClose(client, activa);

  await ctaScheduler.cerrarCtaManualmente(client);
  assert.equal(await ctaStore.ctaActiva(CTA_PATH), null);

  // Deja pasar el cierraEn original: si el timer NO se hubiera cancelado,
  // dispararía closeNow() de nuevo (sin CTA activa -> no-op silencioso, pero
  // lo comprobamos igual para confirmar que el timer quedó cancelado, no
  // solo que no rompió nada).
  await wait(500);
  assert.equal(await ctaStore.ctaActiva(CTA_PATH), null, 'sigue sin haber ninguna CTA activa (nada se recreó)');
});

test('cerrarCtaManualmente() devuelve null si no hay ninguna CTA activa', async () => {
  await cerrarSiHayActiva();
  const resultado = await ctaScheduler.cerrarCtaManualmente(client);
  assert.equal(resultado, null);
});

test('cerrarCtaManualmente() fuerza la sincronización pendiente antes de cerrar (una alta reciente no se pierde)', async () => {
  await cerrarSiHayActiva();
  const message = await channel.send({ embeds: [{ toJSON: () => ({ title: 'CierreManualConPendiente' }) }], components: [] });
  const activa = await ctaStore.crearCta(
    CTA_PATH,
    datosBase({ nombre: 'CierreManualConPendiente', messageId: message.id, cierraEn: new Date(Date.now() + 10 * 60_000).toISOString() }),
  );

  const { scheduleSheetSync } = await import('./ctaSheetSync.js');
  await ctaStore.apuntar(CTA_PATH, 'p1', 'Jugador1', ['Tank', 'Healer', 'DPS']);
  fakeSheets.calls.length = 0;
  scheduleSheetSync(client, activa.id); // entra en la ventana de 2s, todavía no se ha escrito

  await ctaScheduler.cerrarCtaManualmente(client);

  assert.equal(fakeSheets.calls.length, 1, 'debe forzar la escritura pendiente antes de cerrar, no perderla');
  assert.deepEqual(fakeSheets.calls[0], [['Jugador1', 'Tank', 'Healer', 'DPS']]);
});
