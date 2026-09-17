import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildJugadorEmbed, buildRankingEmbed } from './maestriaEmbed.js';

const resolverRol = (rolKey) =>
  ({ santi: { nombre: 'Santi', emoji: '🧪' }, 'maza-pesada': { nombre: 'Maza Pesada', emoji: '🔨' } })[rolKey] ?? null;

test('buildJugadorEmbed: sin historial, lo dice explícitamente', () => {
  const embed = buildJugadorEmbed({ nombre: 'Ana', jugador: null, resolverRol });
  const json = embed.toJSON();
  assert.match(json.title, /Ana/);
  assert.match(json.description, /Sin historial/);
});

test('buildJugadorEmbed: ordena de más a menos veces jugadas, muestra estrellas y última vez', () => {
  const jugador = {
    roles: { santi: 20, 'maza-pesada': 2 },
    ultimo: { santi: '2026-09-17T20:30:00.000Z', 'maza-pesada': '2026-08-01T00:00:00.000Z' },
  };
  const embed = buildJugadorEmbed({ nombre: 'Ana', jugador, resolverRol });
  const desc = embed.toJSON().description;
  const lineas = desc.split('\n');

  assert.match(lineas[0], /Santi/);
  assert.match(lineas[0], /★★★/); // 20 veces -> nivel 3
  assert.match(lineas[0], /<t:\d+:R>/);
  assert.match(lineas[1], /Maza Pesada/);
  assert.match(lineas[1], /★/); // 2 veces -> nivel 1
});

test('buildJugadorEmbed: nunca muestra el número crudo de veces jugadas', () => {
  const jugador = { roles: { santi: 34 }, ultimo: {} };
  const embed = buildJugadorEmbed({ nombre: 'Ana', jugador, resolverRol });
  assert.doesNotMatch(embed.toJSON().description, /34/);
});

test('buildJugadorEmbed: un rol con 0 veces (residual) no aparece', () => {
  const jugador = { roles: { santi: 0, 'maza-pesada': 3 }, ultimo: {} };
  const embed = buildJugadorEmbed({ nombre: 'Ana', jugador, resolverRol });
  assert.doesNotMatch(embed.toJSON().description, /Santi/);
});

test('buildJugadorEmbed: un rol que ya no está en ninguna comp se muestra con su rolKey', () => {
  const jugador = { roles: { 'rol-borrado': 5 }, ultimo: {} };
  const embed = buildJugadorEmbed({ nombre: 'Ana', jugador, resolverRol });
  assert.match(embed.toJSON().description, /rol-borrado/);
});

test('buildRankingEmbed: vacío, lo dice explícitamente', () => {
  const embed = buildRankingEmbed({ rolKey: 'santi', rolInfo: resolverRol('santi'), ranking: [] });
  assert.match(embed.toJSON().description, /Nadie tiene historial/);
});

test('buildRankingEmbed: numerado, con menciones y estrellas', () => {
  const ranking = [
    { userId: 'u1', veces: 60 },
    { userId: 'u2', veces: 3 },
  ];
  const embed = buildRankingEmbed({ rolKey: 'santi', rolInfo: resolverRol('santi'), ranking });
  const lineas = embed.toJSON().description.split('\n');

  assert.match(lineas[0], /^\*\*1\.\*\* <@u1> ★★★★★$/);
  assert.match(lineas[1], /^\*\*2\.\*\* <@u2> ★$/);
});

test('buildRankingEmbed: título incluye el emoji y nombre del rol resuelto', () => {
  const embed = buildRankingEmbed({ rolKey: 'santi', rolInfo: resolverRol('santi'), ranking: [] });
  assert.match(embed.toJSON().title, /🧪 Santi/);
});
