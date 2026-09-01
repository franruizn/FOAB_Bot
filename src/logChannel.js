import { EmbedBuilder } from 'discord.js';

const MUTATION_COLOR = 0x5865f2;
const ERROR_COLOR = 0xed4245;

async function sendToLogChannel(client, embed) {
  const channelId = process.env.LOG_CHANNEL_ID;
  if (!channelId) return; // opcional: sin configurar, no hace nada

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      console.error(`[logChannel] LOG_CHANNEL_ID (${channelId}) no resuelve a un canal de texto.`);
      return;
    }
    await channel.send({ embeds: [embed] });
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

/**
 * Notifica en LOG_CHANNEL_ID (si está configurado) que no se pudo asignar o
 * quitar el rol de una CTA a un usuario concreto (member.roles.add/remove
 * falló). Un evento por intento fallido, sin agrupar: a diferencia de la
 * hoja caída (un problema continuo), cada fallo aquí es sobre una persona
 * distinta y merece su propia línea.
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
        'actualizado (no se deshizo la inscripción). Revísalo a mano o corre `/cta sync` para reintentarlo.',
    )
    .addFields({ name: 'Error', value: `\`\`\`${message.slice(0, 500)}\`\`\`` })
    .setTimestamp(new Date());

  await sendToLogChannel(client, embed);
}

/**
 * Notifica en LOG_CHANNEL_ID (si está configurado) que el servidor se está
 * acercando al límite de 250 roles de Discord (aviso a partir de 200), tras
 * crear el rol de una CTA nueva.
 * @param {import('discord.js').Client} client
 * @param {{ ctaId: string, message: string }} params
 */
export async function notifyCtaRoleCapacityWarning(client, { ctaId, message }) {
  const embed = new EmbedBuilder()
    .setColor(MUTATION_COLOR)
    .setTitle('⚠️ Aviso de capacidad de roles')
    .setDescription(`CTA \`${ctaId}\`: ${message}`)
    .setTimestamp(new Date());

  await sendToLogChannel(client, embed);
}

/**
 * Notifica en LOG_CHANNEL_ID (si está configurado) que un oficial cambió en
 * caliente la hoja o la pestaña que usa /cta (sin tocar .env ni reiniciar) —
 * afecta a todas las CTA futuras hasta que se vuelva a cambiar.
 * @param {import('discord.js').Client} client
 * @param {{ actorTag: string, campo: 'hoja' | 'pestaña', valor: string }} params
 */
export async function notifyCtaSheetConfigChange(client, { actorTag, campo, valor }) {
  const embed = new EmbedBuilder()
    .setColor(MUTATION_COLOR)
    .setTitle('📝 /cta cambió la configuración de la hoja')
    .setDescription(`**${actorTag}** cambió la **${campo}** que usa /cta a: \`${valor}\``)
    .setTimestamp(new Date());

  await sendToLogChannel(client, embed);
}

/**
 * Notifica en LOG_CHANNEL_ID (si está configurado) que una CTA agotó los
 * reintentos al sincronizar el bloque con Google Sheets. Se llama solo en la
 * TRANSICIÓN a desincronizada (ver ctaSheetSync.js), no en cada intento
 * fallido de una caída prolongada.
 * @param {import('discord.js').Client} client
 * @param {{ ctaId: string, channelId: string, error: unknown }} params
 */
export async function notifyCtaDesync(client, { ctaId, channelId, error }) {
  const message = error instanceof Error ? error.message : String(error);
  const embed = new EmbedBuilder()
    .setColor(ERROR_COLOR)
    .setTitle('⚠️ CTA desincronizada de la hoja')
    .setDescription(
      `La CTA en <#${channelId}> (\`${ctaId}\`) no pudo sincronizar el bloque con Google Sheets tras agotar ` +
        'los reintentos. El JSON local sigue siendo la fuente de verdad — nadie perdió su inscripción — pero la ' +
        'hoja va desactualizada hasta la próxima alta/baja con éxito, o hasta correr `/cta sync`.',
    )
    .addFields({ name: 'Error', value: `\`\`\`${message.slice(0, 500)}\`\`\`` })
    .setTimestamp(new Date());

  await sendToLogChannel(client, embed);
}
