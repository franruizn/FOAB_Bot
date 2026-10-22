import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { errorEmbed } from '../ui/errorEmbed.js';
import { buildDmPreviewEmbed, buildDmProgressContent, buildDmResultSummary, buildDmResultEmbed } from '../ui/dmEmbed.js';
import { resolveMentionList } from '../services/mentionList.js';
import {
  DM_MAX_RECIPIENTS,
  DM_BODY_MAX_LENGTH,
  getDmOwnerId,
  sendMassDm,
  loadDmState,
  dmBlockReason,
  tryStartDmSend,
  recordDmSent,
  finishDmSend,
} from '../services/massDm.js';
import { DM_STATE_PATH } from '../dataPaths.js';
import { getConfig } from '../services/guildStore.js';
import { handleInteractionError } from '../interactionErrorHandler.js';
import { notifyDmUnauthorized, notifyDmStarted, notifyDmFinished, notifyUncontrolledError } from '../logChannel.js';
import { t, tn, userLang, guildLang, localizedName, localizedDescription } from '../i18n.js';

const CONFIRM_TIMEOUT_MS = 60_000;
// Lo que puede tardar en escribir el mensaje en el modal. Si se pasa, el
// envío del modal ya no llega a nadie (Discord muestra "interacción fallida").
const MODAL_TIMEOUT_MS = 15 * 60_000;
const BODY_FIELD_ID = 'cuerpo';

// Solo para tests: permite no esperar 1s real entre destinatarios.
let sleepImpl;
export function __setDmSleepForTests(fn) {
  sleepImpl = fn;
}

// Visible para todos en el picker a propósito (igual que /create-role): el
// filtro real es DM_OWNER_ID en runtime, no un permiso de Discord. Solo se
// registra en el servidor del dueño (DM_GUILD_ID, ver deployPlan.js).
export const data = localizedDescription(localizedName(new SlashCommandBuilder(), 'cmd.dm.name'), 'cmd.dm.description')
  .addRoleOption((option) =>
    localizedDescription(localizedName(option, 'cmd.dm.opt.role.name'), 'cmd.dm.opt.role.description').setRequired(false),
  )
  .addStringOption((option) =>
    localizedDescription(localizedName(option, 'cmd.dm.opt.list.name'), 'cmd.dm.opt.list.description').setRequired(false),
  );

function blockMessage(block, lang) {
  if (block.reason === 'in-progress') return t('dm.block.inProgress', lang);
  return tn('dm.block.cooldown', Math.ceil(block.remainingMs / 60_000), lang);
}

// Tras rechazar DESPUÉS del modal, se devuelve el texto para que no se
// pierda lo que se escribió.
function withBody(description, body, lang) {
  return t('dm.withBody', lang, { description, body });
}

/**
 * Todo lo que ve quien lo ejecuta (rechazos, modal, previsualización,
 * botones) es efímero: en el idioma de su cliente. El progreso y el
 * resultado se publican en el canal: en el idioma del servidor.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  const lang = userLang(interaction);
  const ownerId = getDmOwnerId();
  if (!ownerId) {
    await interaction.reply({
      embeds: [errorEmbed(t('dm.disabled.title', lang), t('dm.disabled.body', lang))],
      ephemeral: true,
    });
    return;
  }

  if (interaction.user.id !== ownerId) {
    await interaction.reply({
      embeds: [errorEmbed(t('common.noPermission.title', lang), t('dm.unauthorized.body', lang))],
      ephemeral: true,
    });
    await notifyDmUnauthorized(interaction.client, { guildId: interaction.guildId, actorTag: interaction.user.tag, actorId: interaction.user.id });
    return;
  }

  if (!interaction.guild) {
    await interaction.reply({
      embeds: [errorEmbed(t('common.serverOnly.title', lang), t('common.serverOnly.body', lang))],
      ephemeral: true,
    });
    return;
  }

  const rol = interaction.options.getRole('role');
  const lista = interaction.options.getString('list');

  if ((rol ? 1 : 0) + (lista ? 1 : 0) !== 1) {
    await interaction.reply({
      embeds: [errorEmbed(t('dm.recipients.title', lang), t('dm.recipients.body', lang))],
      ephemeral: true,
    });
    return;
  }

  // El rol @everyone SIEMPRE tiene el mismo id que el guild.
  if (rol && rol.id === interaction.guild.id) {
    await interaction.reply({
      embeds: [errorEmbed(t('dm.everyone.title', lang), t('dm.everyone.body', lang))],
      ephemeral: true,
    });
    return;
  }

  // Aviso temprano con la caché (cota inferior: si ya pasa de 200 aquí, va a
  // pasar seguro), para no hacer escribir el mensaje en balde. La
  // comprobación que cuenta es la de después del modal, con todos los
  // miembros cargados.
  if (rol) {
    const cachedCount = [...interaction.guild.members.cache.values()].filter(
      (member) => !member.user.bot && member.roles.cache.has(rol.id),
    ).length;
    if (cachedCount > DM_MAX_RECIPIENTS) {
      await interaction.reply({
        embeds: [errorEmbed(t('dm.tooMany.title', lang), t('dm.tooMany.role', lang, { max: DM_MAX_RECIPIENTS }))],
        ephemeral: true,
      });
      return;
    }
  }

  const block = dmBlockReason(await loadDmState(DM_STATE_PATH));
  if (block) {
    await interaction.reply({ embeds: [errorEmbed(t('dm.wait.title', lang), blockMessage(block, lang))], ephemeral: true });
    return;
  }

  // showModal() tiene que ser la PRIMERA respuesta a la interacción: no se
  // puede deferReply() y abrir el modal después.
  const modalId = `dm-modal-${interaction.id}`;
  const modal = new ModalBuilder()
    .setCustomId(modalId)
    .setTitle(t('dm.modal.title', lang))
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(BODY_FIELD_ID)
          .setLabel(t('dm.modal.label', lang))
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(DM_BODY_MAX_LENGTH)
          .setRequired(true),
      ),
    );
  await interaction.showModal(modal);

  let modalInteraction;
  try {
    modalInteraction = await interaction.awaitModalSubmit({
      filter: (i) => i.customId === modalId && i.user.id === ownerId,
      time: MODAL_TIMEOUT_MS,
    });
  } catch {
    return; // cerró el modal o no lo envió a tiempo: no hay nada que responder
  }

  // A partir de aquí la interacción que vale es la del modal: el manejador
  // global de index.js respondería sobre la original (ya "respondida" con el
  // modal) y fallaría, así que los errores se tratan aquí.
  try {
    await handleModalSubmit(interaction, modalInteraction, { ownerId, rol, lista, lang });
  } catch (error) {
    const { known } = await handleInteractionError(modalInteraction, error).catch(() => ({ known: false }));
    if (!known) {
      await notifyUncontrolledError(interaction.client, { guildId: interaction.guildId, commandName: 'dm', actorTag: interaction.user.tag, error });
    }
  }
}

async function handleModalSubmit(interaction, modalInteraction, { ownerId, rol, lista, lang }) {
  const body = modalInteraction.fields.getTextInputValue(BODY_FIELD_ID);

  if (body.trim().length === 0) {
    await modalInteraction.reply({
      embeds: [errorEmbed(t('dm.empty.title', lang), t('dm.empty.body', lang))],
      ephemeral: true,
    });
    return;
  }
  if (body.length > DM_BODY_MAX_LENGTH) {
    await modalInteraction.reply({
      embeds: [
        errorEmbed(
          t('dm.tooLong.title', lang),
          withBody(t('dm.tooLong.body', lang, { max: DM_BODY_MAX_LENGTH }), body.slice(0, 3000), lang),
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  await modalInteraction.deferReply({ ephemeral: true });

  const guild = interaction.guild;
  const members = await guild.members.fetch();

  let recipients;
  let unresolved = [];
  let botCount = 0;
  if (rol) {
    const withRole = [...members.values()].filter((member) => member.roles.cache.has(rol.id));
    recipients = withRole.filter((member) => !member.user.bot);
    botCount = withRole.length - recipients.length;
  } else {
    ({ resolved: recipients, unresolved } = resolveMentionList(lista, members));
  }

  if (recipients.length === 0) {
    const detail = rol
      ? t('dm.nobody.role', lang)
      : tn('dm.nobody.list', unresolved.length, lang, { list: unresolved.map((token) => `\`${token}\``).join(', ') });
    await modalInteraction.editReply({ embeds: [errorEmbed(t('dm.nobody.title', lang), withBody(detail, body, lang))] });
    return;
  }

  if (recipients.length > DM_MAX_RECIPIENTS) {
    await modalInteraction.editReply({
      embeds: [
        errorEmbed(
          t('dm.tooMany.title', lang),
          withBody(t('dm.tooMany.list', lang, { count: recipients.length, max: DM_MAX_RECIPIENTS }), body, lang),
        ),
      ],
    });
    return;
  }

  // El DM es solo lo escrito, sin cabecera de autor ni de servidor: el
  // rastro de quién lo mandó queda en el canal de logs.
  const content = body;
  const optOutRoleId = (await getConfig(interaction.guildId)).dmOptoutRoleId;
  const optedOutCount = optOutRoleId ? recipients.filter((m) => m.roles.cache.has(optOutRoleId)).length : 0;

  const confirmId = `dm-confirm-${interaction.id}`;
  const cancelId = `dm-cancel-${interaction.id}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(confirmId)
      .setLabel(tn('dm.send', recipients.length, lang))
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(cancelId).setLabel(t('common.cancel', lang)).setStyle(ButtonStyle.Secondary),
  );

  // El `content` de la previsualización es el mensaje EXACTO que va a
  // llegar. allowedMentions vacío: que una mención del
  // cuerpo no pingue a nadie ya en la previsualización.
  const message = await modalInteraction.editReply({
    content,
    embeds: [buildDmPreviewEmbed({ recipientCount: recipients.length, optedOutCount, botCount, unresolved, lang })],
    components: [row],
    allowedMentions: { parse: [] },
  });

  let buttonInteraction;
  try {
    buttonInteraction = await message.awaitMessageComponent({
      filter: (i) => i.user.id === ownerId && (i.customId === confirmId || i.customId === cancelId),
      time: CONFIRM_TIMEOUT_MS,
    });
  } catch {
    await modalInteraction.editReply({ content: t('dm.expired', lang), embeds: [], components: [] });
    return;
  }

  if (buttonInteraction.customId === cancelId) {
    await buttonInteraction.update({ content: t('dm.cancelled', lang), embeds: [], components: [] });
    return;
  }

  await buttonInteraction.deferUpdate();

  // Segunda comprobación del cooldown, esta vez reservando: entre abrir el
  // /dm y confirmar pudo empezar otro.
  const actor = { guildId: interaction.guildId, actorId: interaction.user.id, actorTag: interaction.user.tag, total: recipients.length };
  const block = await tryStartDmSend(DM_STATE_PATH, actor);
  if (block) {
    await buttonInteraction.editReply({
      content: null,
      embeds: [errorEmbed(t('dm.wait.title', lang), blockMessage(block, lang))],
      components: [],
    });
    return;
  }

  // El progreso y el resultado se publican en el canal: idioma del servidor.
  const channelLang = await guildLang(interaction.guildId);

  try {
    await notifyDmStarted(interaction.client, { ...actor, content });

    let progressMessage = null;
    try {
      progressMessage = await interaction.channel.send({
        content: buildDmProgressContent({ processed: 0, total: recipients.length, lang: channelLang }),
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      console.error('[dm] No se pudo publicar el mensaje de progreso:', error?.message ?? error);
    }

    await buttonInteraction.editReply({
      content: tn('dm.sending', recipients.length, lang),
      embeds: [],
      components: [],
    });

    const result = await sendMassDm({
      recipients,
      content,
      optOutRoleId,
      ...(sleepImpl ? { sleep: sleepImpl } : {}),
      onSent: (member) => recordDmSent(DM_STATE_PATH, member.id),
      onProgress: async (processed, total) => {
        if (progressMessage) {
          await progressMessage.edit({ content: buildDmProgressContent({ processed, total, lang: channelLang }) });
        }
      },
    });

    // Los bots de un rol se filtran antes (no cuentan para el tope de 200) y
    // los que aún lleguen aquí los salta sendMassDm: se suman ambos.
    const summaryData = { ...result, botCount: botCount + result.bots.length, unresolved };
    const summary = (l) => buildDmResultSummary({ ...summaryData, lang: l });
    const resultEmbed = (l) => buildDmResultEmbed({ senderMention: `<@${interaction.user.id}>`, summary: summary(l), lang: l });
    const resultPayload = { content: '', embeds: [resultEmbed(channelLang)], allowedMentions: { parse: [] } };

    try {
      if (progressMessage) {
        await progressMessage.edit(resultPayload);
      } else {
        await interaction.channel.send(resultPayload);
      }
    } catch (error) {
      console.error('[dm] No se pudo publicar el resultado en el canal:', error?.message ?? error);
    }

    await buttonInteraction.editReply({ content: null, embeds: [resultEmbed(lang)], components: [] }).catch(() => {});
    await notifyDmFinished(interaction.client, { guildId: interaction.guildId, actorTag: interaction.user.tag, summary });
  } finally {
    await finishDmSend(DM_STATE_PATH);
  }
}
