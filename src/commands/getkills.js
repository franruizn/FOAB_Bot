import { SlashCommandBuilder } from 'discord.js';
import { parseAlbionbbUrl } from '../services/albionbb.js';
import { getBattleEvents } from '../services/albionApi.js';
import { loadConfig } from '../services/config.js';
import { aggregateBattle } from '../services/aggregate.js';
import { buildKillsEmbed } from '../ui/killsEmbed.js';
import { SQUADS_CONFIG_PATH } from '../dataPaths.js';

export const data = new SlashCommandBuilder()
  .setName('getkills')
  .setDescription('Muestra las kills y muertes del gremio y de cada squad en una batalla')
  .addStringOption((option) =>
    option
      .setName('url')
      .setDescription('Enlace de albionbb a la batalla, ej. https://europe.albionbb.com/battles/418186013')
      .setRequired(true),
  );

/**
 * Fecha a mostrar en el embed: la del evento más antiguo (inicio aproximado
 * de la batalla). Si no hay eventos, se usa la hora actual como fallback.
 */
function resolveBattleDate(events) {
  const earliest = events.reduce((acc, event) => {
    const eventDate = new Date(event.TimeStamp);
    return acc === null || eventDate < acc ? eventDate : acc;
  }, null);
  return earliest ?? new Date();
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  await interaction.deferReply();

  // Sin try/catch propio a propósito: cualquier error (parseAlbionbbUrl,
  // loadConfig, o "todas las batallas fallaron" más abajo) burbujea hasta el
  // handler centralizado de src/interactionErrorHandler.js, que ya sabe usar
  // editReply porque deferReply() se llamó arriba.
  const url = interaction.options.getString('url', true);
  const { server, battleIds } = parseAlbionbbUrl(url);
  const config = await loadConfig(SQUADS_CONFIG_PATH);

  const events = [];
  let processed = 0;

  for (const battleId of battleIds) {
    try {
      const battleEvents = await getBattleEvents(server, battleId);
      events.push(...battleEvents);
      processed += 1;
    } catch (error) {
      // Una batalla fallida (ej. 404) no debe abortar las demás: se reporta
      // como "procesadas/solicitadas" en el embed.
      console.error(`No se pudo obtener la batalla ${battleId} (${server}):`, error);
    }
  }

  if (processed === 0) {
    throw new Error(`No se pudo obtener información de ninguna de las ${battleIds.length} batalla(s) solicitada(s).`);
  }

  const result = aggregateBattle({ events, config });
  const guildsDisplay = [...config.guilds].join(' / ');

  const embeds = buildKillsEmbed({
    result,
    battlesProcessed: processed,
    battlesRequested: battleIds.length,
    guildsDisplay,
    originalUrl: url,
    battleDate: resolveBattleDate(events),
  });

  await interaction.editReply({ embeds });
}
