import { SlashCommandBuilder } from 'discord.js';
import { isOfficer } from '../permissions.js';
import { errorEmbed } from '../ui/errorEmbed.js';
import { buildRaffleAnnouncementContent } from '../ui/raffleEmbed.js';
import { RAFFLES_PATH } from '../dataPaths.js';
import { loadRaffles, addRaffle } from '../services/rafflesStore.js';
import { scheduleRaffleResolution } from '../raffleScheduler.js';

const MIN_MINUTES = 1;
const MAX_MINUTES = 1440;

// Visible para todos en el picker de Discord a propósito: el filtro real es
// isOfficer() (OFFICER_ROLE_ID) en runtime, no un permiso de Discord por
// servidor que haya que reconfigurar a mano en cada uno.
export const data = new SlashCommandBuilder()
  .setName('sorteo')
  .setDescription('Lanza un sorteo en este canal (solo oficiales)')
  .addIntegerOption((option) =>
    option
      .setName('minutos')
      .setDescription(`Duración en minutos (${MIN_MINUTES}-${MAX_MINUTES})`)
      .setRequired(true)
      .setMinValue(MIN_MINUTES)
      .setMaxValue(MAX_MINUTES),
  )
  .addRoleOption((option) =>
    option
      .setName('rol')
      .setDescription('Restringe la participación a los miembros de este rol (opcional)')
      .setRequired(false),
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

  const minutes = interaction.options.getInteger('minutos', true);
  // Defensa en profundidad: setMinValue/setMaxValue ya lo bloquean en el
  // cliente de Discord, pero si el comando registrado quedó desactualizado
  // (deploy pendiente) esto sigue rechazándolo con un mensaje claro.
  if (!Number.isInteger(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
    await interaction.reply({
      embeds: [errorEmbed('Duración inválida', `Los minutos deben ser un entero entre ${MIN_MINUTES} y ${MAX_MINUTES}.`)],
      ephemeral: true,
    });
    return;
  }

  const requiredRole = interaction.options.getRole('rol');
  // El rol @everyone tiene el mismo id que el guild: pasarlo como filtro
  // equivale a no filtrar nada, y solo confundiría al leer el anuncio.
  if (requiredRole && requiredRole.id === interaction.guildId) {
    await interaction.reply({
      embeds: [errorEmbed('Rol inválido', 'No puedes usar @everyone como rol del sorteo: equivale a no restringir la participación.')],
      ephemeral: true,
    });
    return;
  }

  const existingRaffles = await loadRaffles(RAFFLES_PATH);
  if (existingRaffles.some((raffle) => raffle.channelId === interaction.channelId)) {
    await interaction.reply({
      embeds: [errorEmbed('Ya hay un sorteo activo', 'Solo puede haber un sorteo activo por canal. Espera a que termine.')],
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({ content: 'Sorteo creado.', ephemeral: true });

  const endsAt = Date.now() + minutes * 60_000;
  const requiredRoleId = requiredRole?.id ?? null;
  const content = buildRaffleAnnouncementContent({
    creatorId: interaction.user.id,
    endsAtUnixSeconds: Math.floor(endsAt / 1000),
    roleId: process.env.RAFFLE_ROLE_ID || null,
    requiredRoleId,
  });

  // Sin allowedMentions explícito, discord.js renderiza la mención de rol
  // pero no siempre la notifica; con rol restrictivo esa mención es la única
  // pista visible de a quién va dirigido el sorteo, así que se fuerza aquí.
  const pingRoleId = requiredRoleId ?? (process.env.RAFFLE_ROLE_ID || null);
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

  await addRaffle(RAFFLES_PATH, raffle);
  // creatorId va dentro de `raffle` (persistido arriba) — no se pasa aparte:
  // ver el comentario en resolveRaffle() sobre por qué.
  scheduleRaffleResolution(interaction.client, raffle);
}
