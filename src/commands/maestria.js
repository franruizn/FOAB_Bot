import { SlashCommandBuilder } from 'discord.js';
import { leerMaestria } from '../services/maestria.js';
import { listarComps, getComp } from '../services/ctaComp.js';
import { buildJugadorEmbed, buildRankingEmbed } from '../ui/maestriaEmbed.js';
import { MAESTRIA_PATH, CTA_COMPS_PATH } from '../dataPaths.js';

const RANKING_LIMIT = 15;
const AUTOCOMPLETE_LIMIT = 25;

// Discord no permite mezclar opciones sueltas con subcomandos en el mismo
// nivel: "/maestria [jugador]" y "/maestria rol <rol>" del prompt se
// expresan aquí como dos subcomandos ("jugador" con el usuario opcional,
// "rol" con el rol obligatorio), igual que el resto de comandos multi-faceta
// del bot (/cta, /comp).
export const data = new SlashCommandBuilder()
  .setName('maestria')
  .setDescription('Consulta la maestría (roles jugados en CTAs cerradas)')
  .addSubcommand((sub) =>
    sub
      .setName('jugador')
      .setDescription('Roles jugados de un jugador, de más a menos maestría (por defecto, tú)')
      .addUserOption((o) => o.setName('usuario').setDescription('A quién consultar (por defecto, tú)')),
  )
  .addSubcommand((sub) =>
    sub
      .setName('rol')
      .setDescription('Ranking de quién tiene más maestría en un rol')
      .addStringOption((o) => o.setName('rol').setDescription('Rol a consultar').setRequired(true).setAutocomplete(true)),
  );

/**
 * rolKey -> { nombre, emoji }, recogido de TODAS las plantillas de
 * composición (no solo de quien ya tiene historial en maestria.json): así
 * el autocompletado y los nombres bonitos funcionan igual de bien recién
 * instalado el bot que con años de histórico. Un rol cuya comp se borró
 * más tarde simplemente no se resuelve (se muestra su rolKey crudo).
 * @returns {Promise<Map<string, { nombre: string, emoji: string }>>}
 */
async function rolesConocidos() {
  const comps = await listarComps(CTA_COMPS_PATH);
  const roles = new Map();
  for (const { key } of comps) {
    const comp = await getComp(CTA_COMPS_PATH, key);
    if (!comp) continue;
    for (const [rolKey, rol] of Object.entries(comp.roles)) {
      if (!roles.has(rolKey)) roles.set(rolKey, { nombre: rol.nombre, emoji: rol.emoji });
    }
  }
  return roles;
}

async function handleJugador(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const usuario = interaction.options.getUser('usuario') ?? interaction.user;

  const [maestria, roles] = await Promise.all([leerMaestria(MAESTRIA_PATH), rolesConocidos()]);
  const jugador = maestria.jugadores?.[usuario.id] ?? null;

  const embed = buildJugadorEmbed({
    nombre: usuario.username,
    jugador,
    resolverRol: (rolKey) => roles.get(rolKey) ?? null,
  });
  await interaction.editReply({ embeds: [embed] });
}

async function handleRol(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const rolKey = interaction.options.getString('rol', true).trim().toLowerCase();

  const [maestria, roles] = await Promise.all([leerMaestria(MAESTRIA_PATH), rolesConocidos()]);

  const ranking = Object.entries(maestria.jugadores ?? {})
    .map(([userId, jugador]) => ({ userId, veces: jugador.roles?.[rolKey] ?? 0 }))
    .filter((r) => r.veces > 0)
    .sort((a, b) => b.veces - a.veces)
    .slice(0, RANKING_LIMIT);

  const embed = buildRankingEmbed({ rolKey, rolInfo: roles.get(rolKey) ?? null, ranking });
  await interaction.editReply({ embeds: [embed] });
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'jugador') {
    await handleJugador(interaction);
    return;
  }
  if (subcommand === 'rol') {
    await handleRol(interaction);
    return;
  }
  throw new Error(`Subcomando desconocido: ${subcommand}`);
}

/**
 * @param {import('discord.js').AutocompleteInteraction} interaction
 */
export async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'rol') {
    await interaction.respond([]);
    return;
  }

  try {
    const roles = await rolesConocidos();
    const query = String(focused.value).toLowerCase();
    const choices = [...roles.entries()]
      .filter(([rolKey, info]) => rolKey.includes(query) || info.nombre.toLowerCase().includes(query))
      .slice(0, AUTOCOMPLETE_LIMIT)
      .map(([rolKey, info]) => ({ name: info.nombre, value: rolKey }));
    await interaction.respond(choices);
  } catch (error) {
    console.error('Error en autocomplete de /maestria:', error);
    await interaction.respond([]).catch(() => {});
  }
}
