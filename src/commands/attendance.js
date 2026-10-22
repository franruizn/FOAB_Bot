import { SlashCommandBuilder } from 'discord.js';
import { getGuildAttendance } from '../services/albionbbApi.js';
import { loadConfig } from '../services/config.js';
import { requireConfig } from '../services/configFields.js';
import { buildAttendanceEmbed, buildPlayerNotFoundEmbed } from '../ui/attendanceEmbed.js';
import { guildLang, localizedName, localizedDescription, localizedChoice } from '../i18n.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 30;
const AUTOCOMPLETE_LIMIT = 25;
const SUGGESTION_COUNT = 3;

export const data = localizedDescription(localizedName(new SlashCommandBuilder(), 'cmd.attendance.name'), 'cmd.attendance.description')
  .addStringOption((o) =>
    localizedDescription(localizedName(o, 'cmd.attendance.opt.player.name'), 'cmd.attendance.opt.player.description')
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addIntegerOption((o) =>
    localizedDescription(localizedName(o, 'cmd.attendance.opt.days.name'), 'cmd.attendance.opt.days.description').addChoices(
      // Se traduce el nombre visible; el valor (los días) es lo que recibe el código.
      localizedChoice('cmd.attendance.choice.days7', 7),
      localizedChoice('cmd.attendance.choice.days14', 14),
      localizedChoice('cmd.attendance.choice.days30', 30),
      localizedChoice('cmd.attendance.choice.days90', 90),
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

/**
 * Distancia de Levenshtein clásica (DP de dos filas), sin dependencias.
 */
function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prevRow = Array.from({ length: b.length + 1 }, (_, j) => j);
  let currRow = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    currRow[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(currRow[j - 1] + 1, prevRow[j] + 1, prevRow[j - 1] + cost);
    }
    [prevRow, currRow] = [currRow, prevRow];
  }

  return prevRow[b.length];
}

function suggestClosestNames(input, names, limit = SUGGESTION_COUNT) {
  const inputLower = input.toLowerCase();
  const scored = names
    .map((name) => ({ name, distance: levenshteinDistance(inputLower, name.toLowerCase()) }))
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));

  const seen = new Set();
  const result = [];
  for (const item of scored) {
    const key = item.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item.name);
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * Gremio de albionbb y servidor de Albion de ESTE servidor de Discord (su
 * config.json), no de una variable global.
 * @param {string} discordGuildId
 */
async function requireAlbionbbConfig(discordGuildId) {
  const { albionbbGuildId, albionServer } = await requireConfig(discordGuildId, 'albionbbGuildId', 'albionServer');
  return { albionbbGuildId, server: albionServer };
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  await interaction.deferReply();
  // Respuesta pública: la lee el canal, va en el idioma del servidor.
  const lang = await guildLang(interaction.guildId);

  const { albionbbGuildId, server } = await requireAlbionbbConfig(interaction.guildId);
  const playerInput = interaction.options.getString('player', true).trim();
  const days = interaction.options.getInteger('days') ?? DEFAULT_DAYS;
  const dateRange = resolveDateRange(days);

  const roster = await getGuildAttendance(server, albionbbGuildId, dateRange);
  const sorted = [...roster].sort((a, b) => b.attendance - a.attendance);

  const nameLower = playerInput.toLowerCase();
  const index = sorted.findIndex((entry) => entry.name.toLowerCase() === nameLower);

  if (index === -1) {
    const suggestions = suggestClosestNames(
      playerInput,
      roster.map((entry) => entry.name),
    );
    await interaction.editReply({ embeds: [buildPlayerNotFoundEmbed({ playerInput, suggestions, lang })] });
    return;
  }

  const player = sorted[index];
  const rank = index + 1;
  const total = sorted.length;

  let squadDisplay = null;
  try {
    const config = await loadConfig(interaction.guildId);
    const squadKey = config.playerToSquad.get(nameLower);
    squadDisplay = squadKey ? config.squads.get(squadKey).display : null;
  } catch (error) {
    // squads.json es informativo aquí (detecta gente sin asignar), no
    // esencial: si falla, seguimos mostrando la attendance igualmente.
    console.error('No se pudo cargar squads.json para /attendance:', error);
  }

  const embed = buildAttendanceEmbed({ player, rank, total, server, squadDisplay, dateRange, lang });
  await interaction.editReply({ embeds: [embed] });
}

/**
 * @param {import('discord.js').AutocompleteInteraction} interaction
 */
export async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'player') {
    await interaction.respond([]);
    return;
  }

  try {
    const { albionbbGuildId, server } = await requireAlbionbbConfig(interaction.guildId);
    const dateRange = resolveDateRange(DEFAULT_DAYS);
    const roster = await getGuildAttendance(server, albionbbGuildId, dateRange);

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
