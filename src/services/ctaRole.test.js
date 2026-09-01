import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoleName, crearRolCta, borrarRolCta, reconciliarRolCta, CtaRoleError, CTA_ROLE_NAME_PATTERN } from './ctaRole.js';
import { FakeGuild } from '../testHelpers/discordFakes.js';

function makeGuildWithBot() {
  const guild = new FakeGuild();
  const bot = guild.addMember('bot-1', 'FOAB Bot');
  guild.members.me = bot;
  return { guild, bot };
}

// ============================================================
// buildRoleName(): formato "<nombre>_<ddMM-HHmm>"
// ============================================================

test('buildRoleName() reproduce exactamente el ejemplo del prompt', () => {
  const fecha = new Date(2026, 7, 19, 20, 30); // 19 ago 2026, 20:30
  assert.equal(buildRoleName('Hellgate', fecha), 'Hellgate_1908-2030');
});

test('buildRoleName() recorta espacios exteriores y colapsa espacios repetidos', () => {
  const fecha = new Date(2026, 0, 5, 9, 5);
  assert.equal(buildRoleName('  Avalonian   Dungeon  ', fecha), 'Avalonian Dungeon_0501-0905');
});

test('buildRoleName() rechaza "@everyone"/"@here" (con variantes de mayúsculas/espacios)', () => {
  assert.throws(() => buildRoleName('@everyone', new Date()), CtaRoleError);
  assert.throws(() => buildRoleName('@here', new Date()), CtaRoleError);
  assert.throws(() => buildRoleName('  @EVERYONE  ', new Date()), CtaRoleError);
});

test('buildRoleName() recorta el nombre para no superar 100 caracteres, sin recortar nunca el sufijo de fecha', () => {
  const fecha = new Date(2026, 11, 31, 23, 59);
  const nombre = buildRoleName('x'.repeat(200), fecha);
  assert.ok(nombre.length <= 100, `esperaba <=100, tiene ${nombre.length}`);
  assert.match(nombre, /_3112-2359$/);
});

test('CTA_ROLE_NAME_PATTERN reconoce el formato nuevo y no confunde otros roles', () => {
  assert.ok(CTA_ROLE_NAME_PATTERN.test('Hellgate_1908-2030'));
  assert.ok(!CTA_ROLE_NAME_PATTERN.test('Oficiales'));
  assert.ok(!CTA_ROLE_NAME_PATTERN.test('Hellgate_123456789012')); // formato viejo (timestamp en ms)
});

// ============================================================
// crearRolCta(): las 3 comprobaciones previas + creación + aviso de cupo
// ============================================================

test('crearRolCta() falla sin el permiso ManageRoles, sin crear ningún rol', async () => {
  const { guild, bot } = makeGuildWithBot();
  guild.__botHasManageRoles = false;
  const antes = guild.roles.cache.size;

  await assert.rejects(() => crearRolCta(guild, 'Hellgate', 'cta_1', new Date()), (err) => {
    assert.ok(err instanceof CtaRoleError);
    assert.match(err.message, /Gestionar roles/);
    return true;
  });
  assert.equal(guild.roles.cache.size, antes, 'no debe haberse creado ningún rol');
});

test('crearRolCta() falla si el rol más alto del bot está en la posición 1 o menos', async () => {
  const { guild, bot } = makeGuildWithBot();
  bot.roles.highest = { position: 1 };
  const antes = guild.roles.cache.size;

  await assert.rejects(() => crearRolCta(guild, 'Hellgate', 'cta_1', new Date()), (err) => {
    assert.ok(err instanceof CtaRoleError);
    assert.match(err.message, /jerarquía|Ajustes del servidor/);
    return true;
  });
  assert.equal(guild.roles.cache.size, antes);
});

test('crearRolCta() falla con 250 roles ya en el servidor', async () => {
  const { guild } = makeGuildWithBot();
  guild.addFillerRoles(250);
  const antes = guild.roles.cache.size;

  await assert.rejects(() => crearRolCta(guild, 'Hellgate', 'cta_1', new Date()), (err) => {
    assert.ok(err instanceof CtaRoleError);
    assert.match(err.message, /250/);
    return true;
  });
  assert.equal(guild.roles.cache.size, antes);
});

test('crearRolCta() con 200-249 roles crea el rol igual, pero devuelve un aviso', async () => {
  const { guild } = makeGuildWithBot();
  guild.addFillerRoles(205); // + el que se va a crear = 206

  const { roleId, roleNombre, warning } = await crearRolCta(guild, 'Hellgate', 'cta_1', new Date());
  assert.ok(roleId);
  assert.ok(roleNombre.startsWith('Hellgate_'));
  assert.ok(warning);
  assert.match(warning, /206 roles/);
});

test('crearRolCta() con menos de 200 roles no devuelve aviso', async () => {
  const { guild } = makeGuildWithBot();
  const { warning } = await crearRolCta(guild, 'Hellgate', 'cta_1', new Date());
  assert.equal(warning, null);
});

test('crearRolCta() crea el rol con name/mentionable:true/hoist:false/reason="CTA <id>"', async () => {
  const { guild } = makeGuildWithBot();
  const fecha = new Date(2026, 7, 19, 20, 30);
  const { roleId, roleNombre } = await crearRolCta(guild, 'Hellgate', 'cta_42', fecha);

  const role = guild.roles.cache.get(roleId);
  assert.equal(role.name, 'Hellgate_1908-2030');
  assert.equal(roleNombre, role.name);
  assert.equal(role.mentionable, true);
  assert.equal(role.hoist, false);
  assert.equal(role.reason, 'CTA cta_42');
});

test('crearRolCta() envuelve un fallo de guild.roles.create() diciendo que las comprobaciones previas pasaron, sin sugerir causas, con el motivo real visible', async () => {
  const { guild } = makeGuildWithBot();
  // "Missing Permissions" a propósito: aunque el texto del error real suene
  // a permisos, precheckCtaRole() YA confirmó ManageRoles unas líneas antes
  // — el mensaje no debe volver a sugerir eso como causa.
  guild.__forceCreateFail = 'Missing Permissions';

  await assert.rejects(() => crearRolCta(guild, 'Hellgate', 'cta_1', new Date()), (err) => {
    assert.ok(err instanceof CtaRoleError);
    assert.match(err.message, /comprobaciones previas/);
    assert.match(err.message, /pasaron/);
    assert.match(err.message, /Missing Permissions/, 'el error real debe seguir visible');
    assert.doesNotMatch(err.message, /¿le falta|Gestionar roles.*bot/i, 'no debe volver a sugerir que falta el permiso: ya se comprobó que lo tiene');
    return true;
  });
});

// ============================================================
// borrarRolCta(): rollback, nunca lanza
// ============================================================

test('borrarRolCta() borra el rol', async () => {
  const { guild } = makeGuildWithBot();
  const { roleId } = await crearRolCta(guild, 'Hellgate', 'cta_1', new Date());
  assert.ok(guild.roles.cache.has(roleId));

  await borrarRolCta(guild, roleId);
  assert.ok(!guild.roles.cache.has(roleId));
});

test('borrarRolCta() nunca lanza, incluso si el borrado falla', async () => {
  const { guild } = makeGuildWithBot();
  guild.roles.delete = async () => {
    throw new Error('boom');
  };
  await assert.doesNotReject(() => borrarRolCta(guild, 'role-inexistente'));
});

// ============================================================
// reconciliarRolCta(): altas/bajas/omitidos contra `activa.inscritos`
// ============================================================

test('reconciliarRolCta() da el rol a quien está inscrito y no lo tiene', async () => {
  const { guild } = makeGuildWithBot();
  const { roleId } = await crearRolCta(guild, 'Hellgate', 'cta_1', new Date());
  const p1 = guild.addMember('p1', 'Jugador1');

  const activa = { id: 'cta_1', roleId, inscritos: [{ userId: 'p1' }] };
  const resultado = await reconciliarRolCta(guild, activa);

  assert.equal(p1.roles.cache.has(roleId), true);
  assert.deepEqual(resultado, { altas: 1, bajas: 0, omitidos: 0 });
});

test('reconciliarRolCta() quita el rol a quien lo tiene sin estar inscrito', async () => {
  const { guild } = makeGuildWithBot();
  const { roleId } = await crearRolCta(guild, 'Hellgate', 'cta_1', new Date());
  const p1 = guild.addMember('p1', 'Jugador1');
  p1.roles.cache.set(roleId, { id: roleId });

  const activa = { id: 'cta_1', roleId, inscritos: [] };
  const resultado = await reconciliarRolCta(guild, activa);

  assert.equal(p1.roles.cache.has(roleId), false);
  assert.deepEqual(resultado, { altas: 0, bajas: 1, omitidos: 0 });
});

test('reconciliarRolCta() no repite la llamada a quien ya tiene el rol correctamente', async () => {
  const { guild } = makeGuildWithBot();
  const { roleId } = await crearRolCta(guild, 'Hellgate', 'cta_1', new Date());
  const p1 = guild.addMember('p1', 'Jugador1');
  p1.roles.cache.set(roleId, { id: roleId });
  guild.__forceRoleOpFail.add('p1'); // si add()/remove() se llamaran, esto los haría fallar

  const activa = { id: 'cta_1', roleId, inscritos: [{ userId: 'p1' }] };
  const resultado = await reconciliarRolCta(guild, activa);

  assert.deepEqual(resultado, { altas: 0, bajas: 0, omitidos: 0 });
  assert.equal(p1.roles.cache.has(roleId), true);
});

test('reconciliarRolCta() salta sin fallar a quien está inscrito pero ya no está en el servidor, y lo cuenta como omitido', async () => {
  const { guild } = makeGuildWithBot();
  const { roleId } = await crearRolCta(guild, 'Hellgate', 'cta_1', new Date());
  // p1 está inscrito pero nunca se añadió como miembro del servidor (o se fue).

  const activa = { id: 'cta_1', roleId, inscritos: [{ userId: 'p1' }] };
  const resultado = await reconciliarRolCta(guild, activa);

  assert.deepEqual(resultado, { altas: 0, bajas: 0, omitidos: 1 });
});

test('reconciliarRolCta() maneja altas y bajas a la vez, en la misma pasada', async () => {
  const { guild } = makeGuildWithBot();
  const { roleId } = await crearRolCta(guild, 'Hellgate', 'cta_1', new Date());
  const inscritoSinRol = guild.addMember('p1', 'Jugador1');
  const noInscritoConRol = guild.addMember('p2', 'Jugador2');
  noInscritoConRol.roles.cache.set(roleId, { id: roleId });

  const activa = { id: 'cta_1', roleId, inscritos: [{ userId: 'p1' }] };
  const resultado = await reconciliarRolCta(guild, activa);

  assert.equal(inscritoSinRol.roles.cache.has(roleId), true);
  assert.equal(noInscritoConRol.roles.cache.has(roleId), false);
  assert.deepEqual(resultado, { altas: 1, bajas: 1, omitidos: 0 });
});

test('reconciliarRolCta() lanza CtaRoleError si el rol ya no existe (lo borró un humano)', async () => {
  const { guild } = makeGuildWithBot();
  const activa = { id: 'cta_1', roleId: 'role-borrado', inscritos: [] };

  await assert.rejects(() => reconciliarRolCta(guild, activa), CtaRoleError);
});

test('reconciliarRolCta() no hace nada si la CTA no tiene roleId', async () => {
  const { guild } = makeGuildWithBot();
  const activa = { id: 'cta_1', roleId: null, inscritos: [{ userId: 'p1' }] };
  const resultado = await reconciliarRolCta(guild, activa);
  assert.deepEqual(resultado, { altas: 0, bajas: 0, omitidos: 0 });
});
