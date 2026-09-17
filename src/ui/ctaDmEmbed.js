import { EmbedBuilder, escapeMarkdown } from 'discord.js';

// Dorado, no verde: el DM de asignación tiene que distinguirse de un vistazo
// del embed público de la CTA. Si prefieres azul, cámbialo aquí
// (0x3498db) — está en este único sitio, no depende de la categoría ni de
// nada configurable.
const EMBED_COLOR_DM = 0xe6b422;

function datosDelRol(cta, rolKey) {
  const rol = cta.comp.roles[rolKey];
  const categoria = rol.categoria ? cta.comp.categorias[rol.categoria] : null;
  return { rol, categoria };
}

function lineasComunes(cta) {
  const cierraTs = Math.floor(new Date(cta.cierraEn).getTime() / 1000);
  return [
    cta.ubicacion ? `📍 **Ubicación:** ${escapeMarkdown(cta.ubicacion)}` : null,
    `📣 **Caller:** ${cta.callerId ? `<@${cta.callerId}>` : '—'}`,
    `⏰ **Cierra:** <t:${cierraTs}:R>`,
  ].filter((linea) => linea !== null);
}

/**
 * DM al quedar asignado por primera vez a un slot: nombre de la CTA, party,
 * rol (con su emoji de categoría delante del suyo propio), la nota del rol
 * si tiene, ubicación, caller y hora de cierre.
 * @param {object} params
 * @param {object} params.cta
 * @param {string} params.rolKey
 * @param {string} params.partyNombre
 * @returns {EmbedBuilder}
 */
export function buildAsignacionDmEmbed({ cta, rolKey, partyNombre }) {
  const { rol, categoria } = datosDelRol(cta, rolKey);
  const prefijoCategoria = categoria ? `${categoria.emoji} ` : '';

  const descripcion = [
    `Te han asignado en **${escapeMarkdown(cta.nombre)}**:`,
    '',
    `${prefijoCategoria}${rol.emoji} **${escapeMarkdown(rol.nombre)}** — ${escapeMarkdown(partyNombre)}`,
    rol.nota ? `_${escapeMarkdown(rol.nota)}_` : null,
    '',
    ...lineasComunes(cta),
  ]
    .filter((linea) => linea !== null)
    .join('\n');

  return new EmbedBuilder().setColor(EMBED_COLOR_DM).setTitle(`✅ Asignado — ${cta.nombre}`).setDescription(descripcion);
}

/**
 * DM al REASIGNAR a alguien ya asignado: de dónde a dónde, para que no se
 * quede con la party vieja en la cabeza.
 * @param {object} params
 * @param {object} params.cta
 * @param {string} params.rolKey
 * @param {string} params.partyNombre
 * @param {string} params.rolAnteriorKey
 * @param {string} params.partyAnteriorNombre
 * @returns {EmbedBuilder}
 */
export function buildReasignacionDmEmbed({ cta, rolKey, partyNombre, rolAnteriorKey, partyAnteriorNombre }) {
  const { rol, categoria } = datosDelRol(cta, rolKey);
  const prefijoCategoria = categoria ? `${categoria.emoji} ` : '';

  const { rol: rolAnterior } = datosDelRol(cta, rolAnteriorKey);

  const descripcion = [
    `Te han **cambiado de sitio** en **${escapeMarkdown(cta.nombre)}**:`,
    '',
    `De: ${rolAnterior.emoji} ${escapeMarkdown(rolAnterior.nombre)} — ${escapeMarkdown(partyAnteriorNombre)}`,
    `A: ${prefijoCategoria}${rol.emoji} **${escapeMarkdown(rol.nombre)}** — ${escapeMarkdown(partyNombre)}`,
    rol.nota ? `_${escapeMarkdown(rol.nota)}_` : null,
    '',
    ...lineasComunes(cta),
  ]
    .filter((linea) => linea !== null)
    .join('\n');

  return new EmbedBuilder().setColor(EMBED_COLOR_DM).setTitle(`🔄 Reasignado — ${cta.nombre}`).setDescription(descripcion);
}
