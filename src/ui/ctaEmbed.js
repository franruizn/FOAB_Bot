import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, escapeMarkdown } from 'discord.js';
import { truncateList } from './textTruncate.js';

const EMBED_COLOR = 0x00ff9d;
const EMBED_COLOR_CERRADA = 0x808080;
const FIELD_VALUE_MAX = 1024; // límite real de Discord por field
const DISCORD_EMBED_TOTAL_MAX = 6000; // límite real de Discord para título+descripción+fields+footer SUMADOS
const EMBED_SAFETY_MARGIN = 150; // colchón para no rozar el límite exacto (recuentos de emojis, etc.)
const PARTY_FIELD_MIN = 40; // por debajo de esto un field de party deja de ser legible; se prefiere recortar agresivo antes que fallar el envío
const EMPTY_SLOT = '*libre*';

const MODO_LABELS = {
  caller: 'Caller asigna',
  self: 'Auto-asignación al mejor slot libre',
  abierto: 'Abierto — cualquiera reclama un slot libre',
};

// Acciones codificadas en el customId de cada botón: "cta:<ctaId>:<accion>".
// El id del evento SIEMPRE va en el customId (nunca se resuelve por canal):
// un botón pulsado en un mensaje viejo tiene que operar sobre su propia CTA.
export const CTA_BOTON_APUNTARSE = 'apuntarse';
export const CTA_BOTON_TENTATIVO = 'tentativo';
export const CTA_BOTON_SALIR = 'salir';
export const CTA_BOTON_PANEL = 'panel';

/**
 * @param {string} ctaId
 * @param {string} accion - uno de los CTA_BOTON_*
 * @returns {string}
 */
export function ctaButtonCustomId(ctaId, accion) {
  return `cta:${ctaId}:${accion}`;
}

/**
 * Parsea un customId de botón/select de CTA. Devuelve null si no tiene esa
 * forma (para que quien enruta interacciones pueda descartarlo rápido). La
 * "accion" puede contener sus propios ":" (el panel del caller codifica ahí
 * cosas como el jugador elegido o la página: "panel-asignar-slot:<userId>");
 * solo el primer ":" (tras "cta") y el segundo delimitan ctaId, el resto es
 * toda la acción.
 * @param {string} customId
 * @returns {{ ctaId: string, accion: string } | null}
 */
export function parseCtaButtonCustomId(customId) {
  const partes = String(customId ?? '').split(':');
  if (partes.length < 3 || partes[0] !== 'cta') return null;
  return { ctaId: partes[1], accion: partes.slice(2).join(':') };
}

function claveSlot(partyIdx, slotIdx) {
  return `${partyIdx}:${slotIdx}`;
}

function buildBotonesRow(ctaId, { cerrada = false } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(ctaButtonCustomId(ctaId, CTA_BOTON_APUNTARSE))
      .setLabel('Apuntarse')
      .setEmoji('✋')
      .setStyle(ButtonStyle.Success)
      .setDisabled(cerrada),
    new ButtonBuilder()
      .setCustomId(ctaButtonCustomId(ctaId, CTA_BOTON_TENTATIVO))
      .setLabel('Tentativo')
      .setEmoji('❓')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(cerrada),
    new ButtonBuilder()
      .setCustomId(ctaButtonCustomId(ctaId, CTA_BOTON_SALIR))
      .setLabel('Salir')
      .setEmoji('🚪')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(cerrada),
    new ButtonBuilder()
      .setCustomId(ctaButtonCustomId(ctaId, CTA_BOTON_PANEL))
      .setLabel('Panel del caller')
      .setEmoji('🎛️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(cerrada),
  );
}

function lineaDeSlot(cta, rolKey, key) {
  const rol = cta.comp.roles[rolKey];
  const categoria = rol.categoria ? cta.comp.categorias[rol.categoria] : null;
  // El emoji de categoría va DELANTE del emoji del arma, no lo sustituye:
  // uno dice qué arma es, el otro a qué categoría pertenece.
  const prefijo = categoria ? `${categoria.emoji} ` : '';
  const asignacion = cta.asignaciones[key];
  const quien = asignacion ? `<@${asignacion.userId}>` : EMPTY_SLOT;
  return `${prefijo}${rol.emoji} ${escapeMarkdown(rol.nombre)} — ${quien}`;
}

function buildPartyField(cta, party, partyIdx, maxLength) {
  const lineas = party.slots.map((rolKey, slotIdx) => lineaDeSlot(cta, rolKey, claveSlot(partyIdx, slotIdx)));
  // Las parties vacías se muestran igual, con todos los slots en *libre*:
  // ver la composición vacía es el punto, la gente tiene que saber qué
  // falta antes de apuntarse. Una party SIN slots (aún no se le añadió
  // ninguno desde /comp) sí queda con un placeholder, porque no hay nada
  // que listar.
  const value = party.slots.length === 0 ? '—' : truncateList(lineas, maxLength);
  return { name: escapeMarkdown(party.nombre), value, inline: true };
}

/**
 * "🟣 Caller 2/2 · 🔵 Tanque 3/4 · 🟢 Soporte 8/14" — lo que el caller mira
 * para saber de qué anda corto, sin contar slots a ojo. Solo categorías con
 * al menos un slot en la comp; los roles sin categoría no entran aquí (no
 * hay bajo qué agruparlos).
 */
function buildLineaCobertura(cta) {
  const totales = new Map(); // categoriaKey -> { total, asignados }

  cta.comp.parties.forEach((party, partyIdx) => {
    party.slots.forEach((rolKey, slotIdx) => {
      const rol = cta.comp.roles[rolKey];
      if (!rol.categoria) return;
      const entry = totales.get(rol.categoria) ?? { total: 0, asignados: 0 };
      entry.total += 1;
      if (cta.asignaciones[claveSlot(partyIdx, slotIdx)]) entry.asignados += 1;
      totales.set(rol.categoria, entry);
    });
  });

  return Object.entries(cta.comp.categorias)
    .sort((a, b) => a[1].orden - b[1].orden)
    .filter(([key]) => totales.has(key))
    .map(([key, cat]) => {
      const { total, asignados } = totales.get(key);
      return `${cat.emoji} ${escapeMarkdown(cat.nombre)} ${asignados}/${total}`;
    })
    .join(' · ');
}

function buildSinAsignarField(cta) {
  const asignadosIds = new Set(Object.values(cta.asignaciones).map((a) => a.userId));
  const sinAsignar = cta.inscritos.filter((i) => !asignadosIds.has(i.userId));

  if (sinAsignar.length === 0) {
    return { name: 'Sin asignar', value: '—', inline: false };
  }

  const lineas = sinAsignar.map((i) => {
    const emojis = i.roles.map((rolKey) => cta.comp.roles[rolKey]?.emoji ?? '').join('');
    const tentativo = i.tentativo ? ' *(tentativo)*' : '';
    return `<@${i.userId}> ${emojis}${tentativo}`;
  });

  return { name: `Sin asignar (${sinAsignar.length})`, value: truncateList(lineas, FIELD_VALUE_MAX), inline: false };
}

function contarSlots(cta) {
  const total = cta.comp.parties.reduce((acc, party) => acc + party.slots.length, 0);
  const asignados = Object.keys(cta.asignaciones).length;
  return { asignados, total };
}

/**
 * Construye el embed + la row de botones de una CTA, tal como se publica y
 * se reedita en cada cambio (agrupado con el debouncer de 2s, ver
 * ctaEmbedSync.js). Puramente derivado de `cta`: no necesita el guild ni
 * ninguna llamada a Discord.
 * @param {object} params
 * @param {object} params.cta - la CTA tal como la devuelve services/ctaStore.js
 * @param {boolean} [params.cerrada] - si true, deshabilita los botones y marca el embed como cerrado
 * @param {boolean} [params.volcadoPendiente] - si true (solo tiene sentido con cerrada:true), avisa de que el
 *   volcado a Google Sheets falló y queda pendiente de `/cta sync`
 * @returns {{ embeds: import('discord.js').EmbedBuilder[], components: import('discord.js').ActionRowBuilder[] }}
 */
export function buildCtaEmbed({ cta, cerrada = false, volcadoPendiente = false }) {
  const { asignados, total } = contarSlots(cta);
  const cierraTs = Math.floor(new Date(cta.cierraEn).getTime() / 1000);

  const cabecera = [
    cta.ubicacion ? `📍 **Ubicación:** ${escapeMarkdown(cta.ubicacion)}` : null,
    `📣 **Caller:** ${cta.callerId ? `<@${cta.callerId}>` : '—'}`,
    `🎯 **Modo:** ${MODO_LABELS[cta.modo] ?? cta.modo}`,
    cerrada ? `🔒 **Cerrada:** <t:${cierraTs}:R>` : `⏰ **Cierra:** <t:${cierraTs}:R>`,
    `👥 **Asignados:** ${asignados}/${total}`,
    cerrada && volcadoPendiente ? '⚠️ **Hoja de cálculo pendiente de volcar** — usa `/cta sync` en este canal para reintentarlo.' : null,
    cta.notas ? `\n${escapeMarkdown(cta.notas)}` : null,
  ]
    .filter((linea) => linea !== null)
    .join('\n');

  const titulo = escapeMarkdown(cerrada ? `🔒 CERRADA — ${cta.nombre}` : cta.nombre);
  const footerText = cta.roleNombre ? `Rol: @${cta.roleNombre}` : '';
  const cobertura = buildLineaCobertura(cta);
  const coberturaField = cobertura ? { name: '​', value: cobertura, inline: false } : null;
  const sinAsignarField = buildSinAsignarField(cta);

  // Discord no solo limita cada field a 1024 caracteres: también limita la
  // SUMA de título+descripción+todos los fields+footer a 6000. Con comps
  // grandes (hasta MAX_PARTIES=20, ver services/ctaComp.js) veinte fields de
  // party a tope de 1024 cada uno ya suman 20480 por sí solos — muy por
  // encima del total. Así que las parties no usan siempre el máximo de
  // 1024: se reparten lo que quede del presupuesto de 6000 DESPUÉS de
  // reservar sitio para todo lo demás (que no depende del número de
  // parties), repartido a partes iguales entre ellas.
  const presupuestoFijo =
    titulo.length +
    cabecera.length +
    footerText.length +
    (coberturaField ? coberturaField.name.length + coberturaField.value.length : 0) +
    sinAsignarField.name.length +
    sinAsignarField.value.length +
    cta.comp.parties.reduce((acc, party) => acc + escapeMarkdown(party.nombre).length, 0);

  const numParties = cta.comp.parties.length;
  const presupuestoPorParty =
    numParties > 0
      ? Math.max(
          PARTY_FIELD_MIN,
          Math.min(FIELD_VALUE_MAX, Math.floor((DISCORD_EMBED_TOTAL_MAX - EMBED_SAFETY_MARGIN - presupuestoFijo) / numParties)),
        )
      : FIELD_VALUE_MAX;

  const embed = new EmbedBuilder().setColor(cerrada ? EMBED_COLOR_CERRADA : EMBED_COLOR).setTitle(titulo).setDescription(cabecera);

  if (numParties > 0) {
    embed.addFields(cta.comp.parties.map((party, i) => buildPartyField(cta, party, i, presupuestoPorParty)));
  }

  if (coberturaField) {
    embed.addFields(coberturaField);
  }

  embed.addFields(sinAsignarField);

  if (footerText) {
    embed.setFooter({ text: footerText });
  }

  return { embeds: [embed], components: [buildBotonesRow(cta.id, { cerrada })] };
}
