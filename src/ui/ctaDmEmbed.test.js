import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAsignacionDmEmbed, buildReasignacionDmEmbed } from './ctaDmEmbed.js';

function ctaFixture(overrides = {}) {
  return {
    nombre: 'Hellgate',
    ubicacion: 'Martlock',
    callerId: 'caller-1',
    cierraEn: new Date('2026-08-19T21:30:00Z').toISOString(),
    comp: {
      categorias: { tanque: { nombre: 'Tanque', emoji: '🔵', orden: 1 } },
      roles: {
        'maza-pesada': { nombre: 'Maza Pesada', emoji: '🔨', categoria: 'tanque', nota: 'Aguanta el frente' },
        santi: { nombre: 'Santi', emoji: '🧪', categoria: null, nota: '' },
      },
    },
    ...overrides,
  };
}

test('buildAsignacionDmEmbed: borde dorado (0xe6b422), no depende de la categoría', () => {
  const cta = ctaFixture();
  const embed = buildAsignacionDmEmbed({ cta, rolKey: 'maza-pesada', partyNombre: 'Party 1' }).toJSON();
  assert.equal(embed.color, 0xe6b422);
});

test('buildAsignacionDmEmbed: emoji de categoría delante del propio, party, nota, ubicación, caller y cierre', () => {
  const cta = ctaFixture();
  const embed = buildAsignacionDmEmbed({ cta, rolKey: 'maza-pesada', partyNombre: 'Party 1' }).toJSON();

  assert.match(embed.description, /🔵 🔨 \*\*Maza Pesada\*\* — Party 1/);
  assert.match(embed.description, /Aguanta el frente/);
  assert.match(embed.description, /📍 \*\*Ubicación:\*\* Martlock/);
  assert.match(embed.description, /📣 \*\*Caller:\*\* <@caller-1>/);
  assert.match(embed.description, /⏰ \*\*Cierra:\*\* <t:\d+:R>/);
});

test('buildAsignacionDmEmbed: sin nota, no deja una línea vacía de más', () => {
  const cta = ctaFixture();
  const embed = buildAsignacionDmEmbed({ cta, rolKey: 'santi', partyNombre: 'Party 1' }).toJSON();
  assert.doesNotMatch(embed.description, /_ _/);
  assert.match(embed.description, /🧪 \*\*Santi\*\* — Party 1/); // sin prefijo de categoría, "santi" no tiene
});

test('buildReasignacionDmEmbed: dice de dónde a dónde, también en dorado', () => {
  const cta = ctaFixture();
  const embed = buildReasignacionDmEmbed({
    cta, rolKey: 'maza-pesada', partyNombre: 'Party 2', rolAnteriorKey: 'santi', partyAnteriorNombre: 'Party 1',
  }).toJSON();

  assert.equal(embed.color, 0xe6b422);
  assert.match(embed.description, /De: 🧪 Santi — Party 1/);
  assert.match(embed.description, /A: 🔵 🔨 \*\*Maza Pesada\*\* — Party 2/);
});
