import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// DATA_DIR temporal, fijado ANTES de importar nada que lo lea.
const DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'i18n-test-'));
process.env.DATA_DIR = DATA_DIR;
after(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
});

const { TABLES, t, tn, langFromLocale, userLang, guildLang, replyLang, localizations } = await import('./i18n.js');
const { setConfig } = await import('./services/guildStore.js');
const { CONFIG_FIELDS } = await import('./services/configFields.js');

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

// --- el árbol de comandos: lo que Discord rechazaría al registrar ---

const COMMAND_MODULES = ['getkills', 'squads', 'attendance', 'health', 'sorteo', 'crearRol', 'dm', 'config'];
const commands = await Promise.all(
  COMMAND_MODULES.map(async (name) => (await import(`./commands/${name}.js`)).data.toJSON()),
);

// Mismo patrón que Discord para nombres de comando y de opción: minúsculas,
// sin espacios ni acentos ni ñ, 1-32 caracteres.
const NAME_PATTERN = /^[-_a-z0-9]{1,32}$/;
const DESCRIPTION_MAX = 100;
const CHOICE_NAME_MAX = 100;

/** Recorre comando, subcomandos y opciones: [ruta, nodo] */
function* walk(node, trail = []) {
  const here = [...trail, node.name];
  yield [here.join(' '), node];
  for (const option of node.options ?? []) yield* walk(option, here);
}

test('todos los nombres (y sus traducciones) cumplen el patrón de Discord en todo el árbol', () => {
  for (const command of commands) {
    for (const [where, node] of walk(command)) {
      for (const name of [node.name, ...Object.values(node.name_localizations ?? {})]) {
        assert.match(name, NAME_PATTERN, `${where}: "${name}"`);
      }
    }
  }
});

test('todas las descripciones (y sus traducciones) tienen 1-100 caracteres, y las choices también', () => {
  for (const command of commands) {
    for (const [where, node] of walk(command)) {
      for (const description of [node.description, ...Object.values(node.description_localizations ?? {})]) {
        assert.ok(description.length >= 1 && description.length <= DESCRIPTION_MAX, `${where}: ${description.length} caracteres`);
      }
      for (const choice of node.choices ?? []) {
        for (const name of [choice.name, ...Object.values(choice.name_localizations ?? {})]) {
          assert.ok(name.length >= 1 && name.length <= CHOICE_NAME_MAX, `${where} choice "${name}"`);
        }
      }
    }
  }
});

test('las traducciones llevan es-ES y es-419, y nunca cambian el valor de una choice', () => {
  for (const command of commands) {
    for (const [where, node] of walk(command)) {
      for (const map of [node.name_localizations, node.description_localizations].filter(Boolean)) {
        assert.deepEqual(Object.keys(map).sort(), ['es-419', 'es-ES'], where);
      }
      for (const choice of node.choices ?? []) {
        assert.ok(typeof choice.value === 'number' || /^[a-z0-9-]+$/.test(choice.value), `${where}: valor "${choice.value}"`);
      }
    }
  }
});

test('no hay nombres de comando duplicados en ningún idioma, ni de opción dentro de un mismo nivel', () => {
  for (const locale of ['en', 'es-ES', 'es-419']) {
    const nameIn = (node) => (locale === 'en' ? node.name : (node.name_localizations?.[locale] ?? node.name));
    const top = commands.map(nameIn);
    assert.equal(new Set(top).size, top.length, `${locale}: ${top.join(', ')}`);
    for (const command of commands) {
      for (const [where, node] of walk(command)) {
        const siblings = (node.options ?? []).map(nameIn);
        assert.equal(new Set(siblings).size, siblings.length, `${locale} ${where}: ${siblings.join(', ')}`);
      }
    }
  }
});

test('nombres canónicos en inglés; /squads y /config sin traducir el nombre, el resto traducidos', () => {
  const byName = Object.fromEntries(commands.map((command) => [command.name, command]));
  assert.deepEqual(Object.keys(byName).sort(), ['attendance', 'config', 'create-role', 'dm', 'getkills', 'health', 'raffle', 'squads']);

  const es = (name) => byName[name].name_localizations?.['es-ES'];
  assert.equal(es('raffle'), 'sorteo');
  assert.equal(es('create-role'), 'crear-rol');
  assert.equal(es('attendance'), 'asistencia');
  assert.equal(es('health'), 'estado');
  assert.equal(es('getkills'), 'getkills');
  assert.equal(es('dm'), 'dm');

  // Administración: un único nombre en todo el árbol, pero descripciones traducidas.
  for (const name of ['squads', 'config']) {
    for (const [where, node] of walk(byName[name])) {
      assert.equal(node.name_localizations ?? null, null, `${where} no debe traducir el nombre`);
      assert.ok(node.description_localizations?.['es-ES'], `${where} sin descripción en español`);
    }
  }
  assert.deepEqual(
    byName.config.options.map((sub) => sub.name),
    ['view', 'officer', 'logs', 'raffle-role', 'dm-optout', 'server', 'guild', 'albionbb', 'language', 'reset'],
  );
  assert.deepEqual(
    byName.squads.options.map((sub) => sub.name).sort(),
    ['add', 'create', 'delete', 'find', 'list', 'move', 'remove', 'rename', 'show'],
  );
});

test('las choices traducen el nombre visible, no el valor', () => {
  const days = commands.find((c) => c.name === 'attendance').options.find((o) => o.name === 'days');
  assert.deepEqual(
    days.choices.map((c) => [c.value, c.name, c.name_localizations['es-ES']]),
    [
      [7, '7 days', '7 días'],
      [14, '14 days', '14 días'],
      [30, '30 days', '30 días'],
      [90, '90 days', '90 días'],
    ],
  );
});

// --- las tablas ---

test('toda clave que existe en un idioma existe en el otro', () => {
  const en = Object.keys(TABLES.en);
  const es = Object.keys(TABLES.es);
  assert.deepEqual(en.filter((key) => !(key in TABLES.es)), [], 'faltan en español');
  assert.deepEqual(es.filter((key) => !(key in TABLES.en)), [], 'faltan en inglés');
});

test('los dos idiomas usan los mismos marcadores {valor} en cada clave', () => {
  const markers = (text) => [...new Set(text.match(/\{\w+\}/g) ?? [])].sort();
  for (const key of Object.keys(TABLES.en)) {
    assert.deepEqual(markers(TABLES.es[key]), markers(TABLES.en[key]), key);
  }
});

test('ningún texto pega un "(s)" para el plural: el plural va en claves .one / .other', () => {
  for (const [lang, table] of Object.entries(TABLES)) {
    for (const [key, text] of Object.entries(table)) {
      assert.doesNotMatch(text, /\w\((s|es)\)/, `${lang} ${key}`);
    }
  }
});

test('toda clave usada en el código existe (literales de t() y tn(), y las familias dinámicas)', async () => {
  const files = [];
  const collect = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await collect(full);
      else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) files.push(full);
    }
  };
  await collect(SRC_DIR);

  const missing = [];
  const has = (key) => key in TABLES.en;
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const [, fn, key] of source.matchAll(/\b(t|tn|localizedName|localizedDescription|localizedChoice|LocalizedError|Error)\(\s*['"]([a-zA-Z][\w.]+)['"]/g)) {
      if (!key.includes('.')) continue;
      const ok = fn === 'tn' ? has(`${key}.one`) && has(`${key}.other`) : has(key);
      if (!ok) missing.push(`${path.relative(SRC_DIR, file)}: ${key}`);
    }
  }
  // Familias que el código compone con una parte variable.
  for (const field of CONFIG_FIELDS) {
    for (const part of ['label', 'missing', 'gap']) {
      if (!has(`config.field.${field.key}.${part}`)) missing.push(`config.field.${field.key}.${part}`);
    }
    for (const command of field.blocks) if (!has(`cmd.${command}.name`)) missing.push(`cmd.${command}.name`);
  }
  for (const action of ['add', 'remove', 'move']) if (!has(`squadsError.guildSquad.${action}`)) missing.push(action);
  for (const kind of ['players', 'guild']) if (!has(`squadsError.exists.${kind}`)) missing.push(kind);
  for (const role of ['tank', 'support', 'healer', 'meleeDps', 'rangedDps', 'mounted']) {
    if (!has(`attendance.role.${role}`)) missing.push(role);
  }
  for (const lang of ['en', 'es']) if (!has(`common.language.${lang}`)) missing.push(lang);

  assert.deepEqual(missing, []);
});

// --- t() ---

test('t() sustituye los marcadores y elige el idioma', () => {
  assert.equal(t('squadsError.notFound', 'en', { squad: 'foab' }), 'The squad "foab" does not exist.');
  assert.equal(t('squadsError.notFound', 'es', { squad: 'foab' }), 'El squad "foab" no existe.');
});

test('t() con una clave inexistente no revienta ni enseña la clave cruda', () => {
  const text = t('no.existe.esta.clave', 'es');
  assert.equal(typeof text, 'string');
  assert.doesNotMatch(text, /no\.existe/);
  assert.equal(text, TABLES.en['common.textUnavailable']);
});

test('t() con una clave que falta en un idioma cae al inglés', () => {
  const key = 'test.soloEnIngles';
  TABLES.en[key] = 'Only in English';
  try {
    assert.equal(t(key, 'es'), 'Only in English');
  } finally {
    delete TABLES.en[key];
  }
});

test('t() con un idioma desconocido usa el inglés', () => {
  assert.equal(t('common.cancel', 'fr'), 'Cancel');
});

test('tn() elige .one o .other por el número', () => {
  assert.equal(tn('squads.delete.body.players', 1, 'es'), 'Tenía 1 miembro.');
  assert.equal(tn('squads.delete.body.players', 3, 'es'), 'Tenía 3 miembros.');
  assert.equal(tn('squads.delete.body.players', 0, 'en'), 'It had 0 members.');
});

// --- qué idioma se usa ---

test('las dos locales de Discord en español son español; cualquier otra, inglés', () => {
  assert.equal(langFromLocale('es-ES'), 'es');
  assert.equal(langFromLocale('es-419'), 'es');
  assert.equal(langFromLocale('en-US'), 'en');
  assert.equal(langFromLocale('pt-BR'), 'en');
  assert.equal(langFromLocale(undefined), 'en');
  assert.deepEqual(Object.keys(localizations('cmd.raffle.name')).sort(), ['es-419', 'es-ES']);
});

test('una respuesta efímera usa interaction.locale; una pública, el idioma del servidor', async () => {
  const guildId = '900000000000000001';
  await setConfig(guildId, { idioma: 'es' });
  const englishUser = { guildId, locale: 'en-US' };

  assert.equal(userLang(englishUser), 'en');
  assert.equal(await guildLang(guildId), 'es');

  // La misma persona, según cómo se respondió:
  assert.equal(await replyLang({ ...englishUser, deferred: true, ephemeral: true }), 'en');
  assert.equal(await replyLang({ ...englishUser, deferred: true, ephemeral: false }), 'es');
  assert.equal(await replyLang({ ...englishUser, deferred: false, replied: false }), 'en');
});
