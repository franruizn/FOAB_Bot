import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCtaEmbed, ctaButtonCustomId, parseCtaButtonCustomId, CTA_BOTON_APUNTARSE, CTA_BOTON_PANEL } from './ctaEmbed.js';

function ctaFixture(overrides = {}) {
  return {
    id: 'cta_123',
    nombre: 'Hellgate',
    modo: 'caller',
    ubicacion: 'Martlock',
    notas: '',
    callerId: 'caller-1',
    cierraEn: new Date('2026-08-19T21:30:00Z').toISOString(),
    roleId: 'role-1',
    roleNombre: 'Hellgate_1908-2030',
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
        oculto: { nombre: 'Oculto', emoji: '🕵️', categoria: null, nota: '' },
      },
      parties: [{ nombre: 'Party 1', slots: ['hoj', 'maza-pesada', 'santi', 'perma', 'perma'] }],
    },
    inscritos: [],
    asignaciones: {},
    ...overrides,
  };
}

test('cabecera: ubicación, caller, modo, cierre y contador de asignados', () => {
  const cta = ctaFixture();
  const { embeds } = buildCtaEmbed({ cta });
  const desc = embeds[0].toJSON().description;

  assert.match(desc, /Martlock/);
  assert.match(desc, /<@caller-1>/);
  assert.match(desc, /Caller asigna/);
  assert.match(desc, /<t:\d+:R>/);
  assert.match(desc, /0\/5/); // 0 asignados de 5 slots totales
});

test('un field por party, con el emoji de categoría DELANTE del emoji del arma', () => {
  const cta = ctaFixture();
  const { embeds } = buildCtaEmbed({ cta });
  const field = embeds[0].toJSON().fields.find((f) => f.name === 'Party 1');

  assert.equal(
    field.value,
    ['🟣 ⚖️ HOJ — *libre*', '🔵 🔨 Maza Pesada — *libre*', '🟢 🧪 Santi — *libre*', '🟢 ❄️ Perma — *libre*', '🟢 ❄️ Perma — *libre*'].join('\n'),
  );
});

test('un slot asignado muestra la mención <@id>, no el nombre guardado', () => {
  const cta = ctaFixture({
    inscritos: [{ userId: 'u1', nombre: 'FokinFran', roles: ['hoj'], preferido: 'hoj', tentativo: false, ts: new Date().toISOString() }],
    asignaciones: { '0:0': { userId: 'u1', bloqueado: false, avisadoEn: null } },
  });
  const { embeds } = buildCtaEmbed({ cta });
  const field = embeds[0].toJSON().fields.find((f) => f.name === 'Party 1');

  assert.match(field.value, /🟣 ⚖️ HOJ — <@u1>/);
  assert.doesNotMatch(field.value, /FokinFran/);
});

test('un rol sin categoría no lleva emoji de categoría, y no aparece en la línea de cobertura', () => {
  const cta = ctaFixture({
    comp: {
      ...ctaFixture().comp,
      parties: [{ nombre: 'Party 1', slots: ['oculto'] }],
    },
  });
  const { embeds } = buildCtaEmbed({ cta });
  const json = embeds[0].toJSON();
  const field = json.fields.find((f) => f.name === 'Party 1');

  assert.equal(field.value, '🕵️ Oculto — *libre*');
  assert.equal(json.fields.some((f) => f.value.includes('Oculto')), true);
  // ninguna línea de cobertura (el único slot es de un rol sin categoría)
  assert.equal(json.fields.some((f) => f.name === '\u200b'), false);
});

test('party vacía (sin slots) se muestra igual, con un placeholder', () => {
  const cta = ctaFixture({ comp: { ...ctaFixture().comp, parties: [{ nombre: 'Party 2', slots: [] }] } });
  const { embeds } = buildCtaEmbed({ cta });
  const field = embeds[0].toJSON().fields.find((f) => f.name === 'Party 2');
  assert.equal(field.value, '—');
});

test('línea de cobertura por categoría, ordenada por "orden", excluyendo categorías sin slots', () => {
  const cta = ctaFixture({
    asignaciones: { '0:0': { userId: 'u1', bloqueado: false, avisadoEn: null } }, // asigna el HOJ (caller)
  });
  const { embeds } = buildCtaEmbed({ cta });
  const cobertura = embeds[0].toJSON().fields.find((f) => f.name === '\u200b');

  assert.equal(cobertura.value, '🟣 Caller 1/1 · 🔵 Tanque 0/1 · 🟢 Soporte 0/3');
});

test('field "Sin asignar" muestra mención + emojis de sus roles + marca de tentativo', () => {
  const cta = ctaFixture({
    inscritos: [
      { userId: 'u1', nombre: 'A', roles: ['maza-pesada'], preferido: 'maza-pesada', tentativo: false, ts: new Date().toISOString() },
      { userId: 'u2', nombre: 'B', roles: ['santi', 'perma'], preferido: 'santi', tentativo: true, ts: new Date().toISOString() },
    ],
  });
  const { embeds } = buildCtaEmbed({ cta });
  const field = embeds[0].toJSON().fields.find((f) => f.name.startsWith('Sin asignar'));

  assert.equal(field.name, 'Sin asignar (2)');
  assert.equal(field.value, '<@u1> 🔨\n<@u2> 🧪❄️ *(tentativo)*');
});

test('field "Sin asignar" muestra "—" cuando todos están asignados o no hay inscritos', () => {
  const cta = ctaFixture();
  const { embeds } = buildCtaEmbed({ cta });
  const field = embeds[0].toJSON().fields.find((f) => f.name === 'Sin asignar');
  assert.equal(field.value, '—');
});

test('nombres libres se escapan (markdown), las menciones nunca', () => {
  const cta = ctaFixture({ nombre: '**Hellgate**', ubicacion: '_Martlock_' });
  const { embeds } = buildCtaEmbed({ cta });
  const json = embeds[0].toJSON();

  assert.equal(json.title, '\\*\\*Hellgate\\*\\*');
  assert.match(json.description, /\\_Martlock\\_/);
  assert.match(json.description, /<@caller-1>/); // la mención no se escapa
});

test('botones: 4, con el ctaId codificado en el customId', () => {
  const cta = ctaFixture();
  const { components } = buildCtaEmbed({ cta });
  const row = components[0].toJSON();

  assert.equal(row.components.length, 4);
  const customIds = row.components.map((b) => b.custom_id);
  assert.deepEqual(customIds, [
    ctaButtonCustomId('cta_123', CTA_BOTON_APUNTARSE),
    'cta:cta_123:tentativo',
    'cta:cta_123:salir',
    ctaButtonCustomId('cta_123', CTA_BOTON_PANEL),
  ]);
});

test('parseCtaButtonCustomId: round-trip con ctaButtonCustomId', () => {
  const customId = ctaButtonCustomId('cta_999', CTA_BOTON_APUNTARSE);
  assert.deepEqual(parseCtaButtonCustomId(customId), { ctaId: 'cta_999', accion: CTA_BOTON_APUNTARSE });
});

test('parseCtaButtonCustomId: devuelve null para un customId que no es de CTA', () => {
  assert.equal(parseCtaButtonCustomId('squads-delete-confirm-123'), null);
  assert.equal(parseCtaButtonCustomId(''), null);
});

test('parseCtaButtonCustomId: una acción con sus propios ":" (panel del caller) se preserva entera', () => {
  const parsed = parseCtaButtonCustomId('cta:cta_123:panel-asignar-slot:user-9:2');
  assert.deepEqual(parsed, { ctaId: 'cta_123', accion: 'panel-asignar-slot:user-9:2' });
});

test('cerrada: false por defecto, con los 4 botones habilitados', () => {
  const cta = ctaFixture();
  const { components } = buildCtaEmbed({ cta });
  const botones = components[0].components;
  assert.equal(botones.length, 4);
  for (const boton of botones) {
    assert.equal(boton.toJSON().disabled, false);
  }
});

test('cerrada: true deshabilita los 4 botones y marca título/descripción', () => {
  const cta = ctaFixture();
  const { embeds, components } = buildCtaEmbed({ cta, cerrada: true });
  const json = embeds[0].toJSON();

  assert.match(json.title, /CERRADA/);
  assert.match(json.title, /Hellgate/);
  assert.match(json.description, /🔒 \*\*Cerrada:\*\*/);

  const botones = components[0].components;
  assert.equal(botones.length, 4);
  for (const boton of botones) {
    assert.equal(boton.toJSON().disabled, true);
  }
});

test('cerrada: no borra parties/asignaciones del embed, sigue mostrando la composición final', () => {
  const cta = ctaFixture({ asignaciones: { '0:0': { userId: 'u1' } } });
  const { embeds } = buildCtaEmbed({ cta, cerrada: true });
  const value = embeds[0].toJSON().fields[0].value;
  assert.match(value, /<@u1>/);
});

function totalEmbedLength(json) {
  return (
    (json.title?.length ?? 0) +
    (json.description?.length ?? 0) +
    (json.footer?.text?.length ?? 0) +
    (json.fields ?? []).reduce((acc, f) => acc + f.name.length + f.value.length, 0)
  );
}

test('comp de 20 parties llenas y asignadas: no pasa de 25 fields, ningún field pasa de 1024 y el total no pasa de 6000', () => {
  const NUM_PARTIES = 20;
  const SLOTS_POR_PARTY = 30; // suficiente para que, sin presupuesto compartido, cada field por sí solo ya rozara/superara 1024

  const parties = Array.from({ length: NUM_PARTIES }, (_, i) => ({
    nombre: `Party ${i + 1}`,
    slots: Array.from({ length: SLOTS_POR_PARTY }, () => 'santi'),
  }));

  const asignaciones = {};
  let userSeq = 100000000000000001n;
  parties.forEach((party, partyIdx) => {
    party.slots.forEach((_, slotIdx) => {
      asignaciones[`${partyIdx}:${slotIdx}`] = { userId: String(userSeq++) };
    });
  });

  const base = ctaFixture();
  const cta = ctaFixture({ comp: { ...base.comp, parties }, asignaciones });
  const { embeds } = buildCtaEmbed({ cta });
  const json = embeds[0].toJSON();

  assert.ok(json.fields.length <= 25, `demasiados fields: ${json.fields.length}`);
  for (const field of json.fields) {
    assert.ok(field.value.length <= 1024, `field "${field.name}" se pasa de 1024: ${field.value.length}`);
  }
  assert.ok(totalEmbedLength(json) <= 6000, `el embed se pasa de 6000 caracteres: ${totalEmbedLength(json)}`);
});

test('60 inscritos sin asignar: el field "Sin asignar" corta con "+N más" sin partir ninguna mención', () => {
  const base = ctaFixture();
  const inscritos = Array.from({ length: 60 }, (_, i) => ({
    userId: `1000000000000000${String(i).padStart(2, '0')}`,
    roles: ['santi'],
    tentativo: false,
  }));
  const cta = ctaFixture({ comp: base.comp, inscritos, asignaciones: {} });

  const { embeds } = buildCtaEmbed({ cta });
  const field = embeds[0].toJSON().fields.find((f) => f.name.startsWith('Sin asignar'));

  assert.ok(field.value.length <= 1024);
  assert.match(field.value, /\+\d+ más$/);
  // Ninguna mención <@...> quedó cortada a la mitad: cada "<@" tiene su ">" correspondiente.
  const aperturas = (field.value.match(/<@/g) ?? []).length;
  const cierres = (field.value.match(/>/g) ?? []).length;
  assert.equal(aperturas, cierres);
});

test('volcadoPendiente: con cerrada, avisa de que la hoja quedó pendiente y de /cta sync', () => {
  const cta = ctaFixture();
  const { embeds } = buildCtaEmbed({ cta, cerrada: true, volcadoPendiente: true });
  assert.match(embeds[0].toJSON().description, /pendiente de volcar/i);
  assert.match(embeds[0].toJSON().description, /\/cta sync/);
});

test('volcadoPendiente: sin cerrada (CTA abierta), nunca se muestra aunque venga en true', () => {
  const cta = ctaFixture();
  const { embeds } = buildCtaEmbed({ cta, cerrada: false, volcadoPendiente: true });
  assert.doesNotMatch(embeds[0].toJSON().description, /pendiente de volcar/i);
});

test('cerrada sin volcadoPendiente (por defecto): no muestra el aviso de hoja pendiente', () => {
  const cta = ctaFixture();
  const { embeds } = buildCtaEmbed({ cta, cerrada: true });
  assert.doesNotMatch(embeds[0].toJSON().description, /pendiente de volcar/i);
});
