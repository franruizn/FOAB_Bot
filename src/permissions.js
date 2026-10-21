import { getConfig } from './services/guildStore.js';

/**
 * Comprueba en runtime si quien invocó la interacción tiene el rol de
 * oficiales de ESE servidor (officerRoleId de su config.json). No confiar
 * solo en setDefaultMemberPermissions: eso es una guía de UI en Discord, no
 * una restricción real. Falla cerrado: sin servidor (un DM) o sin rol
 * configurado, nadie es oficial.
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<boolean>}
 */
export async function isOfficer(interaction) {
  if (!interaction.guildId) return false;
  const { officerRoleId } = await getConfig(interaction.guildId);
  if (!officerRoleId) return false;
  return interaction.member?.roles?.cache?.has(officerRoleId) ?? false;
}
