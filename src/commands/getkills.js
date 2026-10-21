import { SlashCommandBuilder } from 'discord.js';
import { parseAlbionbbUrl } from '../services/albionbb.js';
import { getBattle, getBattleEvents } from '../services/albionApi.js';
import { loadConfig, ConfigError } from '../services/config.js';
import { getConfig, rutaDe } from '../services/guildStore.js';
import { aggregateBattle } from '../services/aggregate.js';
import { buildKillsEmbed } from '../ui/killsEmbed.js';

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
  // loadConfig primero: si squads.json venía en el formato viejo, su
  // conversión puede fijar albionGuild.
  const config = await loadConfig(interaction.guildId);
  const { albionGuild: mainGuild } = await getConfig(interaction.guildId);
  if (!mainGuild) {
    throw new ConfigError('Este servidor no tiene gremio principal (albionGuild) en su config.json.', {
      path: rutaDe(interaction.guildId, 'config.json'),
      reason: 'missing_main_guild',
    });
  }

  const events = [];
  const battles = [];
  let processed = 0;

  for (const battleId of battleIds) {
    try {
      // El resumen da la presencia (incluye a quien no mató ni murió) y los
      // eventos dan las kills/deaths. Si falla cualquiera de los dos la
      // batalla entera cuenta como no procesada: con solo eventos la presencia
      // quedaría infracontada sin avisar.
      const [battle, battleEvents] = await Promise.all([
        getBattle(server, battleId),
        getBattleEvents(server, battleId),
      ]);
      battles.push(battle);
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

  const result = aggregateBattle({ events, battles, config, mainGuild });
  for (const warning of result.warnings) console.warn(`[getkills] ${warning}`);

  const embeds = buildKillsEmbed({
    result,
    battlesProcessed: processed,
    battlesRequested: battleIds.length,
    mainGuildDisplay: mainGuild,
    originalUrl: url,
    battleDate: resolveBattleDate(events),
  });

  await interaction.editReply({ embeds });
}
