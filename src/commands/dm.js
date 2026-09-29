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
  getDmOptOutRoleId,
  buildDmContent,
  sendMassDm,
  loadDmState,
  dmBlockReason,
  tryStartDmSend,
  recordDmSent,
  finishDmSend,
} from '../services/massDm.js';
import { DM_STATE_PATH } from '../dataPaths.js';
import { handleInteractionError } from '../interactionErrorHandler.js';
import { notifyDmUnauthorized, notifyDmStarted, notifyDmFinished, notifyUncontrolledError } from '../logChannel.js';

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

// Visible para todos en el picker a propósito (igual que /crear-rol): el
// filtro real es DM_OWNER_ID en runtime, no un permiso de Discord.
export const data = new SlashCommandBuilder()
  .setName('dm')
  .setDescription('Envía un mensaje privado a varias personas (solo DM_OWNER_ID)')
  .addRoleOption((option) => option.setName('rol').setDescription('A todos los miembros de este rol').setRequired(false))
  .addStringOption((option) =>
    option
      .setName('lista')
      .setDescription('O a esta lista: @usuario o menciones, separados por espacios o comas')
      .setRequired(false),
  );

function formatRemaining(ms) {
  const minutes = Math.ceil(ms / 60_000);
  return `${minutes} minuto${minutes === 1 ? '' : 's'}`;
}

function blockMessage(block) {
  if (block.reason === 'in-progress') return 'Ya hay un /dm enviándose ahora mismo. Espera a que termine.';
  return `Solo se permite un /dm cada 10 minutos. Podrás enviar otro en ${formatRemaining(block.remainingMs)}.`;
}

// Tras rechazar DESPUÉS del modal, se devuelve el texto para que no se
// pierda lo que se escribió.
function withBody(description, body) {
  return `${description}\n\nTu mensaje, para que no se pierda:\n>>> ${body}`;
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  const ownerId = getDmOwnerId();
  if (!ownerId) {
    await interaction.reply({
      embeds: [errorEmbed('Comando desactivado', '/dm está desactivado: falta configurar DM_OWNER_ID.')],
      ephemeral: true,
    });
    return;
  }

  if (interaction.user.id !== ownerId) {
    await interaction.reply({
      embeds: [errorEmbed('Sin permiso', 'Este comando solo lo puede usar una persona concreta. El intento queda registrado.')],
      ephemeral: true,
    });
    await notifyDmUnauthorized(interaction.client, { actorTag: interaction.user.tag, actorId: interaction.user.id });
    return;
  }

  if (!interaction.guild) {
    await interaction.reply({ embeds: [errorEmbed('Solo en servidores', '/dm solo funciona dentro de un servidor.')], ephemeral: true });
    return;
  }

  const rol = interaction.options.getRole('rol');
  const lista = interaction.options.getString('lista');

  if ((rol ? 1 : 0) + (lista ? 1 : 0) !== 1) {
    await interaction.reply({
      embeds: [errorEmbed('Destinatarios', 'Indica **uno** de los dos: `rol` o `lista`.')],
      ephemeral: true,
    });
    return;
  }

  // El rol @everyone SIEMPRE tiene el mismo id que el guild.
  if (rol && rol.id === interaction.guild.id) {
    await interaction.reply({
      embeds: [errorEmbed('Rol no permitido', 'No se puede usar @everyone como destinatario de /dm.')],
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
        embeds: [errorEmbed('Demasiados destinatarios', `El rol tiene más de ${DM_MAX_RECIPIENTS} miembros. /dm tiene un tope de ${DM_MAX_RECIPIENTS}.`)],
        ephemeral: true,
      });
      return;
    }
  }

  const block = dmBlockReason(await loadDmState(DM_STATE_PATH));
  if (block) {
    await interaction.reply({ embeds: [errorEmbed('Espera un poco', blockMessage(block))], ephemeral: true });
    return;
  }

  // showModal() tiene que ser la PRIMERA respuesta a la interacción: no se
  // puede deferReply() y abrir el modal después.
  const modalId = `dm-modal-${interaction.id}`;
  const modal = new ModalBuilder()
    .setCustomId(modalId)
    .setTitle('Mensaje privado')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(BODY_FIELD_ID)
          .setLabel('Mensaje (se añade una cabecera con tu nombre)')
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
    await handleModalSubmit(interaction, modalInteraction, { ownerId, rol, lista });
  } catch (error) {
    const { known } = await handleInteractionError(modalInteraction, error).catch(() => ({ known: false }));
    if (!known) {
      await notifyUncontrolledError(interaction.client, { commandName: 'dm', actorTag: interaction.user.tag, error });
    }
  }
}

async function handleModalSubmit(interaction, modalInteraction, { ownerId, rol, lista }) {
  const body = modalInteraction.fields.getTextInputValue(BODY_FIELD_ID);

  if (body.trim().length === 0) {
    await modalInteraction.reply({ embeds: [errorEmbed('Mensaje vacío', 'El mensaje no puede estar vacío.')], ephemeral: true });
    return;
  }
  if (body.length > DM_BODY_MAX_LENGTH) {
    await modalInteraction.reply({
      embeds: [errorEmbed('Mensaje demasiado largo', withBody(`Máximo ${DM_BODY_MAX_LENGTH} caracteres.`, body.slice(0, 3000)))],
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
      ? 'El rol no tiene ningún miembro (que no sea un bot).'
      : `Ninguno de los ${unresolved.length} nombre(s) de la lista coincide con un miembro de este servidor:\n` +
        unresolved.map((token) => `\`${token}\``).join(', ');
    await modalInteraction.editReply({ embeds: [errorEmbed('Nadie a quien enviar', withBody(detail, body))] });
    return;
  }

  if (recipients.length > DM_MAX_RECIPIENTS) {
    await modalInteraction.editReply({
      embeds: [
        errorEmbed(
          'Demasiados destinatarios',
          withBody(`Son ${recipients.length} y el tope de /dm es ${DM_MAX_RECIPIENTS}. No se ha enviado nada.`, body),
        ),
      ],
    });
    return;
  }

  const content = buildDmContent({
    senderName: interaction.member?.displayName ?? interaction.user.globalName ?? interaction.user.username,
    guildName: guild.name,
    body,
  });
  const optOutRoleId = getDmOptOutRoleId();
  const optedOutCount = optOutRoleId ? recipients.filter((m) => m.roles.cache.has(optOutRoleId)).length : 0;

  const confirmId = `dm-confirm-${interaction.id}`;
  const cancelId = `dm-cancel-${interaction.id}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(confirmId).setLabel(`Enviar a ${recipients.length}`).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(cancelId).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
  );

  // El `content` de la previsualización es el mensaje EXACTO que va a
  // llegar, cabecera incluida. allowedMentions vacío: que una mención del
  // cuerpo no pingue a nadie ya en la previsualización.
  const message = await modalInteraction.editReply({
    content,
    embeds: [buildDmPreviewEmbed({ recipientCount: recipients.length, optedOutCount, botCount, unresolved })],
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
    await modalInteraction.editReply({ content: 'Confirmación expirada. No se envió nada.', embeds: [], components: [] });
    return;
  }

  if (buttonInteraction.customId === cancelId) {
    await buttonInteraction.update({ content: 'Envío cancelado. No se envió nada.', embeds: [], components: [] });
    return;
  }

  await buttonInteraction.deferUpdate();

  // Segunda comprobación del cooldown, esta vez reservando: entre abrir el
  // /dm y confirmar pudo empezar otro.
  const actor = { actorId: interaction.user.id, actorTag: interaction.user.tag, total: recipients.length };
  const block = await tryStartDmSend(DM_STATE_PATH, actor);
  if (block) {
    await buttonInteraction.editReply({ content: null, embeds: [errorEmbed('Espera un poco', blockMessage(block))], components: [] });
    return;
  }

  try {
    await notifyDmStarted(interaction.client, { ...actor, content });

    let progressMessage = null;
    try {
      progressMessage = await interaction.channel.send({
        content: buildDmProgressContent({ processed: 0, total: recipients.length }),
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      console.error('[dm] No se pudo publicar el mensaje de progreso:', error?.message ?? error);
    }

    await buttonInteraction.editReply({
      content: `Enviando a ${recipients.length} persona(s), uno por segundo. El progreso y el resultado se publican en el canal.`,
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
        if (progressMessage) await progressMessage.edit({ content: buildDmProgressContent({ processed, total }) });
      },
    });

    // Los bots de un rol se filtran antes (no cuentan para el tope de 200) y
    // los que aún lleguen aquí los salta sendMassDm: se suman ambos.
    const summary = buildDmResultSummary({ ...result, botCount: botCount + result.bots.length, unresolved });
    const resultEmbed = buildDmResultEmbed({ senderMention: `<@${interaction.user.id}>`, summary });
    const resultPayload = { content: '', embeds: [resultEmbed], allowedMentions: { parse: [] } };

    try {
      if (progressMessage) {
        await progressMessage.edit(resultPayload);
      } else {
        await interaction.channel.send(resultPayload);
      }
    } catch (error) {
      console.error('[dm] No se pudo publicar el resultado en el canal:', error?.message ?? error);
    }

    await buttonInteraction.editReply({ content: null, embeds: [resultEmbed], components: [] }).catch(() => {});
    await notifyDmFinished(interaction.client, { actorTag: interaction.user.tag, summary });
  } finally {
    await finishDmSend(DM_STATE_PATH);
  }
}
