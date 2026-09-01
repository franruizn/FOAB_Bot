import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// DATA_DIR tiene que fijarse ANTES de importar cualquier módulo que
// transitivamente importe dataPaths.js (lo lee una sola vez, al cargar el
// módulo). Cada fichero de test de node:test corre en su propio proceso, así
// que esto no interfiere con otros ficheros de test.
const DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'cta-command-test-'));
process.env.DATA_DIR = DATA_DIR;
process.env.CTA_OFFICER_ROLE_ID = 'role-officer';
process.env.LOG_CHANNEL_ID = 'log-channel-1';

const cta = await import('./cta.js');
const ctaStore = await import('../services/ctaStore.js');
const ctaScheduler = await import('../ctaScheduler.js');
const { __setSheetsClientForTests, __setDebounceMsForTests: setSheetDebounceMs } = await import('../ctaSheetSync.js');
const { __setDebounceMsForTests: setEmbedDebounceMs } = await import('../ctaEmbedSync.js');
const { SheetsError } = await import('../services/sheets.js');
const { getSheetIdOverride, getSheetTabOverride, getRangoInicioOverride } = await import('../services/ctaSheetConfig.js');
const { CTA_PATH, CTA_SHEET_CONFIG_PATH } = await import('../dataPaths.js');
const { FakeGuild, FakeChannel, makeFakeClient, FakeChatInputInteraction, FakeModalSubmitInteraction, FakeButtonInteraction } =
  await import('../testHelpers/discordFakes.js');

// El agrupador real espera 2s; la suite no necesita esperar eso de verdad
// (se prueba QUE agrupa, en debounce.test.js, con sus propios tiempos
// cortos) — aquí solo hace falta un margen por encima de este valor para
// dejarlo asentar tras cada alta/baja.
const TEST_DEBOUNCE_MS = 20;

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

before(() => {
  __setSheetsClientForTests(fakeSheets);
  setSheetDebounceMs(TEST_DEBOUNCE_MS);
  setEmbedDebounceMs(TEST_DEBOUNCE_MS);
});

after(async () => {
  __setSheetsClientForTests(null); // restaura el cliente real por si algo más importa este módulo
  setSheetDebounceMs(null);
  setEmbedDebounceMs(null);

  // Cada /cta abrir real programa un setTimeout de cierre en ctaScheduler.js
  // (un único timer a nivel de módulo). El último que quede vivo al acabar
  // el fichero impediría que el proceso de test termine solo. Programar un
  // cierre ya vencido lo reemplaza por uno que dispara casi al instante (y
  // no hace nada: no hay ninguna CTA real con ese id).
  ctaScheduler.scheduleCtaClose(client, { id: 'cleanup-noop', cierraEn: new Date(Date.now() - 1000).toISOString() });
  await wait(50);

  await rm(DATA_DIR, { recursive: true, force: true });
});

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CHANNEL_ID = 'channel-1';
const LOG_CHANNEL_ID = 'log-channel-1';
const channel = new FakeChannel(CHANNEL_ID);
const logChannel = new FakeChannel(LOG_CHANNEL_ID);
const client = makeFakeClient(
  new Map([
    [CHANNEL_ID, channel],
    [LOG_CHANNEL_ID, logChannel],
  ]),
);

const guild = new FakeGuild('guild-1');
const officer = guild.addMember('u-officer', 'Oficial');
officer.roles.cache.set('role-officer', { id: 'role-officer' });
const botMember = guild.addMember('bot-1', 'FOAB Bot');
guild.members.me = botMember;

function abrirInteraction(overrides = {}) {
  return new FakeChatInputInteraction({
    channelId: CHANNEL_ID,
    channel,
    guild,
    member: officer,
    subcommand: 'abrir',
    opts: { nombre: 'Hellgate', minutos: 30 },
    client,
    ...overrides,
  });
}

async function abrirCta(opts = {}) {
  fakeSheets.calls.length = 0;
  const interaction = abrirInteraction({ opts: { nombre: 'Hellgate', minutos: 30, ...opts } });
  await cta.execute(interaction);
  const activa = await ctaStore.ctaActiva(CTA_PATH);
  assert.ok(activa, 'la CTA debía haberse creado para este escenario');
  return { activa, interaction };
}

// Registra (si hace falta) al jugador como miembro real del guild fake:
// interaction.member en Discord real SIEMPRE es resolvible dentro de su
// propio servidor, así que las pruebas deben partir de esa misma base — si
// no, la asignación de rol cae al fallback de guild.members.fetch() y falla
// con "Unknown Member" para cualquier userId que no se haya registrado antes.
function ensureMember(userId, tag) {
  return guild.members.cache.get(userId) ?? guild.addMember(userId, tag);
}

async function apuntarViaModal(userId, nombre, [rol1, rol2, rol3], ctaId) {
  const activa = ctaId ? { id: ctaId } : await ctaStore.ctaActiva(CTA_PATH);
  const member = ensureMember(userId, nombre);
  const modal = new FakeModalSubmitInteraction({
    customId: `cta-modal-${activa.id}`,
    member,
    fieldValues: { rol1, rol2, rol3 },
    client,
  });
  await cta.handleModalSubmit(modal);
  return modal;
}

async function desapuntarViaBoton(userId, tag, ctaId) {
  const activa = ctaId ? { id: ctaId } : await ctaStore.ctaActiva(CTA_PATH);
  const member = ensureMember(userId, tag);
  const button = new FakeButtonInteraction({
    customId: `cta-desapuntar-${activa.id}`,
    member,
    client,
  });
  await cta.handleButton(button);
  return button;
}

// Limpia el estado entre "capítulos" para que un test no interfiera con el
// siguiente: cierra cualquier CTA activa que haya quedado.
async function cerrarSiHayActiva() {
  const activa = await ctaStore.ctaActiva(CTA_PATH);
  if (activa) await ctaStore.cerrarCta(CTA_PATH).catch(() => {});
}

// ============================================================
// FLUJO BÁSICO
// ============================================================

test('FLUJO BÁSICO: 3 altas -> hoja con 3 filas en orden; 1 baja -> sin huecos; alta de nuevo -> al final', async () => {
  await cerrarSiHayActiva();
  await abrirCta();

  await apuntarViaModal('p1', 'Jugador1', ['Tank', 'Healer', 'DPS']);
  await apuntarViaModal('p2', 'Jugador2', ['Support', 'DPS', 'Scout']);
  await apuntarViaModal('p3', 'Jugador3', ['Tank', 'Support', 'DPS']);
  await wait(100);

  assert.deepEqual(fakeSheets.calls.at(-1), [
    ['Jugador1', 'Tank', 'Healer', 'DPS'],
    ['Jugador2', 'Support', 'DPS', 'Scout'],
    ['Jugador3', 'Tank', 'Support', 'DPS'],
  ]);

  await desapuntarViaBoton('p2', 'Jugador2');
  await wait(100);
  assert.deepEqual(fakeSheets.calls.at(-1), [
    ['Jugador1', 'Tank', 'Healer', 'DPS'],
    ['Jugador3', 'Tank', 'Support', 'DPS'],
  ]);

  await apuntarViaModal('p4', 'Jugador4', ['Support', 'Healer', 'Scout']);
  await wait(100);
  assert.deepEqual(fakeSheets.calls.at(-1), [
    ['Jugador1', 'Tank', 'Healer', 'DPS'],
    ['Jugador3', 'Tank', 'Support', 'DPS'],
    ['Jugador4', 'Support', 'Healer', 'Scout'],
  ]);
});

test('FLUJO BÁSICO: el footer coincide con las filas de la hoja tras 2s de calma', async () => {
  await cerrarSiHayActiva();
  const { activa } = await abrirCta();

  await apuntarViaModal('p1', 'Jugador1', ['Tank', 'Healer', 'DPS']);
  await wait(100);

  const message = channel.store.get(activa.messageId);
  assert.equal(message.embeds[0].footer.text, 'Inscritos: 1');
  assert.equal(fakeSheets.calls.at(-1).length, 1);
});

test('FLUJO BÁSICO: apuntarse ya apuntado cambia los roles sin crear otra fila ni moverlo al final', async () => {
  await cerrarSiHayActiva();
  await abrirCta();
  await apuntarViaModal('p1', 'Jugador1', ['Tank', 'Healer', 'DPS']);
  await apuntarViaModal('p2', 'Jugador2', ['Support', 'DPS', 'Scout']);

  const antes = await ctaStore.ctaActiva(CTA_PATH);
  const tsOriginal = antes.inscritos[0].ts;

  await apuntarViaModal('p1', 'Jugador1', ['Scout', 'Tank', 'Healer']);

  const despues = await ctaStore.ctaActiva(CTA_PATH);
  assert.equal(despues.inscritos.length, 2);
  assert.equal(despues.inscritos[0].ts, tsOriginal);
  assert.deepEqual(despues.inscritos[0].roles, ['Scout', 'Tank', 'Healer']);
});

test('FLUJO BÁSICO: desapuntarse sin estar apuntado da un mensaje claro y no toca la hoja', async () => {
  await cerrarSiHayActiva();
  await abrirCta();
  await wait(100); // deja asentar la limpieza del bloque que dispara la propia creación
  fakeSheets.calls.length = 0;

  const button = await desapuntarViaBoton('nadie', 'Nadie');
  assert.match(button.lastContent(), /No estás apuntado/);

  await wait(100);
  assert.equal(fakeSheets.calls.length, 0, 'no debe haberse escrito nada en la hoja');
});

test('FLUJO BÁSICO: al cerrar, los dos botones quedan deshabilitados y la hoja queda intacta', async () => {
  await cerrarSiHayActiva();
  const { activa } = await abrirCta();
  await apuntarViaModal('p1', 'Jugador1', ['Tank', 'Healer', 'DPS']);
  await wait(100);

  fakeSheets.calls.length = 0;
  ctaScheduler.scheduleCtaClose(client, { id: activa.id, cierraEn: new Date(Date.now() + 30).toISOString() });
  await wait(300);

  const message = channel.store.get(activa.messageId);
  const buttonsJson = message.components[0].toJSON();
  assert.ok(buttonsJson.components.every((b) => b.disabled === true));
  assert.equal(fakeSheets.calls.length, 0, 'cerrar no debe reescribir la hoja por sí mismo');
});

// ============================================================
// VALIDACIÓN DEL FORMULARIO
// ============================================================

test('VALIDACIÓN: los tres roles iguales se rechazan', async () => {
  await cerrarSiHayActiva();
  await abrirCta();
  const modal = await apuntarViaModal('p1', 'Jugador1', ['Tank', 'Tank', 'Tank']);
  assert.match(modal.lastContent(), /deben ser distintos/);
  assert.equal((await ctaStore.ctaActiva(CTA_PATH)).inscritos.length, 0);
});

test('VALIDACIÓN: dos roles iguales se rechazan', async () => {
  await cerrarSiHayActiva();
  await abrirCta();
  const modal = await apuntarViaModal('p1', 'Jugador1', ['Tank', 'Healer', 'Tank']);
  assert.match(modal.lastContent(), /deben ser distintos/);
});

test('VALIDACIÓN: "Tank" y "tank " se consideran el mismo rol y se rechaza', async () => {
  await cerrarSiHayActiva();
  await abrirCta();
  const modal = await apuntarViaModal('p1', 'Jugador1', ['Tank', 'tank ', 'Healer']);
  assert.match(modal.lastContent(), /deben ser distintos/);
});

test('VALIDACIÓN: un campo con solo espacios se rechaza', async () => {
  await cerrarSiHayActiva();
  await abrirCta();
  const modal = await apuntarViaModal('p1', 'Jugador1', ['Tank', '   ', 'Healer']);
  assert.match(modal.lastContent(), /"Rol 2" no puede estar vacío/);
});

test('VALIDACIÓN: un rol que empieza por "=" llega a la hoja como texto (RAW), no se rechaza', async () => {
  await cerrarSiHayActiva();
  await abrirCta();
  const modal = await apuntarViaModal('p1', 'Jugador1', ['=SUM(A1:A2)', 'Healer', 'DPS']);
  assert.match(modal.lastContent(), /^Apuntado con: =SUM\(A1:A2\), Healer, DPS\./);

  await wait(100);
  assert.deepEqual(fakeSheets.calls.at(-1)[0], ['Jugador1', '=SUM(A1:A2)', 'Healer', 'DPS']);
});

test('VALIDACIÓN: un rol con acentos y emoji llega intacto', async () => {
  await cerrarSiHayActiva();
  await abrirCta();
  await apuntarViaModal('p1', 'Jugador1', ['Sanador 🩹', 'Ranúra', 'DPS 🔥']);

  await wait(100);
  assert.deepEqual(fakeSheets.calls.at(-1)[0], ['Jugador1', 'Sanador 🩹', 'Ranúra', 'DPS 🔥']);
});

test('VALIDACIÓN: enviar el modal tras cerrar la CTA se rechaza explicando por qué', async () => {
  await cerrarSiHayActiva();
  const { activa } = await abrirCta();
  await ctaStore.cerrarCta(CTA_PATH);

  const modal = await apuntarViaModal('p1', 'Jugador1', ['Tank', 'Healer', 'DPS'], activa.id);
  assert.match(modal.lastContent(), /ya cerró mientras tenías el formulario abierto/);
  assert.equal(await ctaStore.ctaActiva(CTA_PATH), null);
});

// ============================================================
// ROL DE LA ACTIVIDAD
// ============================================================

test('ROL: existe con el nombre esperado y es mencionable al crear la CTA', async () => {
  await cerrarSiHayActiva();
  const fecha = new Date();
  const { activa } = await abrirCta({ nombre: 'RolEsperado' });

  const role = guild.roles.cache.get(activa.roleId);
  assert.ok(role);
  assert.match(role.name, /^RolEsperado_\d{4}-\d{4}$/);
  assert.equal(role.mentionable, true);
});

test('ROL: quien se apunta lo recibe, quien se desapunta lo pierde', async () => {
  await cerrarSiHayActiva();
  const { activa } = await abrirCta();
  const p1 = guild.addMember('p-rol-1', 'JugadorRol1');

  await apuntarViaModal('p-rol-1', 'JugadorRol1', ['Tank', 'Healer', 'DPS']);
  assert.equal(p1.roles.cache.has(activa.roleId), true);

  await desapuntarViaBoton('p-rol-1', 'JugadorRol1');
  assert.equal(p1.roles.cache.has(activa.roleId), false);
});

test('ROL: reinscribirse para cambiar roles no repite la llamada de add() ni quita el rol', async () => {
  await cerrarSiHayActiva();
  const { activa } = await abrirCta();
  const p1 = guild.addMember('p-rol-2', 'JugadorRol2');

  await apuntarViaModal('p-rol-2', 'JugadorRol2', ['Tank', 'Healer', 'DPS']);
  assert.equal(p1.roles.cache.has(activa.roleId), true);

  guild.__forceRoleOpFail.add('p-rol-2'); // si add()/remove() se llamaran de más, esto lo delataría
  const modal = await apuntarViaModal('p-rol-2', 'JugadorRol2', ['Support', 'DPS', 'Scout']);
  guild.__forceRoleOpFail.delete('p-rol-2');

  assert.match(modal.lastContent(), /^Apuntado con: Support, DPS, Scout\./);
  assert.equal(p1.roles.cache.has(activa.roleId), true, 'sigue teniendo el rol, ni se duplicó ni se quitó');
});

test('ROL: si member.roles.add() falla, la inscripción sigue guardada y la interacción no falla', async () => {
  await cerrarSiHayActiva();
  await abrirCta();
  guild.addMember('p-rol-3', 'JugadorRol3');
  guild.__forceRoleOpFail.add('p-rol-3');
  logChannel.sentPayloads.length = 0;

  const modal = await apuntarViaModal('p-rol-3', 'JugadorRol3', ['Tank', 'Healer', 'DPS']);
  guild.__forceRoleOpFail.delete('p-rol-3');

  assert.match(modal.lastContent(), /^Apuntado con: Tank, Healer, DPS\./);
  assert.match(modal.lastContent(), /El rol se asignará en breve/);
  const activa = await ctaStore.ctaActiva(CTA_PATH);
  assert.ok(activa.inscritos.some((i) => i.userId === 'p-rol-3'));
  assert.equal(logChannel.sentPayloads.length, 1);
});

test('ROL: sin ManageRoles, /cta falla ANTES de crear el rol y de publicar el mensaje', async () => {
  await cerrarSiHayActiva();
  guild.__botHasManageRoles = false;
  const antesRoles = guild.roles.cache.size;
  const antesMensajes = channel.sentPayloads.length;

  const interaction = abrirInteraction({ opts: { nombre: 'SinPermiso', minutos: 30 } });
  await cta.execute(interaction);
  guild.__botHasManageRoles = true;

  assert.equal(guild.roles.cache.size, antesRoles);
  assert.equal(channel.sentPayloads.length, antesMensajes);
  assert.equal(await ctaStore.ctaActiva(CTA_PATH), null);
  assert.match(JSON.stringify(interaction.followUps.at(-1)), /Gestionar roles/);
});

test('ROL: con el rol del bot en la posición 1, mismo comportamiento (falla antes de crear/publicar)', async () => {
  await cerrarSiHayActiva();
  botMember.roles.highest = { position: 1 };
  const antesRoles = guild.roles.cache.size;
  const antesMensajes = channel.sentPayloads.length;

  const interaction = abrirInteraction({ opts: { nombre: 'Jerarquia', minutos: 30 } });
  await cta.execute(interaction);
  botMember.roles.highest = { position: 5 };

  assert.equal(guild.roles.cache.size, antesRoles);
  assert.equal(channel.sentPayloads.length, antesMensajes);
  assert.equal(await ctaStore.ctaActiva(CTA_PATH), null);
});

test('ROL: con 250 roles en el servidor, rechazado antes de publicar', async () => {
  await cerrarSiHayActiva();
  guild.addFillerRoles(250);
  const antesMensajes = channel.sentPayloads.length;

  const interaction = abrirInteraction({ opts: { nombre: 'Cupo', minutos: 30 } });
  await cta.execute(interaction);

  assert.equal(channel.sentPayloads.length, antesMensajes);
  assert.equal(await ctaStore.ctaActiva(CTA_PATH), null);
  guild.roles.cache = new Map([...guild.roles.cache].filter(([id]) => !id.startsWith('filler-')));
});

test('ROL: con más de 200 roles, se crea igual, con aviso al oficial y al canal de logs', async () => {
  await cerrarSiHayActiva();
  // El guild se comparte con tests anteriores (los roles de CTA reales que
  // crean son permanentes, a propósito no se limpian) — el aviso se calcula
  // sobre el total real en ese momento, no sobre un guild vacío.
  const antesDeFillers = guild.roles.cache.size;
  guild.addFillerRoles(205);
  const totalTrasCrear = antesDeFillers + 205 + 1;
  logChannel.sentPayloads.length = 0;

  const interaction = abrirInteraction({ opts: { nombre: 'AvisoCupo', minutos: 30 } });
  await cta.execute(interaction);

  assert.ok(await ctaStore.ctaActiva(CTA_PATH), 'la CTA debe crearse igual');
  assert.match(JSON.stringify(interaction.followUps), new RegExp(`⚠️.*${totalTrasCrear} roles`));
  assert.equal(logChannel.sentPayloads.length, 1);

  await cerrarSiHayActiva();
  guild.roles.cache = new Map([...guild.roles.cache].filter(([id]) => !id.startsWith('filler-')));
});

test('ROL: si falla la publicación del mensaje tras crear el rol, el rol se borra y no queda estado a medias', async () => {
  await cerrarSiHayActiva();
  channel.__forceSendFail = true;
  const antesRoles = guild.roles.cache.size;

  const interaction = abrirInteraction({ opts: { nombre: 'RollbackPublish', minutos: 30 } });
  await assert.rejects(() => cta.execute(interaction));

  channel.__forceSendFail = false;
  assert.equal(guild.roles.cache.size, antesRoles, 'el rol creado debe haberse borrado');
  assert.equal(await ctaStore.ctaActiva(CTA_PATH), null);
});

test('ROL: /cta sync devuelve el rol a quien lo perdió y lo quita a quien no está inscrito', async () => {
  await cerrarSiHayActiva();
  const { activa } = await abrirCta();
  const inscritoSinRol = guild.addMember('p-sync-1', 'Sync1');
  const noInscritoConRol = guild.addMember('p-sync-2', 'Sync2');
  noInscritoConRol.roles.cache.set(activa.roleId, { id: activa.roleId });

  await apuntarViaModal('p-sync-1', 'Sync1', ['Tank', 'Healer', 'DPS']);
  // La asignación de p-sync-1 ya debió pasar de inmediato al apuntarse; para
  // este escenario simulamos que "a mano" alguien le quitó el rol.
  inscritoSinRol.roles.cache.delete(activa.roleId);

  const interaction = new FakeChatInputInteraction({
    channelId: CHANNEL_ID,
    channel,
    guild,
    member: officer,
    subcommand: 'sync',
    opts: {},
    client,
  });
  await cta.execute(interaction);

  assert.equal(inscritoSinRol.roles.cache.has(activa.roleId), true);
  assert.equal(noInscritoConRol.roles.cache.has(activa.roleId), false);
  assert.match(interaction.lastContent(), /Rol: \+1 \/ -1/);
});

test('ROL: /cta sync no falla con un inscrito que ya no está en el servidor, y lo reporta aparte', async () => {
  await cerrarSiHayActiva();
  const { activa } = await abrirCta();
  await ctaStore.apuntar(CTA_PATH, 'p-se-fue', 'SeFue', ['Tank', 'Healer', 'DPS']); // inscrito directo en el JSON, nunca fue miembro del guild fake

  const interaction = new FakeChatInputInteraction({
    channelId: CHANNEL_ID,
    channel,
    guild,
    member: officer,
    subcommand: 'sync',
    opts: {},
    client,
  });
  await assert.doesNotReject(() => cta.execute(interaction));
  assert.match(interaction.lastContent(), /omitido/);
});

test('ROL: cerrar la CTA no borra el rol', async () => {
  await cerrarSiHayActiva();
  const { activa } = await abrirCta({ nombre: 'NoSeBorra' });
  ctaScheduler.scheduleCtaClose(client, { id: activa.id, cierraEn: new Date(Date.now() + 30).toISOString() });
  await wait(300);

  assert.ok(guild.roles.cache.has(activa.roleId), 'el rol debe seguir existiendo tras cerrar');
});

test('ROL: crear otra CTA no borra el rol de la anterior', async () => {
  await cerrarSiHayActiva();
  const { activa: primera } = await abrirCta({ nombre: 'Primera' });
  ctaScheduler.scheduleCtaClose(client, { id: primera.id, cierraEn: new Date(Date.now() + 30).toISOString() });
  await wait(300);

  const { activa: segunda } = await abrirCta({ nombre: 'Segunda' });

  assert.ok(guild.roles.cache.has(primera.roleId), 'el rol de la primera debe seguir existiendo');
  assert.ok(guild.roles.cache.has(segunda.roleId));
  assert.notEqual(primera.roleId, segunda.roleId);

  await cerrarSiHayActiva();
});

// ============================================================
// CONCURRENCIA
// ============================================================

test('CONCURRENCIA: 5 formularios enviados a la vez -> los 5 en la hoja, ninguno pisado, los 5 con el rol', async () => {
  await cerrarSiHayActiva();
  const { activa } = await abrirCta({ nombre: 'Concurrencia5' });
  fakeSheets.calls.length = 0;

  const miembros = [1, 2, 3, 4, 5].map((n) => guild.addMember(`c${n}`, `Concurrente${n}`));

  await Promise.all(
    [1, 2, 3, 4, 5].map((n) => apuntarViaModal(`c${n}`, `Concurrente${n}`, ['Tank', 'Healer', `DPS${n}`])),
  );
  await wait(100);

  const activaFinal = await ctaStore.ctaActiva(CTA_PATH);
  assert.equal(activaFinal.inscritos.length, 5);
  assert.equal(new Set(activaFinal.inscritos.map((i) => i.userId)).size, 5);

  const ultimaEscritura = fakeSheets.calls.at(-1);
  assert.equal(ultimaEscritura.length, 5);
  assert.equal(new Set(ultimaEscritura.map((f) => f[0])).size, 5);

  for (const m of miembros) {
    assert.equal(m.roles.cache.has(activa.roleId), true, `${m.id} debe tener el rol`);
  }
});

test('CONCURRENCIA: alta y baja a la vez -> resultado coherente entre JSON, hoja y rol', async () => {
  await cerrarSiHayActiva();
  const { activa } = await abrirCta({ nombre: 'ConcurrenciaMixta' });
  const seQueda = guild.addMember('mix-1', 'Mix1');
  await apuntarViaModal('mix-1', 'Mix1', ['Tank', 'Healer', 'DPS']);
  const seVa = guild.members.cache.get('mix-1');
  assert.equal(seVa.roles.cache.has(activa.roleId), true);

  fakeSheets.calls.length = 0;
  const nuevo = guild.addMember('mix-2', 'Mix2');

  await Promise.all([
    apuntarViaModal('mix-2', 'Mix2', ['Support', 'DPS', 'Scout']),
    desapuntarViaBoton('mix-1', 'Mix1'),
  ]);
  await wait(100);

  const activaFinal = await ctaStore.ctaActiva(CTA_PATH);
  assert.equal(activaFinal.inscritos.length, 1);
  assert.equal(activaFinal.inscritos[0].userId, 'mix-2');

  assert.equal(seVa.roles.cache.has(activa.roleId), false);
  assert.equal(nuevo.roles.cache.has(activa.roleId), true);

  const ultimaEscritura = fakeSheets.calls.at(-1);
  assert.equal(ultimaEscritura.length, 1);
  assert.equal(ultimaEscritura[0][0], 'Mix2');
});

// ============================================================
// FALLOS DE GOOGLE
// ============================================================

test('FALLOS DE GOOGLE: la hoja caída deja al usuario inscrito en local, avisa en el footer y en el canal de logs, y /cta sync lo recupera', async () => {
  await cerrarSiHayActiva();
  const { activa } = await abrirCta({ nombre: 'FalloGoogle' });
  await wait(100); // asienta la limpieza inicial del bloque

  fakeSheets.shouldFail = true;
  logChannel.sentPayloads.length = 0;

  const modal = await apuntarViaModal('p-google', 'JugadorGoogle', ['Tank', 'Healer', 'DPS']);
  assert.match(modal.lastContent(), /^Apuntado con: Tank, Healer, DPS\./, 'la interacción debe confirmarse igual con Google caído');

  const activaInmediata = await ctaStore.ctaActiva(CTA_PATH);
  assert.ok(activaInmediata.inscritos.some((i) => i.userId === 'p-google'), 'el JSON local ya debe tener la alta');

  await wait(100); // deja disparar el agrupador y fallar
  const activaTrasFallo = await ctaStore.ctaActiva(CTA_PATH);
  assert.equal(activaTrasFallo.sincronizada, false, 'debe quedar marcada como desincronizada');
  assert.equal(logChannel.sentPayloads.length, 1, 'debe avisarse en el canal de logs');

  await wait(100); // deja disparar el reeditado agrupado del embed
  const message = channel.store.get(activa.messageId);
  assert.match(message.embeds[0].footer.text, /⚠️ Desincronizada de la hoja/);

  // Se recupera la red: /cta sync reintenta ya y limpia el aviso.
  fakeSheets.shouldFail = false;
  fakeSheets.calls.length = 0;
  const syncInteraction = new FakeChatInputInteraction({
    channelId: CHANNEL_ID,
    channel,
    guild,
    member: officer,
    subcommand: 'sync',
    opts: {},
    client,
  });
  await cta.execute(syncInteraction);

  assert.match(syncInteraction.lastContent(), /✔️ Hoja/);
  assert.equal((await ctaStore.ctaActiva(CTA_PATH)).sincronizada, true);
  assert.ok(fakeSheets.calls.at(-1).some((fila) => fila[0] === 'JugadorGoogle'));

  await cerrarSiHayActiva();
});

// ============================================================
// VARIOS
// ============================================================

test('VARIOS: una CTA ya activa se rechaza indicando el canal (mención <#id>, legible aunque el canal no sea visible desde otro servidor) y la hora', async () => {
  await cerrarSiHayActiva();
  const { activa } = await abrirCta({ nombre: 'YaActiva' });
  const cierraEnSeconds = Math.floor(new Date(activa.cierraEn).getTime() / 1000);

  const interaction = abrirInteraction({ opts: { nombre: 'Otra', minutos: 15 } });
  await cta.execute(interaction);

  const msg = JSON.stringify(interaction.replies.at(-1));
  assert.match(msg, new RegExp(`<#${CHANNEL_ID}>`));
  assert.match(msg, new RegExp(`<t:${cierraEnSeconds}:R>`));
});

test('VARIOS: nombre vacío o de solo espacios se rechaza', async () => {
  await cerrarSiHayActiva();
  for (const nombre of ['', '   ']) {
    const interaction = abrirInteraction({ opts: { nombre, minutos: 30 } });
    await cta.execute(interaction);
    assert.match(JSON.stringify(interaction.replies.at(-1)), /Nombre inválido/);
    assert.equal(await ctaStore.ctaActiva(CTA_PATH), null);
  }
});

test('VARIOS: nombre de 60 caracteres se acepta y el rol se crea con un nombre válido', async () => {
  await cerrarSiHayActiva();
  const nombre60 = 'x'.repeat(60);
  const { activa } = await abrirCta({ nombre: nombre60 });
  const role = guild.roles.cache.get(activa.roleId);
  assert.ok(role);
  assert.ok(role.name.length <= 100);
  assert.match(role.name, /^x+_\d{4}-\d{4}$/);
});

test('VARIOS: un usuario sin rol de oficial no puede lanzar ningún subcomando de /cta', async () => {
  await cerrarSiHayActiva();
  const noOfficer = guild.addMember('no-officer', 'NoOficial');

  for (const subcommand of ['abrir', 'sync', 'roles', 'cerrar', 'hoja', 'pestana', 'rango']) {
    const interaction = new FakeChatInputInteraction({
      channelId: CHANNEL_ID,
      channel,
      guild,
      member: noOfficer,
      subcommand,
      opts: { nombre: 'X', minutos: 30, id: 'sheet-x', celda: 'P3' },
      client,
    });
    await cta.execute(interaction);
    assert.match(JSON.stringify(interaction.replies.at(-1)), /Sin permiso/, `subcomando "${subcommand}" debía rechazarse`);
  }
});

test('VARIOS: minutos 0 y 5000 se rechazan', async () => {
  await cerrarSiHayActiva();
  for (const minutos of [0, 5000]) {
    const interaction = abrirInteraction({ opts: { nombre: 'Minutos', minutos } });
    await cta.execute(interaction);
    assert.match(JSON.stringify(interaction.replies.at(-1)), /Duración inválida/);
    assert.equal(await ctaStore.ctaActiva(CTA_PATH), null);
  }
});

test('VARIOS: /cta roles lista solo roles de CTA, del más antiguo al más reciente, sin borrar nada', async () => {
  await cerrarSiHayActiva();
  guild.roles.cache = new Map([...guild.roles.cache].filter(([id]) => !id.startsWith('filler-')));

  const { activa: primera } = await abrirCta({ nombre: 'ListaA' });
  await cerrarSiHayActiva();
  const { activa: segunda } = await abrirCta({ nombre: 'ListaB' });

  const antesDeListar = guild.roles.cache.size;
  const interaction = new FakeChatInputInteraction({
    channelId: CHANNEL_ID,
    channel,
    guild,
    member: officer,
    subcommand: 'roles',
    opts: {},
    client,
  });
  await cta.execute(interaction);

  assert.equal(guild.roles.cache.size, antesDeListar, '/cta roles no debe borrar nada');
  const embed = interaction.editReplies.at(-1).embeds[0].toJSON();
  const idxA = embed.description.indexOf('ListaA');
  const idxB = embed.description.indexOf('ListaB');
  assert.ok(idxA !== -1 && idxB !== -1);
  assert.ok(idxA < idxB, 'la más antigua (ListaA) debe listarse primero');

  await cerrarSiHayActiva();
});

// ============================================================
// CIERRE MANUAL: /cta cerrar
// ============================================================

function configInteraction(subcommand, opts = {}) {
  return new FakeChatInputInteraction({
    channelId: CHANNEL_ID,
    channel,
    guild,
    member: officer,
    subcommand,
    opts,
    client,
  });
}

test('/cta cerrar: cierra la CTA activa antes de tiempo y confirma con el nombre y el número de inscritos', async () => {
  await cerrarSiHayActiva();
  const { activa } = await abrirCta({ nombre: 'CierreDesdeComando' });
  await apuntarViaModal('p1', 'Jugador1', ['Tank', 'Healer', 'DPS'], activa.id);

  const interaction = configInteraction('cerrar');
  await cta.execute(interaction);

  assert.equal(await ctaStore.ctaActiva(CTA_PATH), null, 'debe quedar cerrada de inmediato');
  assert.match(interaction.lastContent(), /^CTA "CierreDesdeComando" cerrada antes de tiempo\. 1 inscrito\(s\)\. La hoja no se ha tocado\.$/);
});

test('/cta cerrar: sin ninguna CTA activa, avisa en vez de fallar', async () => {
  await cerrarSiHayActiva();
  const interaction = configInteraction('cerrar');
  await cta.execute(interaction);

  assert.equal(interaction.lastContent(), 'No hay ninguna CTA activa.');
});

// ============================================================
// CONFIGURACIÓN EN CALIENTE: /cta hoja, /cta pestana, /cta rango
// ============================================================

test('/cta hoja: guarda el ID tal cual, lo confirma y avisa en el canal de logs', async () => {
  logChannel.sentPayloads.length = 0;
  const interaction = configInteraction('hoja', { id: 'sheet-id-directo' });
  await cta.execute(interaction);

  assert.equal(await getSheetIdOverride(CTA_SHEET_CONFIG_PATH), 'sheet-id-directo');
  assert.match(interaction.lastContent(), /^Hoja cambiada a `sheet-id-directo`\./);
  assert.equal(logChannel.sentPayloads.length, 1);
  const embed = logChannel.sentPayloads.at(-1).embeds[0].toJSON();
  assert.match(embed.description, /hoja.*sheet-id-directo/);
});

test('/cta hoja: si pegan la URL completa, se queda solo con el ID', async () => {
  const interaction = configInteraction('hoja', {
    id: 'https://docs.google.com/spreadsheets/d/1AbC-xyz_9/edit#gid=0',
  });
  await cta.execute(interaction);

  assert.equal(await getSheetIdOverride(CTA_SHEET_CONFIG_PATH), '1AbC-xyz_9');
  assert.match(interaction.lastContent(), /`1AbC-xyz_9`/);
});

test('/cta hoja: un valor de solo espacios se rechaza sin tocar el override guardado', async () => {
  const antes = await getSheetIdOverride(CTA_SHEET_CONFIG_PATH);
  const interaction = configInteraction('hoja', { id: '   ' });
  await cta.execute(interaction);

  assert.equal(interaction.lastContent(), 'El ID de la hoja no puede estar vacío.');
  assert.equal(await getSheetIdOverride(CTA_SHEET_CONFIG_PATH), antes, 'no debe haber pisado el valor anterior');
});

test('/cta pestana: guarda el nombre, lo confirma y avisa en el canal de logs', async () => {
  logChannel.sentPayloads.length = 0;
  const interaction = configInteraction('pestana', { nombre: 'PestañaNueva' });
  await cta.execute(interaction);

  assert.equal(await getSheetTabOverride(CTA_SHEET_CONFIG_PATH), 'PestañaNueva');
  assert.match(interaction.lastContent(), /^Pestaña cambiada a `PestañaNueva`\./);
  assert.equal(logChannel.sentPayloads.length, 1);
  const embed = logChannel.sentPayloads.at(-1).embeds[0].toJSON();
  assert.match(embed.description, /pestaña.*PestañaNueva/);
});

test('/cta pestana: un nombre de solo espacios se rechaza sin tocar el override guardado', async () => {
  const antes = await getSheetTabOverride(CTA_SHEET_CONFIG_PATH);
  const interaction = configInteraction('pestana', { nombre: '   ' });
  await cta.execute(interaction);

  assert.equal(interaction.lastContent(), 'El nombre de la pestaña no puede estar vacío.');
  assert.equal(await getSheetTabOverride(CTA_SHEET_CONFIG_PATH), antes);
});

test('/cta rango: una celda válida se guarda, se confirma y avisa en el canal de logs', async () => {
  logChannel.sentPayloads.length = 0;
  const interaction = configInteraction('rango', { celda: 'B5' });
  await cta.execute(interaction);

  assert.equal(await getRangoInicioOverride(CTA_SHEET_CONFIG_PATH), 'B5');
  assert.match(interaction.lastContent(), /^Rango de inicio cambiado a `B5`\./);
  assert.equal(logChannel.sentPayloads.length, 1);
  const embed = logChannel.sentPayloads.at(-1).embeds[0].toJSON();
  assert.match(embed.description, /rango de inicio.*B5/);
});

test('/cta rango: una celda con formato inválido se rechaza, sin persistir nada ni avisar en logs', async () => {
  const antes = await getRangoInicioOverride(CTA_SHEET_CONFIG_PATH);
  logChannel.sentPayloads.length = 0;
  const interaction = configInteraction('rango', { celda: 'noesunaceldavalida' });
  await cta.execute(interaction);

  assert.match(interaction.lastContent(), /no es una referencia de celda válida/);
  assert.equal(await getRangoInicioOverride(CTA_SHEET_CONFIG_PATH), antes, 'no debe haber pisado el valor anterior');
  assert.equal(logChannel.sentPayloads.length, 0, 'una validación rechazada no debe avisar en el canal de logs');
});
