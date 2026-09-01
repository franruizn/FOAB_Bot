import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
} from 'discord.js';

const OPEN_COLOR = 0x00ff9d;
const CLOSED_COLOR = 0x99aab5;
export const ROLE_INPUT_MAX_LENGTH = 40;
const DESCRIPTION_MAX = 4096;

/**
 * URL pública de la hoja de CTA, o null si CTA_SHEET_ID no está configurado
 * (el embed simplemente omite el enlace en vez de romperse).
 * @returns {string | null}
 */
export function buildCtaSheetUrl() {
  const sheetId = process.env.CTA_SHEET_ID;
  return sheetId ? `https://docs.google.com/spreadsheets/d/${sheetId}/edit` : null;
}

function sheetLinkLine(sheetUrl) {
  return sheetUrl ? `\n\n[Ver la hoja](${sheetUrl})` : '';
}

function footerText(inscritosCount, sincronizada) {
  return sincronizada ? `Inscritos: ${inscritosCount}` : `Inscritos: ${inscritosCount} · ⚠️ Desincronizada de la hoja`;
}

/**
 * Embed del mensaje publicado mientras la CTA está abierta. Nunca lista
 * inscritos (eso vive en la hoja, de solo lectura para el gremio) — el
 * footer con el número es la única señal de que el mensaje "está vivo", y
 * también donde se avisa si la hoja lleva un rato sin poder sincronizarse.
 * @param {{ title: string, cierraEnUnixSeconds: number, inscritosCount: number, sheetUrl: string | null, sincronizada?: boolean }} params
 * @returns {EmbedBuilder}
 */
export function buildCtaEmbed({ title, cierraEnUnixSeconds, inscritosCount, sheetUrl, sincronizada = true }) {
  const description =
    `Apuntaros a la CTA. Mínimo 3 roles distintos.\n\n` +
    `Cierra <t:${cierraEnUnixSeconds}:R>.` +
    sheetLinkLine(sheetUrl);

  return new EmbedBuilder()
    .setColor(OPEN_COLOR)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: footerText(inscritosCount, sincronizada) });
}

/**
 * Misma tarjeta, pero marcada como cerrada (se usa para reeditar el mensaje
 * original al vencer el plazo, junto con botones deshabilitados).
 * @param {{ title: string, inscritosCount: number, sheetUrl: string | null, sincronizada?: boolean }} params
 * @returns {EmbedBuilder}
 */
export function buildCtaClosedEmbed({ title, inscritosCount, sheetUrl, sincronizada = true }) {
  const description = `La CTA ha cerrado. Ya no se pueden registrar más inscripciones.${sheetLinkLine(sheetUrl)}`;

  return new EmbedBuilder()
    .setColor(CLOSED_COLOR)
    .setTitle(`${title} (cerrada)`)
    .setDescription(description)
    .setFooter({ text: footerText(inscritosCount, sincronizada) });
}

/**
 * Fila con los dos botones persistentes. El id de la CTA va en el customId
 * porque los componentes no pueden variar por usuario: cualquiera que los
 * pulse dispara el mismo customId, y el handler decide qué hacer según quién
 * es `interaction.user`.
 * @param {string} ctaId
 * @param {{ disabled?: boolean }} [options]
 * @returns {ActionRowBuilder}
 */
export function buildCtaButtons(ctaId, { disabled = false } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`cta-apuntar-${ctaId}`)
      .setLabel('Apuntarse')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`cta-desapuntar-${ctaId}`)
      .setLabel('Desapuntarse')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}

/**
 * Modal con los 3 roles. Los TextInput se dejan siempre vacíos (nunca
 * pre-rellenados con los roles actuales): mostrar el modal es la primera
 * respuesta a la interacción del botón y no hay tiempo de ir a leer el
 * estado actual antes — ese aviso ("ya estabas apuntado con...") se manda
 * aparte, como followUp.
 * @param {string} ctaId
 * @returns {ModalBuilder}
 */
export function buildCtaModal(ctaId) {
  const rows = ['rol1', 'rol2', 'rol3'].map((customId, index) =>
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(customId)
        .setLabel(`Rol ${index + 1}`)
        .setStyle(TextInputStyle.Short)
        .setMaxLength(ROLE_INPUT_MAX_LENGTH)
        .setRequired(true),
    ),
  );

  return new ModalBuilder().setCustomId(`cta-modal-${ctaId}`).setTitle('Apuntarse a la CTA').addComponents(...rows);
}

/**
 * Recorta `lines` (unidas por '\n') al último elemento que quepa entero
 * dentro de `maxLength`, avisando cuántas quedaron fuera. Mismo patrón que
 * ui/killsEmbed.js: nunca corta una línea a la mitad.
 */
export function truncateLines(lines, maxLength) {
  const joined = lines.join('\n');
  if (joined.length <= maxLength) return joined;

  const kept = [];
  let acc = '';
  for (const line of lines) {
    const candidate = acc ? `${acc}\n${line}` : line;
    const remainingAfter = lines.length - (kept.length + 1);
    const suffix = remainingAfter > 0 ? `\n… +${remainingAfter} más — la lista completa está en la hoja.` : '';
    if ((candidate + suffix).length > maxLength) break;
    acc = candidate;
    kept.push(line);
  }

  const remaining = lines.length - kept.length;
  if (remaining === 0) return acc;
  return `${acc ? `${acc}\n` : ''}… +${remaining} más — la lista completa está en la hoja.`;
}

/**
 * Embed de la lista final, publicado como mensaje nuevo al cerrar la CTA (a
 * diferencia del embed en vivo, este SÍ lista a los inscritos con sus
 * roles). `inscritos` debe venir ya en el orden de la CTA (por ts).
 * @param {{ title: string, inscritos: Array<{ nombre: string, roles: string[] }>, sheetUrl: string | null }} params
 * @returns {EmbedBuilder}
 */
export function buildCtaFinalListEmbed({ title, inscritos, sheetUrl }) {
  const link = sheetLinkLine(sheetUrl);
  const embedTitle = `Lista final — ${title}`;

  if (inscritos.length === 0) {
    return new EmbedBuilder().setColor(CLOSED_COLOR).setTitle(embedTitle).setDescription(`Nadie se apuntó.${link}`);
  }

  const lines = inscritos.map(
    (inscrito, index) =>
      `**${index + 1}.** ${escapeMarkdown(inscrito.nombre)} — ${inscrito.roles.map((rol) => escapeMarkdown(rol)).join(', ')}`,
  );
  const budget = Math.max(0, DESCRIPTION_MAX - link.length);

  return new EmbedBuilder()
    .setColor(CLOSED_COLOR)
    .setTitle(embedTitle)
    .setDescription(`${truncateLines(lines, budget)}${link}`)
    .setFooter({ text: `${inscritos.length} inscrito(s)` });
}

/**
 * Embed de /cta roles: lista los roles de CTA del servidor, del más antiguo
 * al más reciente, con su fecha de creación y número de miembros. Es solo
 * informativo — no borra nada.
 * @param {{ roles: Array<{ name: string, createdTimestamp: number, memberCount: number }> }} params
 * @returns {EmbedBuilder}
 */
export function buildCtaRolesListEmbed({ roles }) {
  if (roles.length === 0) {
    return new EmbedBuilder().setColor(CLOSED_COLOR).setTitle('Roles de CTA').setDescription('No hay roles de CTA en este servidor.');
  }

  const lines = roles.map((role) => {
    const createdAtSeconds = Math.floor(role.createdTimestamp / 1000);
    return `• **${escapeMarkdown(role.name)}** — creado <t:${createdAtSeconds}:f>, ${role.memberCount} miembro(s)`;
  });

  return new EmbedBuilder()
    .setColor(CLOSED_COLOR)
    .setTitle('Roles de CTA')
    .setDescription(truncateLines(lines, DESCRIPTION_MAX))
    .setFooter({ text: `${roles.length} rol(es) — del más antiguo al más reciente` });
}
