import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  leerMaestria,
  vecesJugado,
  nivelDeVeces,
  nivelEstrellas,
  estrellasTexto,
  ultimaVez,
  jugadorQueRepiteRol,
  registrarCierreDeCta,
} from './maestria.js';
import { crearCta, inscribir, asignar, mover, desasignar, cerrarCta } from './ctaStore.js';

const DIR = await mkdtemp(path.join(os.tmpdir(), 'maestria-test-'));
let fileCounter = 0;
function tempFile() {
  return path.join(DIR, `maestria-${fileCounter++}.json`);
}
function tempCtaFile() {
  return path.join(DIR, `cta-${fileCounter++}.json`);
}

after(async () => {
  await rm(DIR, { recursive: true, force: true });
});

function compFixture() {
  return {
    categorias: { tanque: { nombre: 'Tanque', emoji: '🔵', orden: 1 } },
    roles: {
      'maza-pesada': { nombre: 'Maza Pesada', emoji: '🔨', categoria: 'tanque', nota: '' },
      santi: { nombre: 'Santi', emoji: '🧪', categoria: null, nota: '' },
    },
    parties: [{ nombre: 'Party 1', slots: ['maza-pesada', 'santi'] }],
  };
}

async function ctaDePrueba(channelId) {
  const file = tempCtaFile();
  const cta = await crearCta(file, {
    nombre: 'Hellgate', compId: 'x', comp: compFixture(), modo: 'abierto',
    guildId: 'g', channelId, creadorId: 'off-1',
    cierraEn: new Date(Date.now() + 3600_000).toISOString(),
  });
  return { file, cta };
}

// --- umbrales de estrellas, en sus fronteras exactas ---

test('nivelDeVeces: fronteras exactas 4/5, 14/15, 29/30, 59/60', () => {
  assert.equal(nivelDeVeces(0), 0);
  assert.equal(nivelDeVeces(1), 1);
  assert.equal(nivelDeVeces(4), 1);
  assert.equal(nivelDeVeces(5), 2);
  assert.equal(nivelDeVeces(14), 2);
  assert.equal(nivelDeVeces(15), 3);
  assert.equal(nivelDeVeces(29), 3);
  assert.equal(nivelDeVeces(30), 4);
  assert.equal(nivelDeVeces(59), 4);
  assert.equal(nivelDeVeces(60), 5);
  assert.equal(nivelDeVeces(1000), 5); // nunca pasa de 5
});

test('estrellasTexto: repite el símbolo, vacío para 0 (nunca "★ 0")', () => {
  assert.equal(estrellasTexto(0), '');
  assert.equal(estrellasTexto(1), '★');
  assert.equal(estrellasTexto(3), '★★★');
});

test('nivelEstrellas/vecesJugado: leen del jugador correcto, 0 si no hay historial', () => {
  const maestria = { jugadores: { u1: { roles: { santi: 15 } } } };
  assert.equal(vecesJugado(maestria, 'u1', 'santi'), 15);
  assert.equal(nivelEstrellas(maestria, 'u1', 'santi'), 3);
  assert.equal(vecesJugado(maestria, 'u1', 'hoj'), 0);
  assert.equal(nivelEstrellas(maestria, 'u2', 'santi'), 0);
});

// --- lectura sin fichero previo ---

test('leerMaestria: fichero inexistente devuelve la forma por defecto', async () => {
  const maestria = await leerMaestria(tempFile());
  assert.deepEqual(maestria, { version: 1, jugadores: {}, historialRoles: {} });
});

// --- registrarCierreDeCta: el contador SOLO sube al cerrar ---

test('registrarCierreDeCta: suma 1 a cada asignado, en su rol', async () => {
  const maestriaFile = tempFile();
  const { file, cta } = await ctaDePrueba('chan-1');
  await inscribir(file, cta.id, { userId: 'u1', nombre: 'Ana', roles: ['maza-pesada'], preferido: 'maza-pesada' });
  await inscribir(file, cta.id, { userId: 'u2', nombre: 'Bea', roles: ['santi'], preferido: 'santi' });
  await asignar(file, cta.id, { partyIdx: 0, slotIdx: 0, userId: 'u1' });
  await asignar(file, cta.id, { partyIdx: 0, slotIdx: 1, userId: 'u2' });
  const cerrada = await cerrarCta(file, cta.id, { razon: 'manual' });

  const { actualizados } = await registrarCierreDeCta(maestriaFile, cerrada);
  assert.equal(actualizados, 2);

  const maestria = await leerMaestria(maestriaFile);
  assert.equal(vecesJugado(maestria, 'u1', 'maza-pesada'), 1);
  assert.equal(vecesJugado(maestria, 'u2', 'santi'), 1);
  assert.equal(maestria.jugadores.u1.nombre, 'Ana');
  assert.ok(ultimaVez(maestria, 'u1', 'maza-pesada'));
});

test('registrarCierreDeCta: tentativos que acaban asignados cuentan igual', async () => {
  const maestriaFile = tempFile();
  const { file, cta } = await ctaDePrueba('chan-tentativo');
  await inscribir(file, cta.id, { userId: 'u1', nombre: 'Ana', roles: ['santi'], preferido: 'santi', tentativo: true });
  await asignar(file, cta.id, { partyIdx: 0, slotIdx: 1, userId: 'u1' });
  const cerrada = await cerrarCta(file, cta.id, { razon: 'manual' });

  await registrarCierreDeCta(maestriaFile, cerrada);
  const maestria = await leerMaestria(maestriaFile);
  assert.equal(vecesJugado(maestria, 'u1', 'santi'), 1);
});

test('registrarCierreDeCta: mover a alguien tres veces antes de cerrar suma 1, no 3', async () => {
  const maestriaFile = tempFile();
  const { file, cta } = await ctaDePrueba('chan-2');
  await inscribir(file, cta.id, { userId: 'u1', nombre: 'Ana', roles: ['maza-pesada', 'santi'], preferido: 'maza-pesada' });
  await asignar(file, cta.id, { partyIdx: 0, slotIdx: 0, userId: 'u1' });
  await mover(file, cta.id, { userId: 'u1', partyIdx: 0, slotIdx: 1 });
  await mover(file, cta.id, { userId: 'u1', partyIdx: 0, slotIdx: 0 });
  await mover(file, cta.id, { userId: 'u1', partyIdx: 0, slotIdx: 1 });
  const cerrada = await cerrarCta(file, cta.id, { razon: 'manual' });

  const { actualizados } = await registrarCierreDeCta(maestriaFile, cerrada);
  assert.equal(actualizados, 1);

  const maestria = await leerMaestria(maestriaFile);
  // acabó en "santi" (0:1): solo ese rol sube, y solo una vez.
  assert.equal(vecesJugado(maestria, 'u1', 'santi'), 1);
  assert.equal(vecesJugado(maestria, 'u1', 'maza-pesada'), 0);
});

test('registrarCierreDeCta: asignar y quitar antes de cerrar no suma nada', async () => {
  const maestriaFile = tempFile();
  const { file, cta } = await ctaDePrueba('chan-3');
  await inscribir(file, cta.id, { userId: 'u1', nombre: 'Ana', roles: ['maza-pesada'], preferido: 'maza-pesada' });
  await asignar(file, cta.id, { partyIdx: 0, slotIdx: 0, userId: 'u1' });
  await desasignar(file, cta.id, { partyIdx: 0, slotIdx: 0 });
  const cerrada = await cerrarCta(file, cta.id, { razon: 'manual' });

  const { actualizados } = await registrarCierreDeCta(maestriaFile, cerrada);
  assert.equal(actualizados, 0);

  const maestria = await leerMaestria(maestriaFile);
  assert.deepEqual(maestria.jugadores, {});
});

test('registrarCierreDeCta: cerrar sin nadie asignado no suma nada', async () => {
  const maestriaFile = tempFile();
  const { file, cta } = await ctaDePrueba('chan-4');
  await inscribir(file, cta.id, { userId: 'u1', nombre: 'Ana', roles: ['maza-pesada'] });
  const cerrada = await cerrarCta(file, cta.id, { razon: 'manual' });

  const { actualizados } = await registrarCierreDeCta(maestriaFile, cerrada);
  assert.equal(actualizados, 0);

  const maestria = await leerMaestria(maestriaFile);
  assert.deepEqual(maestria.jugadores, {});
});

test('registrarCierreDeCta: dos cierres seguidos acumulan (no sobrescriben)', async () => {
  const maestriaFile = tempFile();

  const primero = await ctaDePrueba('chan-5a');
  await inscribir(primero.file, primero.cta.id, { userId: 'u1', nombre: 'Ana', roles: ['santi'] });
  await asignar(primero.file, primero.cta.id, { partyIdx: 0, slotIdx: 1, userId: 'u1' });
  await registrarCierreDeCta(maestriaFile, await cerrarCta(primero.file, primero.cta.id, {}));

  const segundo = await ctaDePrueba('chan-5b');
  await inscribir(segundo.file, segundo.cta.id, { userId: 'u1', nombre: 'Ana', roles: ['santi'] });
  await asignar(segundo.file, segundo.cta.id, { partyIdx: 0, slotIdx: 1, userId: 'u1' });
  await registrarCierreDeCta(maestriaFile, await cerrarCta(segundo.file, segundo.cta.id, {}));

  const maestria = await leerMaestria(maestriaFile);
  assert.equal(vecesJugado(maestria, 'u1', 'santi'), 2);
});

// --- jugadorQueRepiteRol ---

test('jugadorQueRepiteRol: null si hay menos de 5 cierres registrados', () => {
  const maestria = { historialRoles: { santi: ['u1', 'u1', 'u1'] } };
  assert.equal(jugadorQueRepiteRol(maestria, 'santi'), null);
});

test('jugadorQueRepiteRol: null si se alternó en los últimos 5', () => {
  const maestria = { historialRoles: { santi: ['u1', 'u1', 'u2', 'u1', 'u1'] } };
  assert.equal(jugadorQueRepiteRol(maestria, 'santi'), null);
});

test('jugadorQueRepiteRol: devuelve el userId si los últimos 5 son la misma persona', () => {
  const maestria = { historialRoles: { santi: ['u1', 'u1', 'u1', 'u1', 'u1'] } };
  assert.equal(jugadorQueRepiteRol(maestria, 'santi'), 'u1');
});
