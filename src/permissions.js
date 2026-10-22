import { PermissionFlagsBits } from 'discord.js';
import { getConfig } from './services/guildStore.js';
import { missingConfigMessage } from './services/configFields.js';
import { errorEmbed } from './ui/errorEmbed.js';

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

/**
 * Puerta de los comandos de oficiales: si quien lo ejecuta no es oficial,
 * responde (efímero) y devuelve false. Distingue "no eres oficial" de "este
 * servidor todavía no tiene rol de oficiales" (o lo tiene apuntando a un rol
 * borrado): en un servidor recién añadido lo segundo es lo normal, y un "Sin
 * permiso" ahí no le dice a nadie que lo que falta es /config oficial.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @returns {Promise<boolean>}
 */
export async function ensureOfficer(interaction) {
  const deny = (title, description) =>
    interaction.reply({ embeds: [errorEmbed(title, description)], ephemeral: true }).then(() => false);

  if (!interaction.guildId) return deny('Sin permiso', 'Este comando solo funciona dentro de un servidor.');

  const { officerRoleId } = await getConfig(interaction.guildId);
  if (!officerRoleId) return deny('Falta configuración', missingConfigMessage('officerRoleId'));
  // Solo si el servidor está en caché: sin él no se puede saber si el rol
  // sigue existiendo, y se cae al "Sin permiso" de siempre.
  if (interaction.guild?.roles?.cache && !interaction.guild.roles.cache.has(officerRoleId)) {
    return deny(
      'Falta configuración',
      'El rol de oficiales configurado en este servidor ya no existe. Un administrador puede cambiarlo con `/config oficial`.',
    );
  }
  if (!(interaction.member?.roles?.cache?.has(officerRoleId) ?? false)) {
    return deny('Sin permiso', 'Este comando es solo para el rol de oficiales.');
  }
  return true;
}

/**
 * Permiso nativo de Administrador de Discord en ESTE servidor. Es la puerta
 * de /config: en un servidor recién añadido no hay rol de oficiales, así que
 * no se puede exigir ese rol para configurarlo. Se comprueba aquí aunque el
 * comando lleve setDefaultMemberPermissions(Administrator), porque eso se
 * puede sobrescribir desde los ajustes del servidor y esto no.
 * @param {import('discord.js').Interaction} interaction
 */
export function isAdministrator(interaction) {
  if (!interaction.guildId) return false;
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
}
