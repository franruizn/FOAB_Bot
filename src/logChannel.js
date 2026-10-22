import { EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { getConfig, LANGUAGES } from './services/guildStore.js';
import { fieldLabel } from './services/configFields.js';
import { formatValue } from './ui/configEmbed.js';
import { t, tn, DEFAULT_LANGUAGE } from './i18n.js';

const MUTATION_COLOR = 0x5865f2;
const ERROR_COLOR = 0xed4245;

/**
 * Envía al canal de logs del servidor `guildId` (logChannelId de su
 * config.json). Sin servidor (un DM) o sin canal configurado, no hace nada.
 * El canal lo lee todo el servidor: `buildEmbed` recibe el idioma del
 * servidor, no el de quien provocó el aviso. `channelId` sustituye al
 * configurado (para /config reset logs, que avisa en el canal que deja de
 * serlo).
 * @param {import('discord.js').Client} client
 * @param {string | null} guildId
 * @param {(lang: string) => EmbedBuilder} buildEmbed
 * @param {AttachmentBuilder[]} [files]
 * @param {{ channelId?: string }} [options]
 */
async function sendToLogChannel(client, guildId, buildEmbed, files = [], { channelId: channelIdOverride } = {}) {
  if (!guildId) return;

  try {
    const { logChannelId, idioma } = await getConfig(guildId);
    const channelId = channelIdOverride ?? logChannelId;
    if (!channelId) return; // opcional: sin configurar, no hace nada

    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      console.error(`[logChannel] logChannelId (${channelId}) del servidor ${guildId} no resuelve a un canal de texto.`);
      return;
    }
    // Un id copiado de otro servidor mandaría los logs de este (textos de
    // /dm incluidos) a gente que no debe verlos: se exige que sea suyo.
    if (channel.guildId !== guildId) {
      console.error(`[logChannel] logChannelId (${channelId}) no pertenece al servidor ${guildId}: no se envía.`);
      return;
    }
    const lang = LANGUAGES.has(idioma) ? idioma : DEFAULT_LANGUAGE;
    await channel.send({ embeds: [buildEmbed(lang)], files });
  } catch (error) {
    // Nunca debe romper el flujo del comando que la disparó.
    console.error('[logChannel] No se pudo enviar al canal de logs:', error.stack ?? error);
  }
}

/**
 * Notifica en el canal de logs del servidor (si está configurado) que /squads modificó
 * squads.json: quién, qué subcomando, y un resumen de qué cambió.
 * @param {import('discord.js').Client} client
 * @param {{ guildId: string | null, actorTag: string, subcommand: string, summary: (lang: string) => string }} params
 *   summary: el resumen en el idioma que se le pida (el del servidor)
 */
export async function notifySquadMutation(client, { guildId, actorTag, subcommand, summary }) {
  await sendToLogChannel(client, guildId, (lang) =>
    new EmbedBuilder()
      .setColor(MUTATION_COLOR)
      .setTitle(t('squads.log.title', lang))
      .setDescription(summary(lang))
      .addFields(
        { name: t('log.field.officer', lang), value: actorTag, inline: true },
        { name: t('log.field.subcommand', lang), value: subcommand, inline: true },
      )
      .setTimestamp(new Date()),
  );
}

/**
 * Notifica en el canal de logs del servidor (si está configurado) que /config
 * cambió un campo de su config.json: quién, qué campo, y el antes y el
 * después.
 * @param {import('discord.js').Client} client
 * @param {{ guildId: string, actorTag: string, actorId: string, field: import('./services/configFields.js').ConfigField, before: string | null, after: string | null, logChannelId?: string }} params
 *   before/after: valores crudos del campo; logChannelId: canal al que enviarlo en vez del configurado
 */
export async function notifyConfigChange(client, { guildId, actorTag, actorId, field, before, after, logChannelId }) {
  await sendToLogChannel(
    client,
    guildId,
    (lang) =>
      new EmbedBuilder()
        .setColor(MUTATION_COLOR)
        .setTitle(t('config.log.title', lang))
        .addFields(
          { name: t('log.field.setting', lang), value: fieldLabel(field, lang), inline: true },
          { name: t('log.field.admin', lang), value: `${actorTag} (<@${actorId}>)`, inline: true },
          { name: t('log.field.before', lang), value: formatValue(field, before, lang), inline: false },
          { name: t('log.field.after', lang), value: formatValue(field, after, lang), inline: false },
        )
        .setTimestamp(new Date()),
    [],
    { channelId: logChannelId },
  );
}

/**
 * Notifica en el canal de logs del servidor (si está configurado) que /create-role creó un
 * rol nuevo y a quiénes se lo asignó (o falló al asignar).
 * @param {import('discord.js').Client} client
 * @param {{ guildId: string | null, actorTag: string, roleMention: string, assignedCount: number, totalResolved: number, unresolved: string[], failedMentions: string[] }} params
 */
export async function notifyRoleCreation(
  client,
  { guildId, actorTag, roleMention, assignedCount, totalResolved, unresolved, failedMentions },
) {
  await sendToLogChannel(client, guildId, (lang) => {
    const lines = [tn('createRole.result.assigned', totalResolved, lang, { assigned: assignedCount })];
    if (unresolved.length > 0) {
      lines.push(t('createRole.result.unresolved', lang, { list: unresolved.map((token) => `\`${token}\``).join(', ') }));
    }
    if (failedMentions.length > 0) {
      lines.push(t('createRole.result.failed', lang, { list: failedMentions.join(', ') }));
    }
    return new EmbedBuilder()
      .setColor(MUTATION_COLOR)
      .setTitle(t('log.roleCreated.title', lang))
      .setDescription(lines.join('\n'))
      .addFields(
        { name: t('log.field.officer', lang), value: actorTag, inline: true },
        { name: t('log.field.role', lang), value: roleMention, inline: true },
      )
      .setTimestamp(new Date());
  });
}

/**
 * Notifica en el canal de logs del servidor (si está configurado) que un comando falló con
 * un error no controlado (no un InvalidLinkError/AlbionApiError/etc. con
 * mensaje propio, sino algo inesperado que merece revisión).
 * @param {import('discord.js').Client} client
 * @param {{ guildId: string | null, commandName: string, actorTag: string, error: unknown }} params
 */
export async function notifyUncontrolledError(client, { guildId, commandName, actorTag, error }) {
  const message = error instanceof Error ? error.message : String(error);
  await sendToLogChannel(client, guildId, (lang) =>
    new EmbedBuilder()
      .setColor(ERROR_COLOR)
      .setTitle(t('log.error.title', lang))
      .addFields(
        { name: t('log.field.command', lang), value: `/${commandName}`, inline: true },
        { name: t('log.field.user', lang), value: actorTag, inline: true },
        { name: t('log.field.message', lang), value: `\`\`\`${message.slice(0, 500)}\`\`\`` },
      )
      .setTimestamp(new Date()),
  );
}

// Por encima de esto el texto de un /dm no cabe en la descripción de un
// embed (4096) junto con el resto: se adjunta como fichero.
const DM_LOG_TEXT_MAX_LENGTH = 4000;

/**
 * Notifica en el canal de logs del servidor (si está configurado) que alguien que NO es
 * DM_OWNER_ID intentó usar /dm.
 * @param {import('discord.js').Client} client
 * @param {{ guildId: string | null, actorTag: string, actorId: string }} params
 */
export async function notifyDmUnauthorized(client, { guildId, actorTag, actorId }) {
  await sendToLogChannel(client, guildId, (lang) =>
    new EmbedBuilder()
      .setColor(ERROR_COLOR)
      .setTitle(t('log.dmUnauthorized.title', lang))
      .setDescription(t('log.dmUnauthorized.body', lang, { user: actorId }))
      .addFields(
        { name: t('log.field.user', lang), value: actorTag, inline: true },
        { name: t('log.field.id', lang), value: actorId, inline: true },
      )
      .setTimestamp(new Date()),
  );
}

/**
 * Rastro de cada /dm, ANTES de empezar a enviar (para que quede aunque el
 * bot se caiga a mitad): quién, a cuántos, el texto completo tal y como lo
 * reciben y la hora (el timestamp del embed).
 * @param {import('discord.js').Client} client
 * @param {{ guildId: string | null, actorTag: string, actorId: string, total: number, content: string }} params
 */
export async function notifyDmStarted(client, { guildId, actorTag, actorId, total, content }) {
  const fitsInEmbed = content.length <= DM_LOG_TEXT_MAX_LENGTH;
  const files = fitsInEmbed
    ? []
    : [new AttachmentBuilder(Buffer.from(content, 'utf8'), { name: `dm-${Date.now()}.txt` })];
  await sendToLogChannel(
    client,
    guildId,
    (lang) =>
      new EmbedBuilder()
        .setColor(MUTATION_COLOR)
        .setTitle(t('log.dmStarted.title', lang))
        .setDescription(fitsInEmbed ? content : t('log.dmStarted.attached', lang))
        .addFields(
          { name: t('log.field.sender', lang), value: `${actorTag} (<@${actorId}>)`, inline: true },
          { name: t('log.field.recipients', lang), value: String(total), inline: true },
        )
        .setTimestamp(new Date()),
    files,
  );
}

/**
 * Resultado de un /dm ya terminado (el texto ya quedó en notifyDmStarted).
 * @param {import('discord.js').Client} client
 * @param {{ guildId: string | null, actorTag: string, summary: (lang: string) => string }} params
 */
export async function notifyDmFinished(client, { guildId, actorTag, summary }) {
  await sendToLogChannel(client, guildId, (lang) =>
    new EmbedBuilder()
      .setColor(MUTATION_COLOR)
      .setTitle(t('log.dmFinished.title', lang))
      .setDescription(summary(lang))
      .addFields({ name: t('log.field.sender', lang), value: actorTag, inline: true })
      .setTimestamp(new Date()),
  );
}

/**
 * Al arrancar: un /dm se quedó a medias (el bot se reinició durante el
 * envío). NO se reanuda — reenviar a quien ya lo recibió es peor que no
 * enviar —, solo se deja constancia de cuántos salieron para decidir a mano.
 * @param {import('discord.js').Client} client
 * @param {{ guildId: string | null, actorTag: string, startedAt: number, total: number, sentIds: string[] }} params
 */
export async function notifyDmInterrupted(client, { guildId, actorTag, startedAt, total, sentIds }) {
  const files =
    sentIds.length > 0
      ? [new AttachmentBuilder(Buffer.from(sentIds.join('\n'), 'utf8'), { name: `dm-enviados-${startedAt}.txt` })]
      : [];
  await sendToLogChannel(
    client,
    guildId,
    (lang) =>
      new EmbedBuilder()
        .setColor(ERROR_COLOR)
        .setTitle(t('log.dmInterrupted.title', lang))
        .setDescription(
          t('log.dmInterrupted.body', lang, {
            actor: actorTag,
            started: Math.floor(startedAt / 1000),
            sent: sentIds.length,
            total,
          }),
        )
        .setTimestamp(new Date()),
    files,
  );
}
