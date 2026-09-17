import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const DIR = await mkdtemp(path.join(os.tmpdir(), 'ctadm-test-'));
process.env.DATA_DIR = DIR;

const { CTA_PATH } = await import('./dataPaths.js');
const { crearCta, ctaPorId } = await import('./services/ctaStore.js');
const { notificarAsignacion, notificarReasignacion, notificarAsignacionesEnLote } = await import('./ctaDm.js');

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

let contador = 0;
async function ctaDePrueba() {
  return crearCta(CTA_PATH, {
    nombre: 'Hellgate', compId: 'x', comp: compFixture(), modo: 'caller',
    guildId: 'g', channelId: `chan-${contador++}`, creadorId: 'off-1', callerId: 'off-1',
    cierraEn: new Date(Date.now() + 3600_000).toISOString(),
  });
}

function fakeClient({ fallaEnvio = false } = {}) {
  const enviados = [];
  return {
    enviados,
    users: {
      async fetch(userId) {
        return {
          id: userId,
          async send(payload) {
            if (fallaEnvio) throw new Error('Cannot send messages to this user (forzado)');
            enviados.push({ userId, payload });
          },
        };
      },
    },
  };
}

test('notificarAsignacion: si el DM sale bien, no queda como no localizable', async () => {
  const cta = await ctaDePrueba();
  const client = fakeClient();

  const ok = await notificarAsignacion(client, cta, 'u1', { rolKey: 'maza-pesada', partyNombre: 'Party 1' });
  assert.equal(ok, true);
  assert.equal(client.enviados.length, 1);
  assert.equal(client.enviados[0].payload.embeds[0].data.title, '✅ Asignado — Hellgate');

  const cargada = await ctaPorId(CTA_PATH, cta.id);
  assert.deepEqual(cargada.noLocalizables, []);
});

test('notificarAsignacion: si el DM falla, NO lanza, y marca al usuario como no localizable', async () => {
  const cta = await ctaDePrueba();
  const client = fakeClient({ fallaEnvio: true });

  const ok = await notificarAsignacion(client, cta, 'u1', { rolKey: 'maza-pesada', partyNombre: 'Party 1' });
  assert.equal(ok, false);

  const cargada = await ctaPorId(CTA_PATH, cta.id);
  assert.deepEqual(cargada.noLocalizables, ['u1']);
});

test('notificarReasignacion: manda el embed de "reasignado", con título distinto', async () => {
  const cta = await ctaDePrueba();
  const client = fakeClient();

  await notificarReasignacion(client, cta, 'u1', {
    rolKey: 'santi', partyNombre: 'Party 1', rolAnteriorKey: 'maza-pesada', partyAnteriorNombre: 'Party 1',
  });
  assert.equal(client.enviados[0].payload.embeds[0].data.title, '🔄 Reasignado — Hellgate');
});

test('notificarAsignacionesEnLote: manda uno por persona y cuenta enviados/fallidos', async () => {
  const cta = await ctaDePrueba();
  let intento = 0;
  const client = {
    users: {
      async fetch(userId) {
        intento += 1;
        const fallaEste = userId === 'u2';
        return { id: userId, async send() { if (fallaEste) throw new Error('forzado'); } };
      },
    },
  };

  const { enviados, fallidos } = await notificarAsignacionesEnLote(client, cta, [
    { userId: 'u1', rolKey: 'maza-pesada', partyNombre: 'Party 1' },
    { userId: 'u2', rolKey: 'santi', partyNombre: 'Party 1' },
    { userId: 'u3', rolKey: 'santi', partyNombre: 'Party 1' },
  ]);

  assert.equal(enviados, 2);
  assert.equal(fallidos, 1);
  assert.equal(intento, 3);

  const cargada = await ctaPorId(CTA_PATH, cta.id);
  assert.deepEqual(cargada.noLocalizables, ['u2']);
});
