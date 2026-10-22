import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { ensureOfficer } from '../permissions.js';
import { errorEmbed } from '../ui/errorEmbed.js';
import { buildCrearRolPreviewEmbed, buildCrearRolResultEmbed } from '../ui/crearRolEmbed.js';
import { resolveMentionList } from '../services/mentionList.js';
import { verificarPrerequisitosDeRol, RolePrerequisiteError } from '../services/rolePrerequisites.js';
import { notifyRoleCreation } from '../logChannel.js';
import { t, tn, userLang, guildLang, localizedName, localizedDescription } from '../i18n.js';

const CONFIRM_TIMEOUT_MS = 60_000;
const ROLE_NAME_MAX_LENGTH = 100; // límite real de Discord para el nombre de un rol

function contieneMencionMasiva(texto) {
  const normalizado = texto.toLowerCase();
  return normalizado.includes('@everyone') || normalizado.includes('@here');
}

// /create-role en inglés, /crear-rol con el cliente en español: el mismo
// comando.
//
// Visible para todos en el picker de Discord a propósito: el filtro real es
// ensureOfficer() (officerRoleId del servidor) en runtime, no un permiso de Discord por
// servidor que haya que reconfigurar a mano en cada uno.
export const data = localizedDescription(localizedName(new SlashCommandBuilder(), 'cmd.createRole.name'), 'cmd.createRole.description')
  .addStringOption((option) =>
    localizedDescription(localizedName(option, 'cmd.createRole.opt.name.name'), 'cmd.createRole.opt.name.description').setRequired(true),
  )
  .addStringOption((option) =>
    localizedDescription(localizedName(option, 'cmd.createRole.opt.list.name'), 'cmd.createRole.opt.list.description').setRequired(true),
  );

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  if (!(await ensureOfficer(interaction))) return;
  // Todas las respuestas son efímeras: idioma de quien lo ejecuta.
  const lang = userLang(interaction);

  const nombreInput = interaction.options.getString('name', true).trim();
  const lista = interaction.options.getString('list', true);

  if (nombreInput.length === 0) {
    await interaction.reply({
      embeds: [errorEmbed(t('createRole.error.nameEmpty.title', lang), t('createRole.error.nameEmpty.body', lang))],
      ephemeral: true,
    });
    return;
  }
  if (contieneMencionMasiva(nombreInput)) {
    await interaction.reply({
      embeds: [errorEmbed(t('createRole.error.massMention.title', lang), t('createRole.error.massMention.body', lang))],
      ephemeral: true,
    });
    return;
  }

  // Recorte silencioso al límite de Discord para nombres de rol.
  const rolName = nombreInput.slice(0, ROLE_NAME_MAX_LENGTH);

  // Dos roles con el mismo nombre son indistinguibles al asignar a mano:
  // mejor rechazar que crear un duplicado.
  if (interaction.guild.roles.cache.some((role) => role.name === rolName)) {
    await interaction.reply({
      embeds: [errorEmbed(t('createRole.error.exists.title', lang), t('createRole.error.exists.body', lang, { role: rolName }))],
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({ content: t('createRole.resolving', lang), ephemeral: true });

  const members = await interaction.guild.members.fetch();
  const { resolved, unresolved } = resolveMentionList(lista, members);

  if (resolved.length === 0) {
    await interaction.editReply({
      content: null,
      embeds: [
        errorEmbed(
          t('createRole.nobody.title', lang),
          tn('createRole.nobody.body', unresolved.length, lang, { list: unresolved.map((token) => `\`${token}\``).join(', ') }),
        ),
      ],
    });
    return;
  }

  const confirmId = `crear-rol-confirm-${interaction.id}`;
  const cancelId = `crear-rol-cancel-${interaction.id}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(confirmId).setLabel(t('common.confirm', lang)).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(cancelId).setLabel(t('common.cancel', lang)).setStyle(ButtonStyle.Secondary),
  );

  const message = await interaction.editReply({
    content: null,
    embeds: [buildCrearRolPreviewEmbed({ rolName, resolvedCount: resolved.length, unresolved, lang })],
    components: [row],
  });

  let buttonInteraction;
  try {
    buttonInteraction = await message.awaitMessageComponent({
      filter: (i) => i.user.id === interaction.user.id,
      time: CONFIRM_TIMEOUT_MS,
    });
  } catch {
    await interaction.editReply({ content: t('createRole.expired', lang), embeds: [], components: [] });
    return;
  }

  if (buttonInteraction.customId === cancelId) {
    await buttonInteraction.update({ content: t('createRole.cancelled', lang), embeds: [], components: [] });
    return;
  }

  // Crear el rol y dar de alta a cada persona son varias llamadas a la API
  // (hasta 1 + N: el rol y una por persona) — se difiere el ack del botón
  // antes de empezar para no chocar con la ventana de 3s de la interacción.
  await buttonInteraction.deferUpdate();

  // Permiso "Gestionar roles", jerarquía por encima de la posición 1 y tope
  // de 250 roles (services/rolePrerequisites.js): si fallan aquí, terminan
  // ANTES de tocar guild.roles.create().
  try {
    verificarPrerequisitosDeRol(interaction.guild);
  } catch (error) {
    if (error instanceof RolePrerequisiteError) {
      await buttonInteraction.editReply({
        content: null,
        embeds: [errorEmbed(t('createRole.failed.title', lang), error.localized(lang))],
        components: [],
      });
      return;
    }
    throw error;
  }

  // El motivo queda en el registro de auditoría del servidor: lo leen sus
  // administradores, así que va en el idioma del servidor.
  const reason = t('createRole.auditReason', await guildLang(interaction.guildId), { tag: interaction.user.tag });
  const role = await interaction.guild.roles.create({ name: rolName, mentionable: true, reason });

  const failedMentions = [];
  for (const member of resolved) {
    try {
      await member.roles.add(role.id, reason);
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
        lang,
      }),
    ],
    components: [],
  });

  await notifyRoleCreation(interaction.client, {
    guildId: interaction.guildId,
    actorTag: interaction.user.tag,
    roleMention: `<@&${role.id}>`,
    assignedCount,
    totalResolved: resolved.length,
    unresolved,
    failedMentions,
  });
}
