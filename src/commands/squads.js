import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, escapeMarkdown } from 'discord.js';
import { loadConfig, ConfigError } from '../services/config.js';
import {
  SquadCommandError,
  createSquad,
  deleteSquad,
  addPlayers,
  removePlayer,
  renameSquad,
  movePlayer,
  addGuild,
  removeGuild,
} from '../services/squadsStore.js';
import { mutationEmbed, infoEmbed } from '../ui/squadsEmbed.js';
import { errorEmbed } from '../ui/errorEmbed.js';
import { isOfficer } from '../permissions.js';
import { SQUADS_CONFIG_PATH } from '../dataPaths.js';
import { notifySquadMutation } from '../logChannel.js';

const READ_ONLY_SUBCOMMANDS = new Set(['list', 'show', 'find']);
const CONFIRM_TIMEOUT_MS = 30_000;
const AUTOCOMPLETE_LIMIT = 25;

// Visible para todos en el picker de Discord a propósito: el filtro real es
// isOfficer() (OFFICER_ROLE_ID) en runtime, no un permiso de Discord por
// servidor que haya que reconfigurar a mano en cada uno.
export const data = new SlashCommandBuilder()
  .setName('squads')
  .setDescription('Administra los squads y gremios trackeados (solo oficiales)')
  .addSubcommand((sub) => sub.setName('list').setDescription('Lista todos los squads con su número de miembros'))
  .addSubcommand((sub) =>
    sub
      .setName('show')
      .setDescription('Muestra los miembros de un squad')
      .addStringOption((o) => o.setName('squad').setDescription('Squad').setRequired(true).setAutocomplete(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Crea un squad vacío')
      .addStringOption((o) => o.setName('squad').setDescription('Clave del nuevo squad').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('delete')
      .setDescription('Borra un squad (pide confirmación)')
      .addStringOption((o) => o.setName('squad').setDescription('Squad').setRequired(true).setAutocomplete(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Añade uno o varios jugadores a un squad')
      .addStringOption((o) => o.setName('squad').setDescription('Squad').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('jugadores').setDescription('Nombres separados por coma').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Quita un jugador de un squad')
      .addStringOption((o) => o.setName('squad').setDescription('Squad').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('jugador').setDescription('Jugador').setRequired(true).setAutocomplete(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('rename')
      .setDescription('Renombra un squad conservando sus miembros')
      .addStringOption((o) => o.setName('squad').setDescription('Squad actual').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('nuevo').setDescription('Nueva clave').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('move')
      .setDescription('Mueve a un jugador a otro squad')
      .addStringOption((o) => o.setName('jugador').setDescription('Jugador').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('squad').setDescription('Squad destino').setRequired(true).setAutocomplete(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('find')
      .setDescription('Dice en qué squad está un jugador')
      .addStringOption((o) => o.setName('jugador').setDescription('Jugador').setRequired(true).setAutocomplete(true)),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('guild')
      .setDescription('Gestiona las grafías de gremio trackeadas')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Añade una grafía de gremio')
          .addStringOption((o) => o.setName('nombre').setDescription('Nombre del gremio').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Quita una grafía de gremio')
          .addStringOption((o) =>
            o.setName('nombre').setDescription('Nombre del gremio').setRequired(true).setAutocomplete(true),
          ),
      ),
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

  const subcommand = interaction.options.getSubcommand();
  const group = interaction.options.getSubcommandGroup(false);
  const ephemeral = !READ_ONLY_SUBCOMMANDS.has(subcommand);

  await interaction.deferReply({ ephemeral });

  try {
    if (group === 'guild') {
      await handleGuildSubcommand(interaction, subcommand);
      return;
    }

    switch (subcommand) {
      case 'list':
        await handleList(interaction);
        return;
      case 'show':
        await handleShow(interaction);
        return;
      case 'create':
        await handleCreate(interaction);
        return;
      case 'delete':
        await handleDelete(interaction);
        return;
      case 'add':
        await handleAdd(interaction);
        return;
      case 'remove':
        await handleRemove(interaction);
        return;
      case 'rename':
        await handleRename(interaction);
        return;
      case 'move':
        await handleMove(interaction);
        return;
      case 'find':
        await handleFind(interaction);
        return;
      default:
        throw new Error(`Subcomando desconocido: ${subcommand}`);
    }
  } catch (error) {
    // SquadCommandError (validación de entrada) y ConfigError (el resultado
    // de la mutación no pasó el validador de config.js) son errores
    // esperados y accionables por quien ejecuta el comando: se muestran tal
    // cual, sin pasar por el handler genérico de src/interactionErrorHandler.js.
    if (error instanceof SquadCommandError || error instanceof ConfigError) {
      await interaction.editReply({
        content: null,
        embeds: [errorEmbed('No se pudo completar la operación', error.message)],
        components: [],
      });
      return;
    }
    throw error;
  }
}

async function handleList(interaction) {
  const config = await loadConfig(SQUADS_CONFIG_PATH);
  const lines = config.squadOrder.map((key) => {
    const squad = config.squads.get(key);
    return `**${squad.display}** — ${squad.members.size} miembro(s)`;
  });

  await interaction.editReply({
    embeds: [infoEmbed({ title: 'Squads', description: lines.join('\n') })],
  });
}

async function handleShow(interaction) {
  const config = await loadConfig(SQUADS_CONFIG_PATH);
  const key = interaction.options.getString('squad', true).trim().toLowerCase();
  const squad = config.squads.get(key);
  if (!squad) throw new SquadCommandError(`El squad "${key}" no existe.`);

  const members = [...squad.members].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  const description = members.length > 0 ? members.map((name) => escapeMarkdown(name)).join('\n') : '—';

  await interaction.editReply({
    embeds: [infoEmbed({ title: `Squad ${squad.display}`, description })],
  });
}

async function handleCreate(interaction) {
  const input = interaction.options.getString('squad', true);
  const { report } = await createSquad(SQUADS_CONFIG_PATH, input);
  const description = 'Sin miembros todavía. Usa `/squads add` para añadir jugadores.';

  await interaction.editReply({
    embeds: [
      mutationEmbed({
        title: `Squad "${report.key.toUpperCase()}" creado`,
        description,
        actorTag: interaction.user.tag,
      }),
    ],
  });

  await notifySquadMutation(interaction.client, {
    actorTag: interaction.user.tag,
    subcommand: 'create',
    summary: `Squad "${report.key.toUpperCase()}" creado. ${description}`,
  });
}

async function handleDelete(interaction) {
  const input = interaction.options.getString('squad', true);
  const key = input.trim().toLowerCase();
  const config = await loadConfig(SQUADS_CONFIG_PATH);
  const squad = config.squads.get(key);
  if (!squad) throw new SquadCommandError(`El squad "${key}" no existe.`);

  const confirmId = `squads-delete-confirm-${interaction.id}`;
  const cancelId = `squads-delete-cancel-${interaction.id}`;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(confirmId).setLabel('Confirmar borrado').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(cancelId).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
  );

  const message = await interaction.editReply({
    content: `¿Seguro que quieres borrar el squad **${squad.display}** (${squad.members.size} miembro(s))? Esta acción no se puede deshacer.`,
    embeds: [],
    components: [row],
  });

  let buttonInteraction;
  try {
    buttonInteraction = await message.awaitMessageComponent({
      filter: (i) => i.user.id === interaction.user.id,
      time: CONFIRM_TIMEOUT_MS,
    });
  } catch {
    await interaction.editReply({ content: 'Confirmación expirada. El squad no se borró.', components: [] });
    return;
  }

  if (buttonInteraction.customId === cancelId) {
    await buttonInteraction.update({ content: 'Borrado cancelado.', components: [] });
    return;
  }

  const { report } = await deleteSquad(SQUADS_CONFIG_PATH, key);
  const description = `Tenía ${report.removedMembers.length} miembro(s).`;
  await buttonInteraction.update({
    content: null,
    embeds: [
      mutationEmbed({
        title: `Squad "${report.key.toUpperCase()}" borrado`,
        description,
        actorTag: interaction.user.tag,
      }),
    ],
    components: [],
  });

  await notifySquadMutation(interaction.client, {
    actorTag: interaction.user.tag,
    subcommand: 'delete',
    summary: `Squad "${report.key.toUpperCase()}" borrado. ${description}`,
  });
}

async function handleAdd(interaction) {
  const squadInput = interaction.options.getString('squad', true);
  const playersInput = interaction.options.getString('jugadores', true);
  const { report } = await addPlayers(SQUADS_CONFIG_PATH, squadInput, playersInput);

  const lines = [];
  if (report.added.length > 0) {
    lines.push(`Añadido(s): ${report.added.map((name) => escapeMarkdown(name)).join(', ')}`);
  }
  if (report.alreadyInSquad.length > 0) {
    lines.push(`Ya estaban en el squad (ignorados): ${report.alreadyInSquad.map((name) => escapeMarkdown(name)).join(', ')}`);
  }
  for (const { name, otherSquad } of report.crossSquadWarnings) {
    lines.push(
      `⚠️ ${escapeMarkdown(name)} también está en "${otherSquad.toUpperCase()}". Si fue un error, usa ` +
        `\`/squads move jugador:${name} squad:${report.key}\`.`,
    );
  }

  const description = lines.join('\n') || 'Sin cambios.';
  await interaction.editReply({
    embeds: [
      mutationEmbed({
        title: `Squad "${report.key.toUpperCase()}" actualizado`,
        description,
        actorTag: interaction.user.tag,
      }),
    ],
  });

  await notifySquadMutation(interaction.client, {
    actorTag: interaction.user.tag,
    subcommand: 'add',
    summary: `Squad "${report.key.toUpperCase()}": ${description}`,
  });
}

async function handleRemove(interaction) {
  const squadInput = interaction.options.getString('squad', true);
  const playerInput = interaction.options.getString('jugador', true);
  const { report } = await removePlayer(SQUADS_CONFIG_PATH, squadInput, playerInput);
  const description = `Se quitó a ${escapeMarkdown(report.removedName)}.`;

  await interaction.editReply({
    embeds: [
      mutationEmbed({
        title: `Squad "${report.key.toUpperCase()}" actualizado`,
        description,
        actorTag: interaction.user.tag,
      }),
    ],
  });

  await notifySquadMutation(interaction.client, {
    actorTag: interaction.user.tag,
    subcommand: 'remove',
    summary: `Squad "${report.key.toUpperCase()}": ${description}`,
  });
}

async function handleRename(interaction) {
  const squadInput = interaction.options.getString('squad', true);
  const newInput = interaction.options.getString('nuevo', true);
  const { report } = await renameSquad(SQUADS_CONFIG_PATH, squadInput, newInput);
  const description = `"${report.oldKey.toUpperCase()}" ahora se llama "${report.newKey.toUpperCase()}".`;

  await interaction.editReply({
    embeds: [mutationEmbed({ title: 'Squad renombrado', description, actorTag: interaction.user.tag })],
  });

  await notifySquadMutation(interaction.client, {
    actorTag: interaction.user.tag,
    subcommand: 'rename',
    summary: description,
  });
}

async function handleMove(interaction) {
  const playerInput = interaction.options.getString('jugador', true);
  const squadInput = interaction.options.getString('squad', true);
  const { report } = await movePlayer(SQUADS_CONFIG_PATH, playerInput, squadInput);
  const description = `${escapeMarkdown(report.name)}: "${report.fromKey.toUpperCase()}" → "${report.toKey.toUpperCase()}".`;

  await interaction.editReply({
    embeds: [mutationEmbed({ title: 'Jugador movido', description, actorTag: interaction.user.tag })],
  });

  await notifySquadMutation(interaction.client, {
    actorTag: interaction.user.tag,
    subcommand: 'move',
    summary: description,
  });
}

async function handleFind(interaction) {
  const config = await loadConfig(SQUADS_CONFIG_PATH);
  const playerInput = interaction.options.getString('jugador', true).trim();
  const nameLower = playerInput.toLowerCase();
  const squadKey = config.playerToSquad.get(nameLower);

  const content = squadKey
    ? `**${escapeMarkdown(playerInput)}** está en el squad **${config.squads.get(squadKey).display}**.`
    : `**${escapeMarkdown(playerInput)}** no está en ningún squad conocido.`;

  await interaction.editReply({ content });
}

async function handleGuildSubcommand(interaction, subcommand) {
  const name = interaction.options.getString('nombre', true);

  if (subcommand === 'add') {
    const { report } = await addGuild(SQUADS_CONFIG_PATH, name);
    const description = `Se añadió "${escapeMarkdown(report.name)}" a la lista de gremios trackeados.`;
    await interaction.editReply({
      embeds: [mutationEmbed({ title: 'Gremio añadido', description, actorTag: interaction.user.tag })],
    });
    await notifySquadMutation(interaction.client, {
      actorTag: interaction.user.tag,
      subcommand: 'guild add',
      summary: description,
    });
    return;
  }

  if (subcommand === 'remove') {
    const { report } = await removeGuild(SQUADS_CONFIG_PATH, name);
    const description = `Se quitó "${escapeMarkdown(report.name)}" de la lista de gremios trackeados.`;
    await interaction.editReply({
      embeds: [mutationEmbed({ title: 'Gremio eliminado', description, actorTag: interaction.user.tag })],
    });
    await notifySquadMutation(interaction.client, {
      actorTag: interaction.user.tag,
      subcommand: 'guild remove',
      summary: description,
    });
    return;
  }

  throw new Error(`Subcomando de guild desconocido: ${subcommand}`);
}

/**
 * @param {import('discord.js').AutocompleteInteraction} interaction
 */
export async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  const subcommand = interaction.options.getSubcommand(false);
  const group = interaction.options.getSubcommandGroup(false);

  let config;
  try {
    config = await loadConfig(SQUADS_CONFIG_PATH);
  } catch {
    await interaction.respond([]);
    return;
  }

  let choices = [];

  if (focused.name === 'squad') {
    // create no tiene autocomplete habilitado en el builder (la clave es nueva).
    choices = config.squadOrder.map((key) => ({ name: config.squads.get(key).display, value: key }));
  } else if (focused.name === 'jugador' && subcommand === 'remove') {
    const squadInput = interaction.options.getString('squad');
    const squadKey = squadInput?.trim().toLowerCase();
    const squad = squadKey ? config.squads.get(squadKey) : null;
    choices = squad ? [...squad.members].map((name) => ({ name, value: name })) : [];
  } else if (focused.name === 'jugador') {
    // find / move: cualquier jugador conocido
    choices = [...config.playerToSquad.keys()].map((name) => ({ name, value: name }));
  } else if (focused.name === 'nombre' && group === 'guild') {
    // guild add no tiene autocomplete habilitado (nombre nuevo); solo remove.
    choices = [...config.guilds].map((name) => ({ name, value: name }));
  }

  const query = focused.value.toLowerCase();
  const filtered = choices.filter((choice) => choice.name.toLowerCase().includes(query)).slice(0, AUTOCOMPLETE_LIMIT);

  await interaction.respond(filtered);
}
