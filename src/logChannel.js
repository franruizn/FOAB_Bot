import { EmbedBuilder, AttachmentBuilder } from 'discord.js';

const MUTATION_COLOR = 0x5865f2;
const ERROR_COLOR = 0xed4245;

async function sendToLogChannel(client, embed, files = []) {
  const channelId = process.env.LOG_CHANNEL_ID;
  if (!channelId) return; // opcional: sin configurar, no hace nada

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      console.error(`[logChannel] LOG_CHANNEL_ID (${channelId}) no resuelve a un canal de texto.`);
      return;
    }
    await channel.send({ embeds: [embed], files });
  } catch (error) {
    // Nunca debe romper el flujo del comando que la disparó.
    console.error('[logChannel] No se pudo enviar al canal de logs:', error.stack ?? error);
  }
}

/**
 * Notifica en LOG_CHANNEL_ID (si está configurado) que /squads modificó
 * squads.json: quién, qué subcomando, y un resumen de qué cambió.
 * @param {import('discord.js').Client} client
 * @param {{ actorTag: string, subcommand: string, summary: string }} params
 */
export async function notifySquadMutation(client, { actorTag, subcommand, summary }) {
  const embed = new EmbedBuilder()
    .setColor(MUTATION_COLOR)
    .setTitle('📝 /squads modificó squads.json')
    .setDescription(summary)
    .addFields(
      { name: 'Oficial', value: actorTag, inline: true },
      { name: 'Subcomando', value: subcommand, inline: true },
    )
    .setTimestamp(new Date());

  await sendToLogChannel(client, embed);
}

/**
 * Notifica en LOG_CHANNEL_ID (si está configurado) que no se pudo asignar o
 * quitar el rol de una CTA a un usuario concreto (member.roles.add/remove
 * falló). No hace fallar la inscripción/salida: el estado local ya se
 * escribió, esto es solo el aviso para que un oficial lo revise.
 * @param {import('discord.js').Client} client
 * @param {{ ctaId: string, userId: string, action: 'asignar' | 'quitar', error: unknown }} params
 */
export async function notifyCtaRoleFailure(client, { ctaId, userId, action, error }) {
  const message = error instanceof Error ? error.message : String(error);
  const embed = new EmbedBuilder()
    .setColor(ERROR_COLOR)
    .setTitle('⚠️ Fallo al gestionar el rol de una CTA')
    .setDescription(
      `No se pudo **${action}** el rol de la CTA \`${ctaId}\` a <@${userId}>. El JSON local ya quedó ` +
        'actualizado (la inscripción/salida no se deshizo). Revísalo a mano si hace falta.',
    )
    .addFields({ name: 'Error', value: `\`\`\`${message.slice(0, 500)}\`\`\`` })
    .setTimestamp(new Date());

  await sendToLogChannel(client, embed);
}

/**
 * Notifica en LOG_CHANNEL_ID (si está configurado) que el volcado a Google
 * Sheets del cierre de una CTA falló (la hoja se escribe una única vez, al
 * cerrar — ver ctaCierre.js). Se llama solo ahí, no en cada reintento
 * fallido posterior de /cta sync — para no inundar el canal de logs con el
 * mismo aviso.
 * @param {import('discord.js').Client} client
 * @param {{ ctaId: string, ctaNombre: string, error: unknown }} params
 */
export async function notifyCtaSheetDesync(client, { ctaId, ctaNombre, error }) {
  const message = error instanceof Error ? error.message : String(error);
  const embed = new EmbedBuilder()
    .setColor(ERROR_COLOR)
    .setTitle('📄 Volcado a Google Sheets pendiente')
    .setDescription(
      `El cierre de la CTA **${ctaNombre}** (\`${ctaId}\`) no se pudo volcar a Google Sheets. ` +
        'Usa `/cta sync` en su canal para reintentarlo.',
    )
    .addFields({ name: 'Error', value: `\`\`\`${message.slice(0, 500)}\`\`\`` })
    .setTimestamp(new Date());

  await sendToLogChannel(client, embed);
}

/**
 * Notifica en LOG_CHANNEL_ID (si está configurado) que /crear-rol creó un
 * rol nuevo y a quiénes se lo asignó (o falló al asignar).
 * @param {import('discord.js').Client} client
 * @param {{ actorTag: string, roleMention: string, assignedCount: number, totalResolved: number, unresolved: string[], failedMentions: string[] }} params
 */
export async function notifyRoleCreation(
  client,
  { actorTag, roleMention, assignedCount, totalResolved, unresolved, failedMentions },
) {
  const lines = [`Asignado a **${assignedCount}** de ${totalResolved} persona(s) resuelta(s).`];
  if (unresolved.length > 0) {
    lines.push(`No resueltos: ${unresolved.map((token) => `\`${token}\``).join(', ')}`);
  }
  if (failedMentions.length > 0) {
    lines.push(`Fallo al asignar: ${failedMentions.join(', ')}`);
  }

  const embed = new EmbedBuilder()
    .setColor(MUTATION_COLOR)
    .setTitle('🆕 /crear-rol creó un rol')
    .setDescription(lines.join('\n'))
    .addFields(
      { name: 'Oficial', value: actorTag, inline: true },
      { name: 'Rol', value: roleMention, inline: true },
    )
    .setTimestamp(new Date());

  await sendToLogChannel(client, embed);
}

/**
 * Notifica en LOG_CHANNEL_ID (si está configurado) que un comando falló con
 * un error no controlado (no un InvalidLinkError/AlbionApiError/etc. con
 * mensaje propio, sino algo inesperado que merece revisión).
 * @param {import('discord.js').Client} client
 * @param {{ commandName: string, actorTag: string, error: unknown }} params
 */
export async function notifyUncontrolledError(client, { commandName, actorTag, error }) {
  const message = error instanceof Error ? error.message : String(error);
  const embed = new EmbedBuilder()
    .setColor(ERROR_COLOR)
    .setTitle('💥 Error no controlado')
    .addFields(
      { name: 'Comando', value: `/${commandName}`, inline: true },
      { name: 'Usuario', value: actorTag, inline: true },
      { name: 'Mensaje', value: `\`\`\`${message.slice(0, 500)}\`\`\`` },
    )
    .setTimestamp(new Date());

  await sendToLogChannel(client, embed);
}

// Por encima de esto el texto de un /dm no cabe en la descripción de un
// embed (4096) junto con el resto: se adjunta como fichero.
const DM_LOG_TEXT_MAX_LENGTH = 4000;

/**
 * Notifica en LOG_CHANNEL_ID (si está configurado) que alguien que NO es
 * DM_OWNER_ID intentó usar /dm.
 * @param {import('discord.js').Client} client
 * @param {{ actorTag: string, actorId: string }} params
 */
export async function notifyDmUnauthorized(client, { actorTag, actorId }) {
  const embed = new EmbedBuilder()
    .setColor(ERROR_COLOR)
    .setTitle('🚫 Intento de /dm sin permiso')
    .setDescription(`<@${actorId}> intentó usar /dm y no es DM_OWNER_ID. No se envió nada.`)
    .addFields(
      { name: 'Usuario', value: actorTag, inline: true },
      { name: 'ID', value: actorId, inline: true },
    )
    .setTimestamp(new Date());

  await sendToLogChannel(client, embed);
}

/**
 * Rastro de cada /dm, ANTES de empezar a enviar (para que quede aunque el
 * bot se caiga a mitad): quién, a cuántos, el texto completo tal y como lo
 * reciben (cabecera incluida) y la hora (el timestamp del embed).
 * @param {import('discord.js').Client} client
 * @param {{ actorTag: string, actorId: string, total: number, content: string }} params
 */
export async function notifyDmStarted(client, { actorTag, actorId, total, content }) {
  const fitsInEmbed = content.length <= DM_LOG_TEXT_MAX_LENGTH;
  const embed = new EmbedBuilder()
    .setColor(MUTATION_COLOR)
    .setTitle('📨 /dm: envío iniciado')
    .setDescription(fitsInEmbed ? content : 'El texto no cabe en un embed: va adjunto como fichero.')
    .addFields(
      { name: 'Remitente', value: `${actorTag} (<@${actorId}>)`, inline: true },
      { name: 'Destinatarios', value: String(total), inline: true },
    )
    .setTimestamp(new Date());

  const files = fitsInEmbed
    ? []
    : [new AttachmentBuilder(Buffer.from(content, 'utf8'), { name: `dm-${Date.now()}.txt` })];
  await sendToLogChannel(client, embed, files);
}

/**
 * Resultado de un /dm ya terminado (el texto ya quedó en notifyDmStarted).
 * @param {import('discord.js').Client} client
 * @param {{ actorTag: string, summary: string }} params
 */
export async function notifyDmFinished(client, { actorTag, summary }) {
  const embed = new EmbedBuilder()
    .setColor(MUTATION_COLOR)
    .setTitle('📨 /dm: envío terminado')
    .setDescription(summary)
    .addFields({ name: 'Remitente', value: actorTag, inline: true })
    .setTimestamp(new Date());

  await sendToLogChannel(client, embed);
}

/**
 * Al arrancar: un /dm se quedó a medias (el bot se reinició durante el
 * envío). NO se reanuda — reenviar a quien ya lo recibió es peor que no
 * enviar —, solo se deja constancia de cuántos salieron para decidir a mano.
 * @param {import('discord.js').Client} client
 * @param {{ actorTag: string, startedAt: number, total: number, sentIds: string[] }} params
 */
export async function notifyDmInterrupted(client, { actorTag, startedAt, total, sentIds }) {
  const embed = new EmbedBuilder()
    .setColor(ERROR_COLOR)
    .setTitle('⚠️ /dm interrumpido por un reinicio')
    .setDescription(
      `Un /dm de **${actorTag}** iniciado <t:${Math.floor(startedAt / 1000)}:f> se cortó a mitad: ` +
        `se habían enviado **${sentIds.length}** de ${total}. **No se ha reanudado.** ` +
        'Decide a mano si hace falta mandarlo al resto.',
    )
    .setTimestamp(new Date());

  const files =
    sentIds.length > 0
      ? [new AttachmentBuilder(Buffer.from(sentIds.join('\n'), 'utf8'), { name: `dm-enviados-${startedAt}.txt` })]
      : [];
  await sendToLogChannel(client, embed, files);
}
