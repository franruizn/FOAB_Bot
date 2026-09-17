import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const DIR = await mkdtemp(path.join(os.tmpdir(), 'ctacierre-test-'));
process.env.DATA_DIR = DIR;
delete process.env.GOOGLE_CREDENTIALS_PATH; // Sheets no configurado: volcarHojaDeCierre() es un no-op
delete process.env.CTA_SHEET_ID;
delete process.env.LOG_CHANNEL_ID;

const { CTA_PATH, MAESTRIA_PATH } = await import('./dataPaths.js');
const { crearCta, ctaPorId, actualizarCta, inscribir, asignar, mover, pendienteDeVolcarDeCanal } = await import('./services/ctaStore.js');
const { leerMaestria, vecesJugado } = await import('./services/maestria.js');
const { filasDeCta } = await import('./services/ctaSheet.js');
const { cerrarCtaCompleta, reintentarVolcadoDeCanal } = await import('./ctaCierre.js');

after(async () => {
  await rm(DIR, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.GOOGLE_CREDENTIALS_PATH;
  delete process.env.CTA_SHEET_ID;
});

function compFixture() {
  return {
    categorias: {},
    roles: { santi: { nombre: 'Santi', emoji: '🧪', categoria: null, nota: '' } },
    parties: [{ nombre: 'Party 1', slots: ['santi'] }],
  };
}

let contador = 0;
async function ctaDePrueba(overrides = {}) {
  return crearCta(CTA_PATH, {
    nombre: 'Hellgate', compId: 'x', comp: compFixture(), modo: 'abierto',
    guildId: 'g', channelId: `chan-${contador++}`, creadorId: 'off-1',
    cierraEn: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  });
}

function fakeClient({ falloEdit = false } = {}) {
  const ediciones = [];
  return {
    ediciones,
    channels: {
      async fetch() {
        return {
          messages: {
            async fetch() {
              return {
                async edit(payload) {
                  if (falloEdit) throw new Error('forzado');
                  ediciones.push(payload);
                },
              };
            },
          },
        };
      },
    },
  };
}

test('cerrarCtaCompleta: cierra a nivel de datos (ya no está activa)', async () => {
  const cta = await ctaDePrueba();
  const client = fakeClient();

  await cerrarCtaCompleta(client, cta.id, { razon: 'manual' });

  const cargada = await ctaPorId(CTA_PATH, cta.id);
  assert.equal(cargada, null);
});

test('cerrarCtaCompleta: sin messageId, no intenta editar nada en Discord', async () => {
  const cta = await ctaDePrueba();
  const client = fakeClient();

  const resultado = await cerrarCtaCompleta(client, cta.id, { razon: 'manual' });
  assert.equal(resultado.razonCierre, 'manual');
  assert.equal(client.ediciones.length, 0);
});

test('cerrarCtaCompleta: con messageId, edita el mensaje con el embed cerrado (botones deshabilitados)', async () => {
  let cta = await ctaDePrueba();
  cta = await actualizarCta(CTA_PATH, cta.id, { messageId: 'msg-1' });
  const client = fakeClient();

  await cerrarCtaCompleta(client, cta.id, { razon: 'timer' });

  assert.equal(client.ediciones.length, 1);
  const { embeds, components } = client.ediciones[0];
  assert.match(embeds[0].toJSON().title, /CERRADA/);
  for (const boton of components[0].components) {
    assert.equal(boton.toJSON().disabled, true);
  }
});

test('cerrarCtaCompleta: no borra el rol de Discord ni las asignaciones (siguen en el snapshot devuelto)', async () => {
  let cta = await ctaDePrueba();
  cta = await actualizarCta(CTA_PATH, cta.id, { roleId: 'role-1', roleNombre: 'Hellgate_1908-2030' });
  const client = fakeClient();

  const resultado = await cerrarCtaCompleta(client, cta.id, { razon: 'manual' });
  assert.equal(resultado.roleId, 'role-1');
  assert.equal(resultado.roleNombre, 'Hellgate_1908-2030');
});

test('cerrarCtaCompleta: si falla la edición de Discord, no lanza (el cierre de datos ya es definitivo)', async () => {
  let cta = await ctaDePrueba();
  cta = await actualizarCta(CTA_PATH, cta.id, { messageId: 'msg-1' });
  const client = fakeClient({ falloEdit: true });

  await assert.doesNotReject(() => cerrarCtaCompleta(client, cta.id, { razon: 'manual' }));
  assert.equal(await ctaPorId(CTA_PATH, cta.id), null);
});

test('cerrarCtaCompleta: suma maestría a quien quedó asignado', async () => {
  const cta = await ctaDePrueba();
  await inscribir(CTA_PATH, cta.id, { userId: 'u1', nombre: 'Ana', roles: ['santi'], preferido: 'santi' });
  await asignar(CTA_PATH, cta.id, { partyIdx: 0, slotIdx: 0, userId: 'u1' });
  const client = fakeClient();

  await cerrarCtaCompleta(client, cta.id, { razon: 'manual' });

  const maestria = await leerMaestria(MAESTRIA_PATH);
  assert.equal(vecesJugado(maestria, 'u1', 'santi'), 1);
});

test('cerrarCtaCompleta: sin nadie asignado, no suma maestría', async () => {
  const cta = await ctaDePrueba();
  await inscribir(CTA_PATH, cta.id, { userId: 'u-sin-asignar', nombre: 'Bea', roles: ['santi'] });
  const client = fakeClient();

  await cerrarCtaCompleta(client, cta.id, { razon: 'manual' });

  const maestria = await leerMaestria(MAESTRIA_PATH);
  assert.equal(vecesJugado(maestria, 'u-sin-asignar', 'santi'), 0);
});

// Sheets "configurado pero inalcanzable": credenciales apuntando a un
// fichero que no existe. GoogleAuth falla al leerlo (ENOENT) sin tocar la
// red, así que estos tests son offline y rápidos igual que el resto.
function configurarSheetsQueFalla() {
  process.env.GOOGLE_CREDENTIALS_PATH = '/ruta/que/no/existe.json';
  process.env.CTA_SHEET_ID = 'sheet-1';
}

test('cerrarCtaCompleta: si falla el volcado a la hoja, no lanza y marca sheetVolcadoPendiente', async () => {
  configurarSheetsQueFalla();
  const cta = await ctaDePrueba();
  const client = fakeClient();

  const resultado = await cerrarCtaCompleta(client, cta.id, { razon: 'manual' });
  assert.equal(resultado.sheetVolcadoPendiente, true);

  const pendiente = await pendienteDeVolcarDeCanal(CTA_PATH, cta.channelId);
  assert.equal(pendiente.id, cta.id);
});

test('cerrarCtaCompleta: el volcado fallido no impide publicar la composición final (el paso 5 no depende del 3)', async () => {
  configurarSheetsQueFalla();
  let cta = await ctaDePrueba();
  cta = await actualizarCta(CTA_PATH, cta.id, { messageId: 'msg-1' });
  const client = fakeClient();

  await assert.doesNotReject(() => cerrarCtaCompleta(client, cta.id, { razon: 'manual' }));

  assert.equal(client.ediciones.length, 1);
  const { embeds, components } = client.ediciones[0];
  assert.match(embeds[0].toJSON().title, /CERRADA/);
  assert.match(embeds[0].toJSON().description, /pendiente de volcar/i);
  for (const boton of components[0].components) {
    assert.equal(boton.toJSON().disabled, true);
  }
});

test('cerrarCtaCompleta: si Sheets no está configurado, no hay marca pendiente ni aviso', async () => {
  const cta = await ctaDePrueba();
  const client = fakeClient();

  const resultado = await cerrarCtaCompleta(client, cta.id, { razon: 'manual' });
  assert.equal(resultado.sheetVolcadoPendiente, false);
  assert.equal(await pendienteDeVolcarDeCanal(CTA_PATH, cta.channelId), null);
});

test('reintentarVolcadoDeCanal: sin nada pendiente en el canal, devuelve ok:false, nada:true', async () => {
  const resultado = await reintentarVolcadoDeCanal('chan-sin-nada-pendiente');
  assert.deepEqual(resultado, { ok: false, nada: true });
});

test('reintentarVolcadoDeCanal: con algo pendiente pero Sheets sigue fallando, no lanza y mantiene la marca', async () => {
  configurarSheetsQueFalla();
  const cta = await ctaDePrueba();
  const client = fakeClient();
  await cerrarCtaCompleta(client, cta.id, { razon: 'manual' });
  assert.ok(await pendienteDeVolcarDeCanal(CTA_PATH, cta.channelId));

  const resultado = await reintentarVolcadoDeCanal(cta.channelId);
  assert.equal(resultado.ok, false);
  assert.ok(resultado.error);
  assert.ok(await pendienteDeVolcarDeCanal(CTA_PATH, cta.channelId), 'la marca de pendiente sigue ahí tras el reintento fallido');
});

test('reintentarVolcadoDeCanal: si Sheets deja de estar configurado, vuelca en omitido:true y limpia la marca', async () => {
  configurarSheetsQueFalla();
  const cta = await ctaDePrueba();
  const client = fakeClient();
  await cerrarCtaCompleta(client, cta.id, { razon: 'manual' });
  assert.ok(await pendienteDeVolcarDeCanal(CTA_PATH, cta.channelId));

  delete process.env.GOOGLE_CREDENTIALS_PATH;
  delete process.env.CTA_SHEET_ID;

  const resultado = await reintentarVolcadoDeCanal(cta.channelId);
  assert.deepEqual(resultado, { ok: true, omitido: true, ctaNombre: cta.nombre });
  assert.equal(await pendienteDeVolcarDeCanal(CTA_PATH, cta.channelId), null);
});

// --- ciclo de vida completo, contando llamadas reales a la hoja (impls
// inyectados en el límite services/sheets.js, sin red) ---

function compFixtureGrande() {
  // 4 parties x 5 slots del mismo rol = 20 slots, para poder inscribir,
  // asignar y mover a 20 personas de verdad dentro de una CTA abierta.
  return {
    categorias: {},
    roles: { santi: { nombre: 'Santi', emoji: '🧪', categoria: null, nota: '' } },
    parties: Array.from({ length: 4 }, (_, i) => ({ nombre: `Party ${i + 1}`, slots: Array(5).fill('santi') })),
  };
}

function sheetSpies() {
  const crearPestana = [];
  const escribirBloque = [];
  return {
    crearPestana,
    escribirBloque,
    sheetImpls: {
      crearPestanaImpl: async (spreadsheetId, nombre) => {
        crearPestana.push({ spreadsheetId, nombre });
        return nombre;
      },
      escribirBloqueImpl: async (spreadsheetId, tabName, filas) => {
        escribirBloque.push({ spreadsheetId, tabName, filas });
      },
    },
  };
}

function maestriaSheetSpies() {
  const asegurar = [];
  const escribir = [];
  return {
    asegurar,
    escribir,
    maestriaSheetImpls: {
      asegurarPestanaImpl: async (spreadsheetId, nombre) => {
        asegurar.push(nombre);
      },
      escribirBloqueImpl: async (spreadsheetId, tabName, filas) => {
        escribir.push({ tabName, filas });
      },
    },
  };
}

test('ciclo completo: 20 altas + movimientos con la CTA abierta = 0 llamadas a Sheets; al cerrar, exactamente 1 escritura del bloque de la CTA y 1 de maestría', async () => {
  process.env.GOOGLE_CREDENTIALS_PATH = '/x.json';
  process.env.CTA_SHEET_ID = 'sheet-1';

  const { crearPestana, escribirBloque, sheetImpls } = sheetSpies();
  const { escribir: maestriaEscribir, maestriaSheetImpls } = maestriaSheetSpies();

  let cta = await ctaDePrueba({ comp: compFixtureGrande(), roleId: 'role-1', roleNombre: 'Hellgate_1908-2030' });

  for (let i = 0; i < 20; i++) {
    await inscribir(CTA_PATH, cta.id, { userId: `u${i}`, nombre: `User${i}`, roles: ['santi'] });
  }
  for (let i = 0; i < 20; i++) {
    await asignar(CTA_PATH, cta.id, { partyIdx: Math.floor(i / 5), slotIdx: i % 5, userId: `u${i}` });
  }
  // varios movimientos de verdad (no asignaciones en frío): reordena a los
  // primeros 5 usuarios rotándolos entre sí dentro de la misma party.
  for (let i = 0; i < 5; i++) {
    await mover(CTA_PATH, cta.id, { userId: `u${i}`, partyIdx: 0, slotIdx: (i + 1) % 5 });
  }

  // Ni una sola llamada a la hoja mientras la CTA sigue abierta: inscribir/
  // asignar/mover ni siquiera aceptan un parámetro de Sheets, así que esto
  // es estructural, pero se cuenta igual, no se asume.
  assert.equal(crearPestana.length, 0);
  assert.equal(escribirBloque.length, 0);

  const client = fakeClient();
  const resultado = await cerrarCtaCompleta(client, cta.id, { razon: 'manual', sheetImpls, maestriaSheetImpls });

  assert.equal(resultado.sheetVolcadoPendiente, false);
  assert.equal(crearPestana.length, 1); // la pestaña se crea UNA vez, al cerrar
  assert.equal(escribirBloque.length, 1); // exactamente una escritura del bloque de la CTA
  assert.equal(maestriaEscribir.length, 1); // exactamente una escritura de la pestaña de maestría

  // Nombre de pestaña = <nombre>_<ddMM-HHmm>, la misma convención que el rol de Discord.
  assert.equal(crearPestana[0].nombre, 'Hellgate_1908-2030');
  assert.equal(escribirBloque[0].tabName, 'Hellgate_1908-2030');

  // El contenido volcado coincide con la composición FINAL (post-movimientos).
  assert.deepEqual(escribirBloque[0].filas, filasDeCta(resultado));
});

test('dos CTAs con el mismo nombre de pestaña (mismo rol) cerradas la misma noche: dos pestañas distintas, ninguna se pisa', async () => {
  process.env.GOOGLE_CREDENTIALS_PATH = '/x.json';
  process.env.CTA_SHEET_ID = 'sheet-1';

  // Simula el comportamiento REAL de crearPestana() en services/sheets.js:
  // si el nombre ya existe en la hoja, añade un sufijo en vez de pisarlo.
  const nombresUsados = new Set();
  const escribirBloque = [];
  const sheetImpls = {
    crearPestanaImpl: async (spreadsheetId, nombreDeseado) => {
      let nombre = nombreDeseado;
      let intento = 1;
      while (nombresUsados.has(nombre)) {
        intento += 1;
        nombre = `${nombreDeseado} (${intento})`;
      }
      nombresUsados.add(nombre);
      return nombre;
    },
    escribirBloqueImpl: async (spreadsheetId, tabName, filas) => {
      escribirBloque.push({ tabName, filas });
    },
  };

  const ctaA = await ctaDePrueba({ nombre: 'ZvZ', comp: compFixture(), roleId: 'role-a', roleNombre: 'ZvZ_1908-2030' });
  const ctaB = await ctaDePrueba({ nombre: 'ZvZ', comp: compFixture(), roleId: 'role-b', roleNombre: 'ZvZ_1908-2030' }); // mismo roleNombre a propósito

  const client = fakeClient();
  const resultadoA = await cerrarCtaCompleta(client, ctaA.id, { razon: 'manual', sheetImpls });
  const resultadoB = await cerrarCtaCompleta(client, ctaB.id, { razon: 'manual', sheetImpls });

  assert.equal(escribirBloque.length, 2);
  assert.notEqual(escribirBloque[0].tabName, escribirBloque[1].tabName, 'las dos pestañas deben tener nombres distintos');
  assert.equal(escribirBloque[0].tabName, 'ZvZ_1908-2030');
  assert.equal(escribirBloque[1].tabName, 'ZvZ_1908-2030 (2)');
  assert.equal(resultadoA.sheetVolcadoPendiente, false);
  assert.equal(resultadoB.sheetVolcadoPendiente, false);
});
