import { SlashCommandBuilder } from 'discord.js';
import { ensureOfficer } from '../permissions.js';
import { errorEmbed } from '../ui/errorEmbed.js';
import { buildRaffleAnnouncementContent } from '../ui/raffleEmbed.js';
import { getConfig } from '../services/guildStore.js';
import { loadRaffles, addRaffle } from '../services/rafflesStore.js';
import { scheduleRaffleResolution } from '../raffleScheduler.js';
import { t, userLang, guildLang, localizedName, localizedDescription } from '../i18n.js';

const MIN_MINUTES = 1;
const MAX_MINUTES = 1440;

// Visible para todos en el picker de Discord a propósito: el filtro real es
// ensureOfficer() (officerRoleId del servidor) en runtime, no un permiso de Discord por
// servidor que haya que reconfigurar a mano en cada uno.
// /raffle en inglés, /sorteo con el cliente en español: el mismo comando.
export const data = localizedDescription(localizedName(new SlashCommandBuilder(), 'cmd.raffle.name'), 'cmd.raffle.description')
  .addIntegerOption((option) =>
    localizedDescription(localizedName(option, 'cmd.raffle.opt.minutes.name'), 'cmd.raffle.opt.minutes.description')
      .setRequired(true)
      .setMinValue(MIN_MINUTES)
      .setMaxValue(MAX_MINUTES),
  )
  .addRoleOption((option) =>
    localizedDescription(localizedName(option, 'cmd.raffle.opt.role.name'), 'cmd.raffle.opt.role.description').setRequired(false),
  );

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  if (!(await ensureOfficer(interaction))) return;
  // Las respuestas a quien lo lanza son efímeras (su idioma); el anuncio lo
  // lee el canal (idioma del servidor).
  const lang = userLang(interaction);

  const minutes = interaction.options.getInteger('minutes', true);
  // Defensa en profundidad: setMinValue/setMaxValue ya lo bloquean en el
  // cliente de Discord, pero si el comando registrado quedó desactualizado
  // (deploy pendiente) esto sigue rechazándolo con un mensaje claro.
  if (!Number.isInteger(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
    await interaction.reply({
      embeds: [
        errorEmbed(t('raffle.error.duration.title', lang), t('raffle.error.duration.body', lang, { min: MIN_MINUTES, max: MAX_MINUTES })),
      ],
      ephemeral: true,
    });
    return;
  }

  const requiredRole = interaction.options.getRole('role');
  // El rol @everyone tiene el mismo id que el guild: pasarlo como filtro
  // equivale a no filtrar nada, y solo confundiría al leer el anuncio.
  if (requiredRole && requiredRole.id === interaction.guildId) {
    await interaction.reply({
      embeds: [errorEmbed(t('raffle.error.everyone.title', lang), t('raffle.error.everyone.body', lang))],
      ephemeral: true,
    });
    return;
  }

  const existingRaffles = await loadRaffles(interaction.guildId);
  if (existingRaffles.some((raffle) => raffle.channelId === interaction.channelId)) {
    await interaction.reply({
      embeds: [errorEmbed(t('raffle.error.active.title', lang), t('raffle.error.active.body', lang))],
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({ content: t('raffle.created', lang), ephemeral: true });

  const endsAt = Date.now() + minutes * 60_000;
  const requiredRoleId = requiredRole?.id ?? null;
  const { raffleRoleId } = await getConfig(interaction.guildId);
  const content = buildRaffleAnnouncementContent({
    creatorId: interaction.user.id,
    endsAtUnixSeconds: Math.floor(endsAt / 1000),
    roleId: raffleRoleId,
    requiredRoleId,
    lang: await guildLang(interaction.guildId),
  });

  // Sin allowedMentions explícito, discord.js renderiza la mención de rol
  // pero no siempre la notifica; con rol restrictivo esa mención es la única
  // pista visible de a quién va dirigido el sorteo, así que se fuerza aquí.
  const pingRoleId = requiredRoleId ?? raffleRoleId;
  const message = await interaction.channel.send({
    content,
    allowedMentions: { roles: pingRoleId ? [pingRoleId] : [] },
  });
  await message.react('🎉');

  const raffle = {
    id: message.id,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    messageId: message.id,
    endsAt,
    creatorId: interaction.user.id,
    roleId: requiredRoleId,
  };

  await addRaffle(raffle);
  // creatorId va dentro de `raffle` (persistido arriba) — no se pasa aparte:
  // ver el comentario en resolveRaffle() sobre por qué.
  scheduleRaffleResolution(interaction.client, raffle);
}
