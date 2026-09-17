import { EmbedBuilder, escapeMarkdown } from 'discord.js';

const EMBED_COLOR = 0x00ff9d;
const NOT_FOUND_COLOR = 0xf59e0b;

const CUSTOM_EMOJI_ID = /^<a?:[a-zA-Z0-9_]{2,32}:(\d{15,21})>$/;

/**
 * Un custom emoji cuyo id ya no existe en la caché del servidor: el emoji se
 * borró después de guardarse. Un emoji unicode nunca puede "romperse".
 */
function emojiRoto(guild, emojiStr) {
  const match = CUSTOM_EMOJI_ID.exec(emojiStr ?? '');
  if (!match) return false;
  return !guild?.emojis?.cache?.has?.(match[1]);
}

function marcaSiRoto(guild, emojiStr) {
  return emojiRoto(guild, emojiStr) ? ' ⚠️' : '';
}

/**
 * Embed genérico para confirmaciones de mutación (crear/borrar/mover...),
 * igual patrón que ui/squadsEmbed.js.
 */
export function mutationEmbed({ title, description, actorTag }) {
  const embed = new EmbedBuilder().setColor(EMBED_COLOR).setTitle(title).setDescription(description);
  if (actorTag) embed.setFooter({ text: `Por ${actorTag}` });
  return embed;
}

export function infoEmbed({ title, description }) {
  return new EmbedBuilder().setColor(EMBED_COLOR).setTitle(title).setDescription(description);
}

/**
 * "Composición no encontrada", con sugerencias por Levenshtein igual que
 * /attendance y /score.
 */
export function buildCompNotFoundEmbed({ compInput, suggestions }) {
  const base = `No encontré ninguna composición llamada **${escapeMarkdown(compInput)}**.`;
  const description =
    suggestions.length > 0
      ? `${base}\n\n¿Quisiste decir…?\n${suggestions.map((s) => `• ${escapeMarkdown(s)}`).join('\n')}`
      : `${base}\n\nCréala con \`/comp crear\`.`;
  return new EmbedBuilder().setColor(NOT_FOUND_COLOR).setTitle('Composición no encontrada').setDescription(description);
}

/**
 * Resumen de "/comp rol crear": cada rol con su emoji y su categoría, tal
 * como se verá en el embed real — la única forma de detectar un
 * emparejamiento nombre/emoji cruzado antes de publicar una CTA.
 */
export function buildRolesCreadosEmbed({ compNombre, categoria, creados }) {
  const lineas = creados.map((r) => `${r.emoji} **${escapeMarkdown(r.nombre)}** (\`${r.key}\`)`).join('\n');
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`Roles creados en "${compNombre}"`)
    .setDescription(`Categoría: ${categoria.emoji} **${escapeMarkdown(categoria.nombre)}**\n\n${lineas}`)
    .setFooter({ text: `${creados.length} rol(es) creado(s)` });
}

/**
 * Previsualización de la plantilla tal como se verá en la CTA, con las
 * parties vacías. Marca con ⚠️ cualquier emoji custom cuyo id ya no exista
 * en el servidor (se borró después de guardarse).
 */
export function buildCompVerEmbed({ compKey, comp, guild }) {
  const categorias = Object.entries(comp.categorias).sort((a, b) => a[1].orden - b[1].orden);

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(comp.nombre)
    .setFooter({
      text: `${compKey} · ${Object.keys(comp.roles).length} rol(es) · ${comp.parties.length} part(y/ies)`,
    });

  if (categorias.length > 0) {
    embed.setDescription(
      categorias.map(([, cat]) => `${cat.emoji}${marcaSiRoto(guild, cat.emoji)} ${escapeMarkdown(cat.nombre)}`).join('  ·  '),
    );
  }

  if (comp.parties.length === 0) {
    embed.addFields({ name: 'Parties', value: 'Todavía no tiene ninguna. Usa `/comp party add`.', inline: false });
  } else {
    for (const party of comp.parties) {
      const valor =
        party.slots.length === 0
          ? '—'
          : party.slots
              .map((rolKey, i) => {
                const rol = comp.roles[rolKey];
                return `${i + 1}. ${rol.emoji}${marcaSiRoto(guild, rol.emoji)} ${escapeMarkdown(rol.nombre)}`;
              })
              .join('\n');
      embed.addFields({ name: party.nombre, value: valor, inline: true });
    }
  }

  const sinCategoria = Object.entries(comp.roles).filter(([, r]) => !r.categoria);
  if (sinCategoria.length > 0) {
    embed.addFields({
      name: 'Roles sin categoría',
      value: sinCategoria.map(([, r]) => `${r.emoji}${marcaSiRoto(guild, r.emoji)} ${escapeMarkdown(r.nombre)}`).join(', '),
      inline: false,
    });
  }

  return embed;
}

/**
 * @param {Array<{ key: string, nombre: string, numRoles: number, numCategorias: number, numParties: number }>} comps
 */
export function buildCompListaEmbed(comps) {
  const description =
    comps.length === 0
      ? 'Todavía no hay ninguna composición. Créala con `/comp crear`.'
      : comps
          .map(
            (c) =>
              `**${escapeMarkdown(c.nombre)}** (\`${c.key}\`) — ${c.numRoles} rol(es), ${c.numCategorias} categoría(s), ${c.numParties} part(y/ies)`,
          )
          .join('\n');

  return new EmbedBuilder().setColor(EMBED_COLOR).setTitle('Composiciones').setDescription(description);
}
