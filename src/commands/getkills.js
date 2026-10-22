import { SlashCommandBuilder } from 'discord.js';
import { parseAlbionbbUrl } from '../services/albionbb.js';
import { getBattle, getBattleEvents } from '../services/albionApi.js';
import { loadConfig } from '../services/config.js';
import { requireConfig } from '../services/configFields.js';
import { aggregateBattle } from '../services/aggregate.js';
import { buildKillsEmbed } from '../ui/killsEmbed.js';
import { guildLang, localizedName, localizedDescription } from '../i18n.js';

export const data = localizedDescription(localizedName(new SlashCommandBuilder(), 'cmd.getkills.name'), 'cmd.getkills.description')
  .addStringOption((option) =>
    localizedDescription(localizedName(option, 'cmd.getkills.opt.url.name'), 'cmd.getkills.opt.url.description').setRequired(true),
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
  const { albionGuild: mainGuild } = await requireConfig(interaction.guildId, 'albionGuild');

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

  // Respuesta pública: la lee el canal, va en el idioma del servidor.
  const embeds = buildKillsEmbed({
    lang: await guildLang(interaction.guildId),
    result,
    battlesProcessed: processed,
    battlesRequested: battleIds.length,
    mainGuildDisplay: mainGuild,
    hasSquads: config.squadOrder.length > 0,
    originalUrl: url,
    battleDate: resolveBattleDate(events),
  });

  await interaction.editReply({ embeds });
}
