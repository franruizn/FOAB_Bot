import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { isOfficer } from '../permissions.js';
import { errorEmbed } from '../ui/errorEmbed.js';
import { loadRaffles } from '../services/rafflesStore.js';
import { cancelRaffle } from '../raffleScheduler.js';
import { t, tn, userLang, guildLang, localizedName, localizedDescription } from '../i18n.js';

const CONFIRM_TIMEOUT_MS = 30_000;
const RAFFLE_EMOJI = '🎉';
const CONFIRM_COLOR = 0xed4245;

// /raffle-cancel en inglés, /cancelar-sorteo con el cliente en español. Es un
// comando aparte y no un subcomando de /raffle porque Discord no deja mezclar
// subcomandos con las opciones propias que ya tiene /raffle.
//
// Visible para todos en el picker a propósito: además de los oficiales, puede
// cancelar quien creó el sorteo, que no tiene por qué ser oficial. El filtro
// real se hace en runtime.
export const data = localizedDescription(localizedName(new SlashCommandBuilder(), 'cmd.raffleCancel.name'), 'cmd.raffleCancel.description');

/**
 * Cuántos se han apuntado, para que la confirmación diga lo que se pierde.
 * Sin el mensaje (borrado, sin permisos) devuelve null y la confirmación no
 * da cifra.
 */
function countParticipants(message) {
  const reaction = message?.reactions?.cache?.get(RAFFLE_EMOJI);
  if (!reaction || typeof reaction.count !== 'number') return null;
  // El bot reacciona él mismo al publicar el anuncio.
  return Math.max(0, reaction.count - (reaction.me ? 1 : 0));
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  // Respuestas efímeras: idioma de quien lo ejecuta. Lo que se publica en el
  // canal: idioma del servidor.
  const lang = userLang(interaction);

  const raffle = (await loadRaffles(interaction.guildId)).find((r) => r.channelId === interaction.channelId);
  if (!raffle) {
    await interaction.reply({
      embeds: [errorEmbed(t('raffleCancel.none.title', lang), t('raffleCancel.none.body', lang))],
      ephemeral: true,
    });
    return;
  }

  if (raffle.creatorId !== interaction.user.id && !(await isOfficer(interaction))) {
    await interaction.reply({
      embeds: [errorEmbed(t('common.noPermission.title', lang), t('raffleCancel.denied', lang))],
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const announcement = await interaction.channel.messages.fetch(raffle.messageId).catch(() => null);
  const participants = countParticipants(announcement);

  const confirmId = `raffle-cancel-confirm-${interaction.id}`;
  const keepId = `raffle-cancel-keep-${interaction.id}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(confirmId).setLabel(t('raffleCancel.button.confirm', lang)).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(keepId).setLabel(t('raffleCancel.button.keep', lang)).setStyle(ButtonStyle.Secondary),
  );
  const body = [t('raffleCancel.confirm.body', lang, { creator: raffle.creatorId, ends: Math.floor(raffle.endsAt / 1000) })];
  if (participants !== null) body.push(tn('raffleCancel.confirm.participants', participants, lang));

  const prompt = await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(CONFIRM_COLOR).setTitle(t('raffleCancel.confirm.title', lang)).setDescription(body.join('\n\n'))],
    components: [row],
  });

  let buttonInteraction;
  try {
    buttonInteraction = await prompt.awaitMessageComponent({
      filter: (i) => i.user.id === interaction.user.id,
      time: CONFIRM_TIMEOUT_MS,
    });
  } catch {
    await interaction.editReply({ content: t('raffleCancel.expired', lang), embeds: [], components: [] });
    return;
  }

  if (buttonInteraction.customId === keepId) {
    await buttonInteraction.update({ content: t('raffleCancel.kept', lang), embeds: [], components: [] });
    return;
  }

  await buttonInteraction.deferUpdate();
  const outcome = await cancelRaffle(interaction.guildId, raffle.id);
  if (outcome !== 'cancelled') {
    const reason = outcome === 'resolving' ? t('raffleCancel.resolving', lang) : t('raffleCancel.gone', lang);
    await buttonInteraction.editReply({ content: reason, embeds: [], components: [] });
    return;
  }

  // El sorteo ya está cancelado (sin temporizador y fuera de raffles.json).
  // Lo que sigue es para que el canal lo sepa: si falla, no lo deshace.
  const publicLang = await guildLang(interaction.guildId);
  const values = { user: interaction.user.id, creator: raffle.creatorId };
  if (announcement) {
    await announcement
      .edit({ content: t('raffleCancel.announcement', publicLang, values), embeds: [], allowedMentions: { parse: [] } })
      .catch((error) => console.error(`[raffle] No se pudo marcar como cancelado el anuncio ${raffle.messageId}:`, error?.message ?? error));
    // Sin "Gestionar mensajes" las reacciones se quedan: el anuncio ya dice que está cancelado.
    await announcement.reactions.removeAll().catch(() => {});
  }

  let noticed = true;
  try {
    await interaction.channel.send({
      content: t('raffleCancel.public', publicLang, values),
      reply: { messageReference: raffle.messageId, failIfNotExists: false },
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    noticed = false;
    console.error(`[raffle] Sorteo ${raffle.id} cancelado, pero no se pudo avisar en el canal:`, error?.message ?? error);
  }

  await buttonInteraction.editReply({ content: t(noticed ? 'raffleCancel.done' : 'raffleCancel.doneNoNotice', lang), embeds: [], components: [] });
}
