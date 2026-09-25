import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { isOfficer } from '../permissions.js';
import { errorEmbed } from '../ui/errorEmbed.js';
import { buildCrearRolPreviewEmbed, buildCrearRolResultEmbed } from '../ui/crearRolEmbed.js';
import { resolveMentionList } from '../services/mentionList.js';
import { verificarPrerequisitosDeRol, CtaRoleError } from '../services/ctaRole.js';
import { notifyRoleCreation } from '../logChannel.js';

const CONFIRM_TIMEOUT_MS = 60_000;
const ROLE_NAME_MAX_LENGTH = 100; // límite real de Discord para el nombre de un rol

function contieneMencionMasiva(texto) {
  const normalizado = texto.toLowerCase();
  return normalizado.includes('@everyone') || normalizado.includes('@here');
}

// Visible para todos en el picker de Discord a propósito: el filtro real es
// isOfficer() (OFFICER_ROLE_ID) en runtime, no un permiso de Discord por
// servidor que haya que reconfigurar a mano en cada uno.
export const data = new SlashCommandBuilder()
  .setName('crear-rol')
  .setDescription('Crea un rol y se lo asigna a una lista de personas (solo oficiales)')
  .addStringOption((option) => option.setName('nombre').setDescription('Nombre del rol a crear').setRequired(true))
  .addStringOption((option) =>
    option
      .setName('lista')
      .setDescription('@usuario o menciones, separados por espacios o comas')
      .setRequired(true),
  );

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

  const nombreInput = interaction.options.getString('nombre', true).trim();
  const lista = interaction.options.getString('lista', true);

  if (nombreInput.length === 0) {
    await interaction.reply({ embeds: [errorEmbed('Nombre inválido', 'El nombre del rol no puede estar vacío.')], ephemeral: true });
    return;
  }
  if (contieneMencionMasiva(nombreInput)) {
    await interaction.reply({
      embeds: [errorEmbed('Nombre inválido', 'El nombre del rol no puede contener "@everyone" ni "@here".')],
      ephemeral: true,
    });
    return;
  }

  // Recorte silencioso: es el mismo límite que aplica generarNombreDeRolUnico
  // para los roles de CTA, aquí sin sufijo que preservar.
  const rolName = nombreInput.slice(0, ROLE_NAME_MAX_LENGTH);

  // Dos roles con el mismo nombre son indistinguibles al asignar a mano:
  // mejor rechazar que crear un duplicado.
  if (interaction.guild.roles.cache.some((role) => role.name === rolName)) {
    await interaction.reply({
      embeds: [errorEmbed('El rol ya existe', `Ya hay un rol llamado "${rolName}" en este servidor. Elige otro nombre.`)],
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({ content: 'Resolviendo la lista...', ephemeral: true });

  const members = await interaction.guild.members.fetch();
  const { resolved, unresolved } = resolveMentionList(lista, members);

  if (resolved.length === 0) {
    await interaction.editReply({
      content: null,
      embeds: [
        errorEmbed(
          'No se ha podido resolver a nadie',
          `Ninguno de los ${unresolved.length} nombre(s) de la lista coincide con un miembro de este servidor:\n` +
            unresolved.map((token) => `\`${token}\``).join(', '),
        ),
      ],
    });
    return;
  }

  const confirmId = `crear-rol-confirm-${interaction.id}`;
  const cancelId = `crear-rol-cancel-${interaction.id}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(confirmId).setLabel('Confirmar').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(cancelId).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
  );

  const message = await interaction.editReply({
    content: null,
    embeds: [buildCrearRolPreviewEmbed({ rolName, resolvedCount: resolved.length, unresolved })],
    components: [row],
  });

  let buttonInteraction;
  try {
    buttonInteraction = await message.awaitMessageComponent({
      filter: (i) => i.user.id === interaction.user.id,
      time: CONFIRM_TIMEOUT_MS,
    });
  } catch {
    await interaction.editReply({ content: 'Confirmación expirada. No se creó ningún rol.', embeds: [], components: [] });
    return;
  }

  if (buttonInteraction.customId === cancelId) {
    await buttonInteraction.update({ content: 'Creación cancelada.', embeds: [], components: [] });
    return;
  }

  // Crear el rol y dar de alta a cada persona son varias llamadas a la API
  // (hasta 1 + N: el rol y una por persona) — se difiere el ack del botón
  // antes de empezar para no chocar con la ventana de 3s de la interacción.
  await buttonInteraction.deferUpdate();

  // Mismas comprobaciones que /cta (permiso "Gestionar roles", jerarquía por
  // encima de la posición 1, tope de 250 roles), reutilizadas tal cual: si
  // fallan aquí, terminan ANTES de tocar guild.roles.create().
  try {
    verificarPrerequisitosDeRol(interaction.guild);
  } catch (error) {
    if (error instanceof CtaRoleError) {
      await buttonInteraction.editReply({
        content: null,
        embeds: [errorEmbed('No se pudo crear el rol', error.message)],
        components: [],
      });
      return;
    }
    throw error;
  }

  const role = await interaction.guild.roles.create({
    name: rolName,
    mentionable: true,
    reason: `/crear-rol por ${interaction.user.tag}`,
  });

  const failedMentions = [];
  for (const member of resolved) {
    try {
      await member.roles.add(role.id, `/crear-rol por ${interaction.user.tag}`);
    } catch (error) {
      console.error(`[crear-rol] No se pudo asignar el rol ${role.id} a ${member.id}:`, error?.stack ?? error);
      failedMentions.push(`<@${member.id}>`);
    }
  }

  const assignedCount = resolved.length - failedMentions.length;

  await buttonInteraction.editReply({
    content: null,
    embeds: [
      buildCrearRolResultEmbed({
        roleMention: `<@&${role.id}>`,
        assignedCount,
        totalResolved: resolved.length,
        unresolved,
        failedMentions,
      }),
    ],
    components: [],
  });

  await notifyRoleCreation(interaction.client, {
    actorTag: interaction.user.tag,
    roleMention: `<@&${role.id}>`,
    assignedCount,
    totalResolved: resolved.length,
    unresolved,
    failedMentions,
  });
}
