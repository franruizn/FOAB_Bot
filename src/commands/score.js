import { SlashCommandBuilder } from 'discord.js';
import { parseAlbionbbUrl } from '../services/albionbb.js';
import { getBattleEvents } from '../services/albionApi.js';
import { loadConfig } from '../services/config.js';
import { computeSquadScore } from '../services/score.js';
import { resolveBattleDate } from '../services/battleDate.js';
import { suggestClosestNames } from '../services/levenshtein.js';
import { buildScoreEmbed, buildEmptySquadScoreEmbed, buildSquadNotFoundEmbed } from '../ui/scoreEmbed.js';
import { SQUADS_CONFIG_PATH } from '../dataPaths.js';

const AUTOCOMPLETE_LIMIT = 25;
const MAIN_ZERG_DISPLAY = 'MAIN ZERG';

export const data = new SlashCommandBuilder()
  .setName('score')
  .setDescription('Calcula el score (kills/muertes/KDA) de un squad en una batalla')
  .addStringOption((option) =>
    option.setName('squad').setDescription('Squad (o MAIN ZERG)').setRequired(true).setAutocomplete(true),
  )
  .addStringOption((option) =>
    option
      .setName('url')
      .setDescription('Enlace de albionbb a la batalla, ej. https://europe.albionbb.com/battles/418186013')
      .setRequired(true),
  );

/**
 * Resuelve el input de "squad" contra squads.json + MAIN ZERG. Comparación
 * case-insensitive por igualdad exacta (nunca includes()): la clave interna
 * de cada squad ya es su display en minúsculas (ver config.js), así que
 * basta con una búsqueda en config.squads.
 * @returns {{ key: string, display: string } | null}
 */
function resolveSquadTarget(input, config) {
  const normalized = input.trim().toLowerCase();
  if (normalized === 'main' || normalized === MAIN_ZERG_DISPLAY.toLowerCase()) {
    return { key: 'main', display: MAIN_ZERG_DISPLAY };
  }
  const squad = config.squads.get(normalized);
  return squad ? { key: normalized, display: squad.display } : null;
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  await interaction.deferReply();

  // Sin try/catch propio a propósito, igual que /getkills: InvalidLinkError,
  // AlbionApiError y ConfigError burbujean hasta el handler centralizado de
  // src/interactionErrorHandler.js.
  const squadInput = interaction.options.getString('squad', true).trim();
  const url = interaction.options.getString('url', true);
  const { server, battleIds } = parseAlbionbbUrl(url);
  const config = await loadConfig(SQUADS_CONFIG_PATH);

  const target = resolveSquadTarget(squadInput, config);
  if (!target) {
    const candidates = [MAIN_ZERG_DISPLAY, ...config.squadOrder.map((key) => config.squads.get(key).display)];
    const suggestions = suggestClosestNames(squadInput, candidates);
    await interaction.editReply({ embeds: [buildSquadNotFoundEmbed({ squadInput, suggestions })] });
    return;
  }

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

  const score = computeSquadScore({ events, config, squadKey: target.key });
  const battlesProcessed = processed;
  const battlesRequested = battleIds.length;
  const battleDate = resolveBattleDate(events);

  const embed = score.empty
    ? buildEmptySquadScoreEmbed({
        squadDisplay: score.squadDisplay,
        battlesProcessed,
        battlesRequested,
        originalUrl: url,
        battleDate,
      })
    : buildScoreEmbed({ score, battlesProcessed, battlesRequested, originalUrl: url, battleDate });

  await interaction.editReply({ embeds: [embed] });
}

/**
 * @param {import('discord.js').AutocompleteInteraction} interaction
 */
export async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'squad') {
    await interaction.respond([]);
    return;
  }

  let config;
  try {
    config = await loadConfig(SQUADS_CONFIG_PATH);
  } catch {
    await interaction.respond([]);
    return;
  }

  const choices = [
    { name: MAIN_ZERG_DISPLAY, value: 'main' },
    ...config.squadOrder.map((key) => ({ name: config.squads.get(key).display, value: key })),
  ];

  const query = focused.value.toLowerCase();
  const filtered = choices.filter((choice) => choice.name.toLowerCase().includes(query)).slice(0, AUTOCOMPLETE_LIMIT);

  await interaction.respond(filtered);
}
