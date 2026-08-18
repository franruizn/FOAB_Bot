import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../services/config.js';
import { SERVER_HOSTS } from '../services/albionApi.js';
import { SQUADS_CONFIG_PATH, DATA_DIR } from '../dataPaths.js';
import { errorEmbed } from '../ui/errorEmbed.js';
import { isOfficer } from '../permissions.js';

const PACKAGE_JSON_PATH = fileURLToPath(new URL('../../package.json', import.meta.url));
const EMBED_COLOR = 0x00ff9d;
const PING_TIMEOUT_MS = 5_000;

// Visible para todos en el picker de Discord a propósito: el filtro real es
// isOfficer() (OFFICER_ROLE_ID) en runtime, no un permiso de Discord por
// servidor que haya que reconfigurar a mano en cada uno.
export const data = new SlashCommandBuilder().setName('health').setDescription('Estado del bot (solo oficiales)');

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(' ');
}

async function readVersion() {
  try {
    const raw = await readFile(PACKAGE_JSON_PATH, 'utf8');
    return JSON.parse(raw).version ?? 'desconocida';
  } catch {
    return 'desconocida';
  }
}

async function findLastBackup() {
  const backupDir = path.join(DATA_DIR, 'backups');
  try {
    const entries = (await readdir(backupDir)).filter((name) => name.startsWith('squads-') && name.endsWith('.json'));
    if (entries.length === 0) return null;
    entries.sort(); // timestamps ISO en el nombre -> orden cronológico
    const latest = entries[entries.length - 1];
    const stats = await stat(path.join(backupDir, latest));
    return stats.mtime;
  } catch {
    return null; // aún no hay backups (nunca se usó /squads en este DATA_DIR)
  }
}

async function pingAlbionApi(server) {
  const host = SERVER_HOSTS[server];
  if (!host) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${host}/battles?limit=1&offset=0&sort=recent`, { signal: controller.signal });
    if (!response.ok) return null;
    await response.json();
    return Date.now() - startedAt;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  if (!isOfficer(interaction)) {
    await interaction.reply({
      embeds: [errorEmbed('Sin permiso', 'Este comando es solo para el rol de oficiales.')],
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const server = process.env.ALBION_SERVER || 'europe';

  const [version, lastBackup, latencyMs, configResult] = await Promise.all([
    readVersion(),
    findLastBackup(),
    pingAlbionApi(server),
    loadConfig(SQUADS_CONFIG_PATH).catch((error) => ({ error })),
  ]);

  const squadsLine =
    'error' in configResult
      ? `⚠️ No se pudo cargar squads.json (${configResult.error.message})`
      : `${configResult.squadOrder.length} squads, ${configResult.playerToSquad.size} jugadores`;

  const embed = new EmbedBuilder()
    .setTitle('🩺 FOAB Bot — Health')
    .setColor(EMBED_COLOR)
    .addFields(
      { name: 'Uptime', value: formatUptime(process.uptime()), inline: true },
      { name: 'Versión', value: version, inline: true },
      { name: `Latencia API Albion (${server})`, value: latencyMs !== null ? `${latencyMs}ms` : 'sin respuesta', inline: true },
      { name: 'Squads / jugadores cargados', value: squadsLine, inline: false },
      {
        name: 'Último backup',
        value: lastBackup ? `<t:${Math.floor(lastBackup.getTime() / 1000)}:R>` : 'sin backups todavía',
        inline: false,
      },
    )
    .setTimestamp(new Date());

  await interaction.editReply({ embeds: [embed] });
}
