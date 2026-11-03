import { SlashCommandBuilder } from 'discord.js';
import { ensureOfficer } from '../permissions.js';
import { errorEmbed } from '../ui/errorEmbed.js';
import { buildRaffleAnnouncementContent, buildRaffleMessageEmbed } from '../ui/raffleEmbed.js';
import { getConfig } from '../services/guildStore.js';
import { loadRaffles, addRaffle, MIN_WINNERS, MAX_WINNERS } from '../services/rafflesStore.js';
import { scheduleRaffleResolution } from '../raffleScheduler.js';
import { t, tn, userLang, guildLang, localizedName, localizedDescription } from '../i18n.js';

const MIN_MINUTES = 1;
const MAX_MINUTES = 1440;
const MAX_MESSAGE_LENGTH = 300;

/**
 * El mensaje tal como se va a publicar: en una opción de slash command no se
 * puede pulsar Enter, así que la secuencia literal `\n` pasa a ser un salto
 * de línea real. Tres o más saltos seguidos (contando líneas que solo tienen
 * espacios) se quedan en dos, para que nadie estire el anuncio a base de
 * líneas vacías. Vacío o solo espacios: sin mensaje (null).
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
export function normalizeRaffleMessage(raw) {
  if (raw == null) return null;
  const text = raw
    .replace(/\\n/g, '\n')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}

/** Longitud en caracteres visibles (un emoji cuenta como uno, no como dos). */
function visibleLength(text) {
  return [...text].length;
}

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
  .addIntegerOption((option) =>
    localizedDescription(localizedName(option, 'cmd.raffle.opt.winners.name'), 'cmd.raffle.opt.winners.description')
      .setRequired(false)
      .setMinValue(MIN_WINNERS)
      .setMaxValue(MAX_WINNERS),
  )
  // Sin setMaxLength a propósito: Discord cortaría en el cliente sin decir
  // cuánto sobra, y además contaría cada \n como dos caracteres. El límite se
  // aplica abajo, sobre el texto ya normalizado.
  .addStringOption((option) =>
    localizedDescription(localizedName(option, 'cmd.raffle.opt.message.name'), 'cmd.raffle.opt.message.description').setRequired(false),
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

  const winners = interaction.options.getInteger('winners') ?? 1;
  // Misma defensa en profundidad que con los minutos.
  if (!Number.isInteger(winners) || winners < MIN_WINNERS || winners > MAX_WINNERS) {
    await interaction.reply({
      embeds: [
        errorEmbed(t('raffle.error.winners.title', lang), t('raffle.error.winners.body', lang, { min: MIN_WINNERS, max: MAX_WINNERS })),
      ],
      ephemeral: true,
    });
    return;
  }

  const raffleMessage = normalizeRaffleMessage(interaction.options.getString('message'));
  if (raffleMessage && visibleLength(raffleMessage) > MAX_MESSAGE_LENGTH) {
    await interaction.reply({
      embeds: [
        errorEmbed(
          t('raffle.error.message.title', lang),
          tn('raffle.error.message.body', visibleLength(raffleMessage) - MAX_MESSAGE_LENGTH, lang, { max: MAX_MESSAGE_LENGTH }),
        ),
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
  const announcementLang = await guildLang(interaction.guildId);
  const content = buildRaffleAnnouncementContent({
    creatorId: interaction.user.id,
    endsAtUnixSeconds: Math.floor(endsAt / 1000),
    roleId: raffleRoleId,
    requiredRoleId,
    winners,
    lang: announcementLang,
  });

  // Sin allowedMentions explícito, discord.js renderiza la mención de rol
  // pero no siempre la notifica; con rol restrictivo esa mención es la única
  // pista visible de a quién va dirigido el sorteo, así que se fuerza aquí.
  // El mensaje del sorteo va en su propio embed (las menciones de un embed
  // nunca notifican), y parse: [] cierra la puerta igualmente: lo escribe
  // quien lanza el comando pero lo envía el bot, así que un @everyone, @here
  // o <@&rol> tendría el alcance del bot. Solo notifica el rol del sorteo,
  // puesto a mano. Sin mensaje no se manda ningún embed: el anuncio es el de
  // siempre.
  const pingRoleId = requiredRoleId ?? raffleRoleId;
  const message = await interaction.channel.send({
    content,
    ...(raffleMessage ? { embeds: [buildRaffleMessageEmbed({ message: raffleMessage, lang: announcementLang })] } : {}),
    allowedMentions: { parse: [], roles: pingRoleId ? [pingRoleId] : [] },
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
    winners,
    message: raffleMessage,
  };

  await addRaffle(raffle);
  // creatorId va dentro de `raffle` (persistido arriba) — no se pasa aparte:
  // ver el comentario en resolveRaffle() sobre por qué.
  scheduleRaffleResolution(interaction.client, raffle);
}
