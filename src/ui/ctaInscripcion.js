import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { ordenarRoles } from '../services/ctaComp.js';
import { nivelEstrellas } from '../services/maestria.js';
import { ctaButtonCustomId } from './ctaEmbed.js';

const OPTION_LABEL_MAX = 100; // límite real de Discord para el label de una opción de select
const OPTION_DESCRIPTION_MAX = 100; // ídem para la descripción
const SLOT_OPTIONS_MAX = 24; // 25 - 1 para dejar sitio a "quedarme sin asignar"

export const CTA_SELECT_ROLES = 'sel-roles';
export const CTA_SELECT_PREFERIDO = 'sel-preferido';
export const CTA_SELECT_SLOT = 'sel-slot';
export const CTA_BOTON_CONFIRMAR = 'confirmar';
export const CTA_BOTON_CANCELAR = 'cancelar';
export const SLOT_SKIP_VALUE = '__sin_asignar__';

const CUSTOM_EMOJI_RESUELTO = /^<(a)?:([a-zA-Z0-9_]{2,32}):(\d{15,21})>$/;

/**
 * Convierte un emoji ya resuelto (string) a la forma que espera
 * StringSelectMenuOptionBuilder#setEmoji: un objeto {id,name,animated} para
 * un custom emoji, o el string unicode tal cual.
 */
function emojiParaOpcion(emojiStr) {
  const match = CUSTOM_EMOJI_RESUELTO.exec(emojiStr);
  if (!match) return emojiStr;
  const [, animated, name, id] = match;
  return { id, name, animated: Boolean(animated) };
}

/**
 * "🔵 Maza Pesada ★★★★": emoji de categoría (texto, delante) + nombre del
 * arma + estrellas (si tiene historial). Recorta el nombre si hace falta
 * para que el conjunto nunca pase de 100 caracteres — el prefijo y las
 * estrellas nunca se recortan, solo el nombre libre.
 */
function labelDeOpcion(comp, rolKey, estrellas) {
  const rol = comp.roles[rolKey];
  const categoria = rol.categoria ? comp.categorias[rol.categoria] : null;
  const prefijo = categoria ? `${categoria.emoji} ` : '';
  const sufijo = estrellas > 0 ? ` ${'★'.repeat(estrellas)}` : '';

  const maxNombre = Math.max(0, OPTION_LABEL_MAX - prefijo.length - sufijo.length);
  const nombre = rol.nombre.length > maxNombre ? rol.nombre.slice(0, maxNombre) : rol.nombre;

  return `${prefijo}${nombre}${sufijo}`;
}

function buildOpcionDeRol({ comp, rolKey, estrellas, marcada }) {
  const rol = comp.roles[rolKey];
  const option = new StringSelectMenuOptionBuilder()
    .setValue(rolKey)
    .setLabel(labelDeOpcion(comp, rolKey, estrellas))
    .setEmoji(emojiParaOpcion(rol.emoji))
    .setDefault(Boolean(marcada));

  if (rol.nota) {
    option.setDescription(rol.nota.slice(0, OPTION_DESCRIPTION_MAX));
  }

  return option;
}

/**
 * Construye el mensaje efímero completo del panel de inscripción: el select
 * multi de roles, el select simple de preferido (mismo listado, ordenado
 * por categoría y luego nombre) y los botones Confirmar/Cancelar.
 * @param {object} params
 * @param {object} params.cta
 * @param {string} params.userId - para las estrellas: cada jugador ve las suyas
 * @param {Record<string, Record<string, number>>} params.maestria - lo que devuelve maestria.leerMaestria()
 * @param {string[]} [params.seleccionRoles]
 * @param {string | null} [params.seleccionPreferido]
 * @param {boolean} params.tentativo
 * @returns {{ content: string, components: import('discord.js').ActionRowBuilder[] }}
 */
export function buildPanelInscripcion({ cta, userId, maestria, seleccionRoles = [], seleccionPreferido = null, tentativo }) {
  const rolesOrdenados = ordenarRoles(cta.comp);

  const rolesSelect = new StringSelectMenuBuilder()
    .setCustomId(ctaButtonCustomId(cta.id, CTA_SELECT_ROLES))
    .setPlaceholder('Roles que puedes jugar')
    .setMinValues(1)
    .setMaxValues(rolesOrdenados.length)
    .addOptions(
      rolesOrdenados.map(([rolKey]) =>
        buildOpcionDeRol({
          comp: cta.comp,
          rolKey,
          estrellas: nivelEstrellas(maestria, userId, rolKey),
          marcada: seleccionRoles.includes(rolKey),
        }),
      ),
    );

  const preferidoSelect = new StringSelectMenuBuilder()
    .setCustomId(ctaButtonCustomId(cta.id, CTA_SELECT_PREFERIDO))
    .setPlaceholder('Rol preferido')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      rolesOrdenados.map(([rolKey]) =>
        buildOpcionDeRol({
          comp: cta.comp,
          rolKey,
          estrellas: nivelEstrellas(maestria, userId, rolKey),
          marcada: seleccionPreferido === rolKey,
        }),
      ),
    );

  const botones = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(ctaButtonCustomId(cta.id, CTA_BOTON_CONFIRMAR))
      .setLabel('Confirmar')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(ctaButtonCustomId(cta.id, CTA_BOTON_CANCELAR))
      .setLabel('Cancelar')
      .setStyle(ButtonStyle.Secondary),
  );

  const content = tentativo
    ? `Apuntándote como **tentativo** a **${cta.nombre}**. Elige qué puedes jugar y tu preferido, luego pulsa Confirmar.`
    : `Apuntándote a **${cta.nombre}**. Elige qué puedes jugar y tu preferido, luego pulsa Confirmar.`;

  return {
    content,
    components: [new ActionRowBuilder().addComponents(rolesSelect), new ActionRowBuilder().addComponents(preferidoSelect), botones],
  };
}

/**
 * Tercer select del modo "abierto": los slots libres compatibles con lo que
 * el jugador declaró, más una opción para quedarse sin asignar. Máximo 24 +
 * esa opción = 25, el límite de Discord.
 * @param {object} params
 * @param {object} params.cta
 * @param {Array<{ partyIdx: number, slotIdx: number, rolKey: string }>} params.slotsCompatibles
 * @returns {{ content: string, components: import('discord.js').ActionRowBuilder[] }}
 */
export function buildSelectorDeSlot({ cta, slotsCompatibles }) {
  const opciones = slotsCompatibles.slice(0, SLOT_OPTIONS_MAX).map(({ partyIdx, slotIdx, rolKey }) => {
    const rol = cta.comp.roles[rolKey];
    const party = cta.comp.parties[partyIdx];
    return new StringSelectMenuOptionBuilder()
      .setValue(`${partyIdx}:${slotIdx}`)
      .setLabel(`${party.nombre} — ${rol.nombre}`.slice(0, OPTION_LABEL_MAX))
      .setEmoji(emojiParaOpcion(rol.emoji));
  });

  opciones.push(new StringSelectMenuOptionBuilder().setValue(SLOT_SKIP_VALUE).setLabel('Quedarme sin asignar por ahora').setEmoji('🕒'));

  const select = new StringSelectMenuBuilder()
    .setCustomId(ctaButtonCustomId(cta.id, CTA_SELECT_SLOT))
    .setPlaceholder('Elige un slot')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(opciones);

  return { content: 'Elige en qué slot te apuntas:', components: [new ActionRowBuilder().addComponents(select)] };
}
