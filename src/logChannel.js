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
