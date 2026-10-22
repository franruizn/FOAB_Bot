import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InteractionContextType } from 'discord.js';
import { planDeploy } from './deployPlan.js';

const DEV = '111111111111111111';
const OWNER = '222222222222222222';

const command = (name) => ({ toJSON: () => ({ name }) });
const commands = [command('getkills'), command('config')];
const dmCommand = command('dm');
const names = (body) => body.map((c) => c.name);

test('global: todos menos /dm son globales y solo en servidores; /dm va como comando de guild a DM_GUILD_ID', () => {
  const { steps, warnings } = planDeploy({ scope: 'global', commands, dmCommand, env: { DM_GUILD_ID: OWNER } });

  assert.equal(steps.length, 2);
  assert.equal(steps[0].target, 'global');
  assert.deepEqual(names(steps[0].body), ['getkills', 'config']);
  assert.ok(steps[0].body.every((c) => c.contexts.length === 1 && c.contexts[0] === InteractionContextType.Guild));
  assert.match(steps[0].label, /1 hora/);

  assert.equal(steps[1].target, OWNER);
  assert.deepEqual(names(steps[1].body), ['dm']);
  assert.deepEqual(warnings, []);
});

test('global sin DM_GUILD_ID: /dm no se registra en ninguna parte y lo avisa', () => {
  const { steps, warnings } = planDeploy({ scope: 'global', commands, dmCommand, env: {} });
  assert.equal(steps.length, 1);
  assert.ok(!names(steps[0].body).includes('dm'));
  assert.match(warnings[0], /DM_GUILD_ID/);
});

test('guild (dev): todos, /dm incluido, en GUILD_ID', () => {
  const { steps } = planDeploy({ scope: 'guild', commands, dmCommand, env: { GUILD_ID: DEV } });
  assert.deepEqual(steps.map((s) => [s.target, names(s.body)]), [[DEV, ['getkills', 'config', 'dm']]]);
});

test('clean: borra los de GUILD_ID, salvo /dm si es también DM_GUILD_ID', () => {
  const other = planDeploy({ scope: 'clean', commands, dmCommand, env: { GUILD_ID: DEV, DM_GUILD_ID: OWNER } });
  assert.deepEqual(other.steps[0].body, []);

  const same = planDeploy({ scope: 'clean', commands, dmCommand, env: { GUILD_ID: OWNER, DM_GUILD_ID: OWNER } });
  assert.deepEqual(names(same.steps[0].body), ['dm']);
});

test('errores de configuración del registro', () => {
  assert.throws(() => planDeploy({ scope: 'marte', commands, dmCommand, env: {} }), /DEPLOY_SCOPE inválido/);
  assert.throws(() => planDeploy({ scope: 'clean', commands, dmCommand, env: {} }), /GUILD_ID/);
  assert.throws(() => planDeploy({ scope: 'global', commands, dmCommand, env: { DM_GUILD_ID: 'abc' } }), /DM_GUILD_ID/);
});

// --- con los comandos reales: lo que de verdad se registra ---

const REAL_MODULES = ['getkills', 'squads', 'attendance', 'health', 'sorteo', 'crearRol', 'config'];
const realCommands = await Promise.all(REAL_MODULES.map(async (name) => (await import(`./commands/${name}.js`)).data));
const { data: realDm } = await import('./commands/dm.js');
const realPlan = planDeploy({ scope: 'global', commands: realCommands, dmCommand: realDm, env: { DM_GUILD_ID: OWNER } });

test('registro real: /dm no está en el lote global, solo en DM_GUILD_ID', () => {
  assert.ok(!names(realPlan.steps[0].body).includes('dm'));
  assert.deepEqual(realPlan.steps.slice(1).map((s) => [s.target, names(s.body)]), [[OWNER, ['dm']]]);
});

test('registro real: no queda ningún /cta, /comp ni /maestria', async () => {
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(new URL('./commands/', import.meta.url));
  assert.ok(files.every((file) => !/cta|comp|maestria/i.test(file)), files.join(', '));
  const registered = [...names(realPlan.steps[0].body), 'dm'];
  assert.ok(registered.every((name) => !/^(cta|comp|maestria)$/.test(name)), registered.join(', '));
});

// --- IDIOMA: lo que se registra (el detalle del árbol entero está en src/i18n.test.js) ---

const json = (name) => realPlan.steps[0].body.find((c) => c.name === name);

test('/raffle en inglés, /sorteo con el cliente en español: el mismo comando', () => {
  const raffle = json('raffle');
  assert.ok(raffle, 'no existe /raffle');
  assert.equal(raffle.name_localizations?.['es-ES'], 'sorteo');
});

test('/crear-rol ya no existe suelto: es la localización española de un nombre en inglés', () => {
  assert.equal(json('crear-rol'), undefined);
});

test('/squads y /config: subcomandos en inglés, descripciones localizadas', () => {
  for (const name of ['squads', 'config']) {
    for (const sub of json(name).options) {
      assert.match(sub.name, /^[a-z-]+$/);
      assert.ok(sub.description_localizations?.['es-ES'], `${name} ${sub.name} sin descripción en español`);
    }
  }
  assert.ok(json('config').options.some((sub) => sub.name === 'language'), 'no existe /config language');
});
