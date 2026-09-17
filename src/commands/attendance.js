import { SlashCommandBuilder } from 'discord.js';
import { getGuildAttendance } from '../services/albionbbApi.js';
import { loadConfig } from '../services/config.js';
import { suggestClosestNames } from '../services/levenshtein.js';
import { buildAttendanceEmbed, buildPlayerNotFoundEmbed } from '../ui/attendanceEmbed.js';
import { SQUADS_CONFIG_PATH } from '../dataPaths.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 30;
const AUTOCOMPLETE_LIMIT = 25;

export const data = new SlashCommandBuilder()
  .setName('attendance')
  .setDescription('Consulta la asistencia a batallas de un jugador')
  .addStringOption((o) =>
    o.setName('nombre').setDescription('Nombre del jugador').setRequired(true).setAutocomplete(true),
  )
  .addIntegerOption((o) =>
    o
      .setName('dias')
      .setDescription('Ventana de días a consultar (por defecto 30)')
      .addChoices(
        { name: '7 días', value: 7 },
        { name: '14 días', value: 14 },
        { name: '30 días', value: 30 },
        { name: '90 días', value: 90 },
      ),
  );

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function resolveDateRange(days) {
  const end = new Date();
  const start = new Date(end.getTime() - days * DAY_MS);
  return { start: formatDate(start), end: formatDate(end) };
}

function requireEnv() {
  const { ALBIONBB_GUILD_ID, ALBION_SERVER } = process.env;
  if (!ALBIONBB_GUILD_ID || !ALBION_SERVER) {
    throw new Error('Faltan las variables de entorno ALBIONBB_GUILD_ID y/o ALBION_SERVER.');
  }
  return { guildId: ALBIONBB_GUILD_ID, server: ALBION_SERVER };
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  await interaction.deferReply();

  const { guildId, server } = requireEnv();
  const playerInput = interaction.options.getString('nombre', true).trim();
  const days = interaction.options.getInteger('dias') ?? DEFAULT_DAYS;
  const dateRange = resolveDateRange(days);

  const roster = await getGuildAttendance(server, guildId, dateRange);
  const sorted = [...roster].sort((a, b) => b.attendance - a.attendance);

  const nameLower = playerInput.toLowerCase();
  const index = sorted.findIndex((entry) => entry.name.toLowerCase() === nameLower);

  if (index === -1) {
    const suggestions = suggestClosestNames(
      playerInput,
      roster.map((entry) => entry.name),
    );
    await interaction.editReply({ embeds: [buildPlayerNotFoundEmbed({ playerInput, suggestions })] });
    return;
  }

  const player = sorted[index];
  const rank = index + 1;
  const total = sorted.length;

  let squadDisplay = null;
  try {
    const config = await loadConfig(SQUADS_CONFIG_PATH);
    const squadKey = config.playerToSquad.get(nameLower);
    squadDisplay = squadKey ? config.squads.get(squadKey).display : null;
  } catch (error) {
    // squads.json es informativo aquí (detecta gente sin asignar), no
    // esencial: si falla, seguimos mostrando la attendance igualmente.
    console.error('No se pudo cargar squads.json para /attendance:', error);
  }

  const embed = buildAttendanceEmbed({ player, rank, total, server, squadDisplay, dateRange });
  await interaction.editReply({ embeds: [embed] });
}

/**
 * @param {import('discord.js').AutocompleteInteraction} interaction
 */
export async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'nombre') {
    await interaction.respond([]);
    return;
  }

  try {
    const { guildId, server } = requireEnv();
    const dateRange = resolveDateRange(DEFAULT_DAYS);
    const roster = await getGuildAttendance(server, guildId, dateRange);

    const query = focused.value.toLowerCase();
    const choices = roster
      .filter((entry) => entry.name.toLowerCase().includes(query))
      .sort((a, b) => b.attendance - a.attendance)
      .slice(0, AUTOCOMPLETE_LIMIT)
      .map((entry) => ({ name: entry.name, value: entry.name }));

    await interaction.respond(choices);
  } catch (error) {
    console.error('Error en autocomplete de /attendance:', error);
    await interaction.respond([]).catch(() => {});
  }
}
