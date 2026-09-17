import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPanelInscripcion, buildSelectorDeSlot, SLOT_SKIP_VALUE } from './ctaInscripcion.js';

function ctaFixture(overrides = {}) {
  return {
    id: 'cta_123',
    nombre: 'Hellgate',
    comp: {
      categorias: {
        caller: { nombre: 'Caller', emoji: '🟣', orden: 1 },
        tanque: { nombre: 'Tanque', emoji: '🔵', orden: 2 },
      },
      roles: {
        hoj: { nombre: 'HOJ', emoji: '⚖️', categoria: 'caller', nota: '' },
        'maza-pesada': { nombre: 'Maza Pesada', emoji: '<:maza:123456789012345678>', categoria: 'tanque', nota: 'Aguanta el frente' },
        santi: { nombre: 'Santi', emoji: '🧪', categoria: null, nota: '' },
      },
      parties: [{ nombre: 'Party 1', slots: ['hoj', 'maza-pesada', 'santi'] }],
    },
    ...overrides,
  };
}

function rowsToJson(components) {
  return components.map((row) => row.toJSON());
}

// { u1: { santi: 3 } } -> la forma real de maestria.json ({ jugadores: { u1: { roles: { santi: 3 } } } })
function maestriaFixture(porJugador) {
  return { jugadores: Object.fromEntries(Object.entries(porJugador).map(([userId, roles]) => [userId, { roles }])) };
}

test('panel: 3 filas (roles, preferido, botones)', () => {
  const cta = ctaFixture();
  const { components } = buildPanelInscripcion({ cta, userId: 'u1', maestria: {}, tentativo: false });
  const json = rowsToJson(components);
  assert.equal(json.length, 3);
  assert.equal(json[2].components.length, 2); // Confirmar + Cancelar
});

test('select de roles: min_values 1, max_values = número de roles', () => {
  const cta = ctaFixture();
  const { components } = buildPanelInscripcion({ cta, userId: 'u1', maestria: {}, tentativo: false });
  const rolesSelect = components[0].toJSON().components[0];
  assert.equal(rolesSelect.min_values, 1);
  assert.equal(rolesSelect.max_values, 3);
  assert.equal(rolesSelect.options.length, 3);
});

test('select de preferido: single-select (min y max 1), mismo listado', () => {
  const cta = ctaFixture();
  const { components } = buildPanelInscripcion({ cta, userId: 'u1', maestria: {}, tentativo: false });
  const preferidoSelect = components[1].toJSON().components[0];
  assert.equal(preferidoSelect.min_values, 1);
  assert.equal(preferidoSelect.max_values, 1);
  assert.equal(preferidoSelect.options.length, 3);
});

test('opciones ordenadas por categoría (orden) y luego por nombre', () => {
  const cta = ctaFixture();
  const { components } = buildPanelInscripcion({ cta, userId: 'u1', maestria: {}, tentativo: false });
  const valores = components[0].toJSON().components[0].options.map((o) => o.value);
  // caller(orden 1)=hoj, tanque(orden 2)=maza-pesada, sin categoría al final=santi
  assert.deepEqual(valores, ['hoj', 'maza-pesada', 'santi']);
});

test('label: emoji de categoría + nombre, sin estrellas si no hay historial', () => {
  const cta = ctaFixture();
  const { components } = buildPanelInscripcion({ cta, userId: 'u1', maestria: {}, tentativo: false });
  const opciones = components[0].toJSON().components[0].options;
  const hoj = opciones.find((o) => o.value === 'hoj');
  assert.equal(hoj.label, '🟣 HOJ');
});

test('label: estrellas SOLO del usuario actual, capadas a 5, nunca "★ 0"', () => {
  const cta = ctaFixture();
  const maestria = maestriaFixture({ u1: { 'maza-pesada': 20 }, u2: { 'maza-pesada': 99 } });

  const panelU1 = buildPanelInscripcion({ cta, userId: 'u1', maestria, tentativo: false });
  const opcionesU1 = panelU1.components[0].toJSON().components[0].options;
  assert.equal(opcionesU1.find((o) => o.value === 'maza-pesada').label, '🔵 Maza Pesada ★★★'); // 20 veces -> nivel 3
  assert.equal(opcionesU1.find((o) => o.value === 'hoj').label, '🟣 HOJ'); // sin historial: sin estrellas

  const panelU2 = buildPanelInscripcion({ cta, userId: 'u2', maestria, tentativo: false });
  const opcionesU2 = panelU2.components[0].toJSON().components[0].options;
  assert.equal(opcionesU2.find((o) => o.value === 'maza-pesada').label, '🔵 Maza Pesada ★★★★★'); // 99 -> capado a 5
});

test('label: un rol sin categoría no lleva prefijo', () => {
  const cta = ctaFixture();
  const { components } = buildPanelInscripcion({ cta, userId: 'u1', maestria: {}, tentativo: false });
  const santi = components[0].toJSON().components[0].options.find((o) => o.value === 'santi');
  assert.equal(santi.label, 'Santi');
});

test('label: se recorta el nombre para no pasar de 100 caracteres, sin recortar el sufijo de estrellas', () => {
  const cta = ctaFixture({
    comp: {
      categorias: { tanque: { nombre: 'Tanque', emoji: '🔵', orden: 1 } },
      roles: { largo: { nombre: 'X'.repeat(150), emoji: '🔨', categoria: 'tanque', nota: '' } },
      parties: [{ nombre: 'Party 1', slots: ['largo'] }],
    },
  });
  const maestria = maestriaFixture({ u1: { largo: 60 } }); // 60 veces -> nivel máximo (5 estrellas)
  const { components } = buildPanelInscripcion({ cta, userId: 'u1', maestria, tentativo: false });
  const label = components[0].toJSON().components[0].options[0].label;

  assert.ok(label.length <= 100);
  assert.ok(label.endsWith(' ★★★★★')); // el sufijo de estrellas nunca se recorta
  assert.ok(label.startsWith('🔵 '));
});

test('description: la nota si tiene, omitida si no', () => {
  const cta = ctaFixture();
  const { components } = buildPanelInscripcion({ cta, userId: 'u1', maestria: {}, tentativo: false });
  const opciones = components[0].toJSON().components[0].options;

  assert.equal(opciones.find((o) => o.value === 'maza-pesada').description, 'Aguanta el frente');
  assert.equal(opciones.find((o) => o.value === 'hoj').description, undefined);
});

test('emoji: custom resuelto se convierte a {id,name,animated}, unicode se mantiene tal cual', () => {
  const cta = ctaFixture();
  const { components } = buildPanelInscripcion({ cta, userId: 'u1', maestria: {}, tentativo: false });
  const opciones = components[0].toJSON().components[0].options;

  const mazaEmoji = opciones.find((o) => o.value === 'maza-pesada').emoji;
  assert.deepEqual(mazaEmoji, { id: '123456789012345678', name: 'maza', animated: false });

  const hojEmoji = opciones.find((o) => o.value === 'hoj').emoji;
  assert.equal(hojEmoji.name, '⚖️');
});

test('preselección: roles/preferido ya inscritos llegan marcados con default:true', () => {
  const cta = ctaFixture();
  const { components } = buildPanelInscripcion({
    cta, userId: 'u1', maestria: {}, tentativo: false,
    seleccionRoles: ['hoj', 'santi'], seleccionPreferido: 'santi',
  });

  const rolesOpts = components[0].toJSON().components[0].options;
  assert.deepEqual(rolesOpts.filter((o) => o.default).map((o) => o.value).sort(), ['hoj', 'santi']);

  const prefOpts = components[1].toJSON().components[0].options;
  assert.deepEqual(prefOpts.filter((o) => o.default).map((o) => o.value), ['santi']);
});

test('sin inscripción previa, ninguna opción sale premarcada', () => {
  const cta = ctaFixture();
  const { components } = buildPanelInscripcion({ cta, userId: 'u1', maestria: {}, tentativo: false });
  const rolesOpts = components[0].toJSON().components[0].options;
  assert.equal(rolesOpts.some((o) => o.default), false);
});

test('el contenido del mensaje distingue apuntarse de tentativo', () => {
  const cta = ctaFixture();
  const normal = buildPanelInscripcion({ cta, userId: 'u1', maestria: {}, tentativo: false });
  const tentativo = buildPanelInscripcion({ cta, userId: 'u1', maestria: {}, tentativo: true });
  assert.doesNotMatch(normal.content, /tentativo/);
  assert.match(tentativo.content, /tentativo/);
});

test('buildSelectorDeSlot: una opción por slot compatible + la de quedarse sin asignar', () => {
  const cta = ctaFixture();
  const slotsCompatibles = [
    { partyIdx: 0, slotIdx: 0, rolKey: 'hoj' },
    { partyIdx: 0, slotIdx: 1, rolKey: 'maza-pesada' },
  ];
  const { components } = buildSelectorDeSlot({ cta, slotsCompatibles });
  const opciones = components[0].toJSON().components[0].options;

  assert.equal(opciones.length, 3);
  assert.equal(opciones.at(-1).value, SLOT_SKIP_VALUE);
  assert.equal(opciones[0].value, '0:0');
  assert.match(opciones[0].label, /Party 1/);
  assert.match(opciones[0].label, /HOJ/);
});

test('buildSelectorDeSlot: nunca pasa de 25 opciones (24 slots + skip)', () => {
  const cta = ctaFixture();
  const slotsCompatibles = Array.from({ length: 30 }, (_, i) => ({ partyIdx: 0, slotIdx: i, rolKey: 'hoj' }));
  const { components } = buildSelectorDeSlot({ cta, slotsCompatibles });
  const opciones = components[0].toJSON().components[0].options;
  assert.equal(opciones.length, 25);
});
