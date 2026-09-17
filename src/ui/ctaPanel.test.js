import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StringSelectMenuOptionBuilder } from 'discord.js';
import {
  coberturaDeRol,
  buildOpcionesJugador,
  buildOpcionesBloqueo,
  buildOpcionesSlot,
  ordenarPorEscasezDePreferido,
  buildSelectPanelMessage,
  buildMainPanelMessage,
} from './ctaPanel.js';

function ctaFixture(overrides = {}) {
  return {
    id: 'cta_123',
    nombre: 'Hellgate',
    channelId: 'chan-1',
    comp: {
      categorias: {
        caller: { nombre: 'Caller', emoji: '🟣', orden: 1 },
        tanque: { nombre: 'Tanque', emoji: '🔵', orden: 2 },
        soporte: { nombre: 'Soporte', emoji: '🟢', orden: 3 },
      },
      roles: {
        hoj: { nombre: 'HOJ', emoji: '⚖️', categoria: 'caller', nota: '' },
        'maza-pesada': { nombre: 'Maza Pesada', emoji: '🔨', categoria: 'tanque', nota: '' },
        santi: { nombre: 'Santi', emoji: '🧪', categoria: 'soporte', nota: '' },
        perma: { nombre: 'Perma', emoji: '❄️', categoria: 'soporte', nota: '' },
      },
      parties: [
        { nombre: 'Party 1', slots: ['hoj', 'maza-pesada', 'santi'] },
        { nombre: 'Party 2', slots: ['maza-pesada', 'perma', 'perma'] },
      ],
    },
    inscritos: [],
    asignaciones: {},
    ...overrides,
  };
}

function inscrito(overrides = {}) {
  return { userId: 'u1', nombre: 'Fran', roles: ['maza-pesada'], preferido: 'maza-pesada', tentativo: false, ts: new Date().toISOString(), ...overrides };
}

// { u1: { santi: 3 } } -> la forma real de maestria.json ({ jugadores: { u1: { roles: { santi: 3 } } } })
function maestriaFixture(porJugador) {
  return { jugadores: Object.fromEntries(Object.entries(porJugador).map(([userId, roles]) => [userId, { roles }])) };
}

test('coberturaDeRol: cuenta total y asignados de un rol en toda la comp', () => {
  const cta = ctaFixture({ asignaciones: { '1:0': { userId: 'u1', bloqueado: false, avisadoEn: null } } });
  assert.deepEqual(coberturaDeRol(cta, 'maza-pesada'), { asignados: 1, total: 2 });
  assert.deepEqual(coberturaDeRol(cta, 'perma'), { asignados: 0, total: 2 });
  assert.deepEqual(coberturaDeRol(cta, 'hoj'), { asignados: 0, total: 1 });
});

test('buildOpcionesJugador: label = nombre + estrellas del rol PREFERIDO, no de otro', () => {
  const cta = ctaFixture();
  const jugador = inscrito({ roles: ['maza-pesada', 'santi'], preferido: 'santi' });
  const maestria = maestriaFixture({ u1: { 'maza-pesada': 30, santi: 6 } });

  const [opt] = buildOpcionesJugador(cta, [jugador], maestria).map((o) => o.toJSON());
  assert.equal(opt.label, 'Fran ★★'); // preferido es santi (6 veces -> nivel 2), no maza-pesada (30 -> nivel 4)
});

test('buildOpcionesJugador: label sin estrellas si el preferido no tiene historial', () => {
  const cta = ctaFixture();
  const [opt] = buildOpcionesJugador(cta, [inscrito()], {}).map((o) => o.toJSON());
  assert.equal(opt.label, 'Fran');
});

test('buildOpcionesJugador: recorta el nombre a 32 caracteres con "…"', () => {
  const cta = ctaFixture();
  const jugador = inscrito({ nombre: 'X'.repeat(50) });
  const [opt] = buildOpcionesJugador(cta, [jugador], {}).map((o) => o.toJSON());
  assert.equal(opt.label.length, 32);
  assert.ok(opt.label.endsWith('…'));
});

test('buildOpcionesJugador: descripción con el desglose completo, ordenado por maestría descendente', () => {
  const cta = ctaFixture();
  const jugador = inscrito({ roles: ['maza-pesada', 'hoj', 'santi'], preferido: 'maza-pesada' });
  const maestria = maestriaFixture({ u1: { 'maza-pesada': 30, hoj: 1, santi: 6 } }); // niveles 4, 1, 2 respectivamente
  const [opt] = buildOpcionesJugador(cta, [jugador], maestria).map((o) => o.toJSON());
  assert.equal(opt.description, '🔵 Maza Pesada ★★★★ · 🟢 Santi ★★ · 🟣 HOJ ★');
});

test('buildOpcionesJugador: si no caben todos los roles, se queda con los 3 de más maestría y "+N"', () => {
  const cta = ctaFixture({
    comp: {
      categorias: { x: { nombre: 'X', emoji: '🟣', orden: 1 } },
      roles: Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`rol-${i}`, { nombre: `Rol Numero ${i}`, emoji: '⚔️', categoria: 'x', nota: '' }]),
      ),
      parties: [{ nombre: 'Party 1', slots: Array.from({ length: 10 }, (_, i) => `rol-${i}`) }],
    },
  });
  const roles = Array.from({ length: 10 }, (_, i) => `rol-${i}`);
  const jugador = inscrito({ roles, preferido: 'rol-0' });
  const maestria = maestriaFixture({ u1: Object.fromEntries(roles.map((r, i) => [r, 10 - i])) });

  const [opt] = buildOpcionesJugador(cta, [jugador], maestria).map((o) => o.toJSON());
  assert.ok(opt.description.length <= 100);
  assert.match(opt.description, /Rol Numero 0/); // el de más maestría, presente
  assert.match(opt.description, /\+7$/); // 10 roles, se quedan 3 -> +7
  assert.doesNotMatch(opt.description, /Rol Numero 9/); // el de menos maestría, fuera
});

test('ordenarPorEscasezDePreferido: primero quien tiene el preferido menos cubierto', () => {
  const cta = ctaFixture({
    // maza-pesada: 2 slots, 1 asignado (50% cubierto). perma: 2 slots, 0 asignados (0% cubierto).
    asignaciones: { '1:0': { userId: 'otro', bloqueado: false, avisadoEn: null } },
  });
  const jugadorMaza = inscrito({ userId: 'u1', nombre: 'A', preferido: 'maza-pesada' });
  const jugadorPerma = inscrito({ userId: 'u2', nombre: 'B', preferido: 'perma' });

  const orden = ordenarPorEscasezDePreferido(cta, [jugadorMaza, jugadorPerma]);
  assert.deepEqual(orden.map((i) => i.userId), ['u2', 'u1']); // perma (0% cubierto) antes que maza-pesada (50%)
});

test('ordenarPorEscasezDePreferido: un preferido que no aparece en ninguna party va al final', () => {
  const cta = ctaFixture();
  const jugadorSinRolEnParty = inscrito({ userId: 'u1', nombre: 'A', roles: ['perma'], preferido: 'perma' });
  const jugadorConHueco = inscrito({ userId: 'u2', nombre: 'B', roles: ['hoj'], preferido: 'hoj' });
  // "hoj" tiene 1 slot en la comp; "perma" tiene 2 -> ambos con cobertura 0%,
  // pero para probar "total 0" usamos un preferido inventado que no está en ninguna party.
  const jugadorPreferidoInexistente = inscrito({ userId: 'u3', nombre: 'C', roles: ['perma'], preferido: 'no-esta-en-ninguna-party' });

  const orden = ordenarPorEscasezDePreferido(cta, [jugadorPreferidoInexistente, jugadorConHueco, jugadorSinRolEnParty]);
  assert.equal(orden.at(-1).userId, 'u3'); // el preferido "fantasma" (cobertura total=0) va al final
});

test('buildOpcionesSlot ("Asignar"): solo libres, compatibles primero con estrellas, incompatibles al final sin estrellas y marcados', () => {
  const cta = ctaFixture();
  const jugador = inscrito({ roles: ['santi'], preferido: 'santi' });
  const maestria = maestriaFixture({ u1: { santi: 15 } }); // 15 veces -> nivel 3

  const opciones = buildOpcionesSlot({ cta, inscrito: jugador, maestria, incluirOcupados: false }).map((o) => o.toJSON());

  // libres: 0:0 hoj, 0:1 maza-pesada, 0:2 santi, 1:0 maza-pesada, 1:1 perma, 1:2 perma (6 slots, todos libres)
  assert.equal(opciones.length, 6);
  const compatibleIdx = opciones.findIndex((o) => o.value === '0:2'); // santi
  assert.ok(compatibleIdx < opciones.length - 1 || opciones.length === 1);
  assert.equal(opciones[compatibleIdx].label, 'Party 1 · 🟢 🧪 Santi ★★★');
  assert.match(opciones[compatibleIdx].description, /quedan \d slot/);

  // el resto son incompatibles: marcados, sin estrellas
  const incompatibles = opciones.filter((o) => o.value !== '0:2');
  for (const inc of incompatibles) {
    assert.match(inc.label, /^⚠️ /);
    assert.doesNotMatch(inc.label, /★/);
  }
  // compatibles antes que incompatibles en el orden del array
  assert.equal(opciones[0].value, '0:2');
});

test('buildOpcionesSlot ("Asignar"): nunca ofrece un slot ya ocupado', () => {
  const cta = ctaFixture({ asignaciones: { '0:2': { userId: 'otro', bloqueado: false, avisadoEn: null } } });
  const jugador = inscrito({ roles: ['santi'], preferido: 'santi' });
  const opciones = buildOpcionesSlot({ cta, inscrito: jugador, maestria: {}, incluirOcupados: false });
  assert.equal(opciones.some((o) => o.toJSON().value === '0:2'), false);
});

test('buildOpcionesSlot ("Asignar"): nunca ofrece un slot bloqueado', () => {
  const cta = ctaFixture({
    asignaciones: { '0:2': { userId: 'otro', bloqueado: true, avisadoEn: null } },
  });
  const jugador = inscrito({ roles: ['santi'], preferido: 'santi' });
  const opciones = buildOpcionesSlot({ cta, inscrito: jugador, maestria: {}, incluirOcupados: true }); // ni con incluirOcupados
  assert.equal(opciones.some((o) => o.toJSON().value === '0:2'), false);
});

test('buildOpcionesSlot ("Mover"): con incluirOcupados, muestra ocupados (para intercambiar) salvo el propio', () => {
  const cta = ctaFixture({
    inscritos: [inscrito({ userId: 'u1', nombre: 'Fran' }), inscrito({ userId: 'u2', nombre: 'Sylhunter' })],
    asignaciones: {
      '0:1': { userId: 'u1', bloqueado: false, avisadoEn: null }, // el propio slot del jugador
      '1:0': { userId: 'u2', bloqueado: false, avisadoEn: null }, // ocupado por otro
    },
  });
  const jugador = cta.inscritos[0]; // u1, en 0:1

  const opciones = buildOpcionesSlot({ cta, inscrito: jugador, maestria: {}, incluirOcupados: true }).map((o) => o.toJSON());

  assert.equal(opciones.some((o) => o.value === '0:1'), false); // su propio slot, no es un destino
  const ocupadoPorOtro = opciones.find((o) => o.value === '1:0');
  assert.match(ocupadoPorOtro.description, /Ocupado por Sylhunter · se intercambian/);
});

test('buildOpcionesBloqueo: antepone 🔒 a quien ya tiene el slot bloqueado', () => {
  const cta = ctaFixture({
    inscritos: [inscrito({ userId: 'u1', nombre: 'Fran' })],
    asignaciones: { '0:1': { userId: 'u1', bloqueado: true, avisadoEn: null } },
  });
  const [opt] = buildOpcionesBloqueo(cta, cta.inscritos, {}).map((o) => o.toJSON());
  assert.equal(opt.label, '🔒 Fran');
  assert.match(opt.description, /^Bloqueado/);
});

test('buildSelectPanelMessage: null si no hay opciones', () => {
  const resultado = buildSelectPanelMessage({
    ctaId: 'cta_1', opciones: [], selectCustomId: 'x', accionPaginaBase: 'x-pag', placeholder: 'p', encabezado: 'e',
  });
  assert.equal(resultado, null);
});

function opcionSimple(i) {
  return new StringSelectMenuOptionBuilder().setValue(`v${i}`).setLabel(`Opción ${i}`);
}

test('buildSelectPanelMessage: sin paginación si hay 25 o menos', () => {
  const opciones = Array.from({ length: 10 }, (_, i) => opcionSimple(i));
  const resultado = buildSelectPanelMessage({
    ctaId: 'cta_1', opciones, selectCustomId: 'x', accionPaginaBase: 'x-pag', placeholder: 'p', encabezado: 'Elige',
  });
  assert.equal(resultado.content, 'Elige');
  assert.equal(resultado.components.length, 1); // solo el select, sin fila de paginación
});

test('buildSelectPanelMessage: pagina cuando hay más de 25 opciones', () => {
  const opciones = Array.from({ length: 40 }, (_, i) => opcionSimple(i));
  const resultado = buildSelectPanelMessage({
    ctaId: 'cta_1', opciones, selectCustomId: 'x', accionPaginaBase: 'x-pag', pagina: 0, placeholder: 'p', encabezado: 'Elige',
  });
  assert.match(resultado.content, /página 1\/2/);
  assert.equal(resultado.components.length, 2); // select + fila de paginación
  const botones = resultado.components[1].toJSON().components;
  assert.equal(botones[0].disabled, true); // "Anterior" deshabilitado en la página 0
  assert.equal(botones[1].disabled, false);
});

test('buildMainPanelMessage: título con el nombre de la CTA y su canal, y 6 botones en 2 filas', () => {
  const cta = ctaFixture({
    inscritos: [inscrito({ userId: 'u1' }), inscrito({ userId: 'u2' })],
    asignaciones: { '0:1': { userId: 'u1', bloqueado: false, avisadoEn: null } },
  });
  const { content, components } = buildMainPanelMessage({ cta });

  assert.match(content, /Hellgate/);
  assert.match(content, /<#chan-1>/);
  assert.match(content, /Asignados: 1\/6/);
  assert.match(content, /Sin asignar: 1/);
  assert.equal(components.length, 2);
  assert.equal(components[0].toJSON().components.length, 3);
  assert.equal(components[1].toJSON().components.length, 3);
});

test('buildMainPanelMessage: sin no localizables, no muestra esa línea', () => {
  const cta = ctaFixture();
  const { content } = buildMainPanelMessage({ cta });
  assert.doesNotMatch(content, /No localizables/);
});

test('buildMainPanelMessage: con no localizables, los lista por nombre', () => {
  const cta = ctaFixture({
    inscritos: [inscrito({ userId: 'u1', nombre: 'Fran' })],
    noLocalizables: ['u1'],
  });
  const { content } = buildMainPanelMessage({ cta });
  assert.match(content, /No localizables \(avísales por voz\): Fran/);
});
