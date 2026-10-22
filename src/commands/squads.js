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
  describeSquad,
} from '../services/squadsStore.js';
import { mutationEmbed, infoEmbed } from '../ui/squadsEmbed.js';
import { errorEmbed } from '../ui/errorEmbed.js';
import { ensureOfficer } from '../permissions.js';
import { notifySquadMutation } from '../logChannel.js';

const READ_ONLY_SUBCOMMANDS = new Set(['list', 'show', 'find']);
const CONFIRM_TIMEOUT_MS = 30_000;
const AUTOCOMPLETE_LIMIT = 25;

// Visible para todos en el picker de Discord a propósito: el filtro real es
// ensureOfficer() (officerRoleId del servidor) en runtime, no un permiso de Discord por
// servidor que haya que reconfigurar a mano en cada uno.
export const data = new SlashCommandBuilder()
  .setName('squads')
  .setDescription('Administra los squads de jugadores y de gremio (solo oficiales)')
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
      .setDescription('Crea un squad de jugadores vacío, o uno que sigue a un gremio de Albion entero')
      .addStringOption((o) =>
        o
          .setName('name')
          .setDescription('Clave del squad; con is-guild, el nombre exacto del gremio de Albion')
          .setRequired(true),
      )
      .addBooleanOption((o) =>
        o
          .setName('is-guild')
          .setDescription('Sigue al gremio de Albion que se llama como el squad (por defecto: no)')
          .setRequired(false),
      ),
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
  );

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  if (!(await ensureOfficer(interaction))) return;

  const subcommand = interaction.options.getSubcommand();
  const ephemeral = !READ_ONLY_SUBCOMMANDS.has(subcommand);

  await interaction.deferReply({ ephemeral });

  try {
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

// Un squad de gremio con 40 personas y uno de jugadores con 40 nombres no son
// lo mismo: cada tipo en su sección y con su icono.
async function handleList(interaction) {
  const config = await loadConfig(interaction.guildId);
  const squads = config.squadOrder.map((key) => config.squads.get(key));
  const playerLines = squads
    .filter((squad) => !squad.isGuild)
    .map((squad) => `👥 **${escapeMarkdown(squad.display)}** — ${squad.members.size} jugador(es) en la lista`);
  const guildLines = squads
    .filter((squad) => squad.isGuild)
    .map((squad) => `🛡️ **${escapeMarkdown(squad.display)}** — gremio de Albion (miembros automáticos)`);

  const sections = [];
  if (playerLines.length > 0) sections.push(`__Squads de jugadores__\n${playerLines.join('\n')}`);
  if (guildLines.length > 0) sections.push(`__Gremios seguidos__\n${guildLines.join('\n')}`);

  await interaction.editReply({
    embeds: [infoEmbed({ title: 'Squads', description: sections.join('\n\n') })],
  });
}

async function handleShow(interaction) {
  const config = await loadConfig(interaction.guildId);
  const key = interaction.options.getString('squad', true).trim().toLowerCase();
  const squad = config.squads.get(key);
  if (!squad) throw new SquadCommandError(`El squad "${key}" no existe.`);

  let description;
  if (squad.isGuild) {
    description =
      `🛡️ Sigue al gremio de Albion **${escapeMarkdown(squad.guildName)}**.\n` +
      'Sus miembros se toman del gremio en cada batalla: no hay lista de nombres.';
  } else {
    const members = [...squad.members].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
    description = members.length > 0 ? members.map((name) => escapeMarkdown(name)).join('\n') : '—';
  }

  await interaction.editReply({
    embeds: [infoEmbed({ title: `Squad ${squad.display}`, description })],
  });
}

function squadLabel(key, isGuild) {
  return isGuild ? key : key.toUpperCase();
}

async function handleCreate(interaction) {
  const input = interaction.options.getString('name', true);
  const isGuild = interaction.options.getBoolean('is-guild') ?? false;
  const { report } = await createSquad(interaction.guildId, input, { isGuild });
  const label = squadLabel(report.key, report.isGuild);
  const description = report.isGuild
    ? `Sigue al gremio de Albion **${escapeMarkdown(report.key)}**: en /getkills sus miembros salen del gremio, ` +
      'en su propia sección. Ojo: renombrar el squad cambia a qué gremio sigue.'
    : 'Sin miembros todavía. Usa `/squads add` para añadir jugadores.';

  await interaction.editReply({
    embeds: [
      mutationEmbed({
        title: report.isGuild ? `Squad de gremio "${label}" creado` : `Squad "${label}" creado`,
        description,
        actorTag: interaction.user.tag,
      }),
    ],
  });

  await notifySquadMutation(interaction.client, {
    guildId: interaction.guildId,
    actorTag: interaction.user.tag,
    subcommand: 'create',
    summary: `Squad${report.isGuild ? ' de gremio' : ''} "${label}" creado. ${description}`,
  });
}

async function handleDelete(interaction) {
  const input = interaction.options.getString('squad', true);
  const key = input.trim().toLowerCase();
  const config = await loadConfig(interaction.guildId);
  const squad = config.squads.get(key);
  if (!squad) throw new SquadCommandError(`El squad "${key}" no existe.`);

  const confirmId = `squads-delete-confirm-${interaction.id}`;
  const cancelId = `squads-delete-cancel-${interaction.id}`;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(confirmId).setLabel('Confirmar borrado').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(cancelId).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
  );

  const message = await interaction.editReply({
    content: squad.isGuild
      ? `¿Seguro que quieres borrar el squad de gremio **${escapeMarkdown(squad.display)}**? Dejará de seguirse en /getkills.`
      : `¿Seguro que quieres borrar el squad **${squad.display}** (${squad.members.size} miembro(s))? Esta acción no se puede deshacer.`,
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

  const { report } = await deleteSquad(interaction.guildId, key);
  const description = report.isGuild
    ? `Ya no se sigue al gremio de Albion "${escapeMarkdown(report.key)}".`
    : `Tenía ${report.removedMembers.length} miembro(s).`;
  await buttonInteraction.update({
    content: null,
    embeds: [
      mutationEmbed({
        title: `Squad "${squadLabel(report.key, report.isGuild)}" borrado`,
        description,
        actorTag: interaction.user.tag,
      }),
    ],
    components: [],
  });

  await notifySquadMutation(interaction.client, {
    guildId: interaction.guildId,
    actorTag: interaction.user.tag,
    subcommand: 'delete',
    summary: `Squad "${squadLabel(report.key, report.isGuild)}" borrado. ${description}`,
  });
}

async function handleAdd(interaction) {
  const squadInput = interaction.options.getString('squad', true);
  const playersInput = interaction.options.getString('jugadores', true);
  const { report } = await addPlayers(interaction.guildId, squadInput, playersInput);

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
    guildId: interaction.guildId,
    actorTag: interaction.user.tag,
    subcommand: 'add',
    summary: `Squad "${report.key.toUpperCase()}": ${description}`,
  });
}

async function handleRemove(interaction) {
  const squadInput = interaction.options.getString('squad', true);
  const playerInput = interaction.options.getString('jugador', true);
  const { report } = await removePlayer(interaction.guildId, squadInput, playerInput);
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
    guildId: interaction.guildId,
    actorTag: interaction.user.tag,
    subcommand: 'remove',
    summary: `Squad "${report.key.toUpperCase()}": ${description}`,
  });
}

async function handleRename(interaction) {
  const squadInput = interaction.options.getString('squad', true);
  const newInput = interaction.options.getString('nuevo', true);

  // En un squad de gremio el nombre ES el gremio que sigue: renombrarlo
  // cambia de gremio, y eso se avisa y se confirma antes de hacerlo.
  const current = await describeSquad(interaction.guildId, squadInput);
  let reply = (payload) => interaction.editReply(payload);
  if (current.isGuild) {
    const confirmId = `squads-rename-confirm-${interaction.id}`;
    const cancelId = `squads-rename-cancel-${interaction.id}`;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(confirmId).setLabel('Cambiar de gremio').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(cancelId).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
    );
    const message = await interaction.editReply({
      content:
        `⚠️ **${escapeMarkdown(current.key)}** es un squad de gremio: su nombre es el gremio de Albion al que sigue. ` +
        `Si lo renombras a **${escapeMarkdown(newInput.trim())}**, dejará de seguir a "${escapeMarkdown(current.key)}" ` +
        `y pasará a seguir al gremio "${escapeMarkdown(newInput.trim())}". ¿Continuar?`,
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
      await interaction.editReply({ content: 'Confirmación expirada. El squad no se renombró.', components: [] });
      return;
    }
    if (buttonInteraction.customId === cancelId) {
      await buttonInteraction.update({ content: 'Renombrado cancelado.', components: [] });
      return;
    }
    await buttonInteraction.deferUpdate();
    reply = (payload) => buttonInteraction.editReply(payload);
  }

  const { report } = await renameSquad(interaction.guildId, squadInput, newInput);
  const description = report.isGuild
    ? `El squad de gremio "${report.oldKey}" ahora es "${report.newKey}": sigue al gremio de Albion "${report.newKey}".`
    : `"${report.oldKey.toUpperCase()}" ahora se llama "${report.newKey.toUpperCase()}".`;

  await reply({
    content: null,
    embeds: [mutationEmbed({ title: 'Squad renombrado', description: escapeMarkdown(description), actorTag: interaction.user.tag })],
    components: [],
  });

  await notifySquadMutation(interaction.client, {
    guildId: interaction.guildId,
    actorTag: interaction.user.tag,
    subcommand: 'rename',
    summary: description,
  });
}

async function handleMove(interaction) {
  const playerInput = interaction.options.getString('jugador', true);
  const squadInput = interaction.options.getString('squad', true);
  const { report } = await movePlayer(interaction.guildId, playerInput, squadInput);
  const description = `${escapeMarkdown(report.name)}: "${report.fromKey.toUpperCase()}" → "${report.toKey.toUpperCase()}".`;

  await interaction.editReply({
    embeds: [mutationEmbed({ title: 'Jugador movido', description, actorTag: interaction.user.tag })],
  });

  await notifySquadMutation(interaction.client, {
    guildId: interaction.guildId,
    actorTag: interaction.user.tag,
    subcommand: 'move',
    summary: description,
  });
}

async function handleFind(interaction) {
  const config = await loadConfig(interaction.guildId);
  const playerInput = interaction.options.getString('jugador', true).trim();
  const nameLower = playerInput.toLowerCase();
  const squadKey = config.playerToSquad.get(nameLower);

  const content = squadKey
    ? `**${escapeMarkdown(playerInput)}** está en el squad **${config.squads.get(squadKey).display}**.`
    : `**${escapeMarkdown(playerInput)}** no está en ningún squad conocido.`;

  await interaction.editReply({ content });
}

/**
 * @param {import('discord.js').AutocompleteInteraction} interaction
 */
export async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  const subcommand = interaction.options.getSubcommand(false);

  let config;
  try {
    config = await loadConfig(interaction.guildId);
  } catch {
    await interaction.respond([]);
    return;
  }

  let choices = [];

  if (focused.name === 'squad') {
    // create no tiene autocomplete habilitado en el builder (la clave es nueva).
    // add/remove/move solo tienen sentido sobre squads de jugadores: los de
    // gremio no tienen lista que editar.
    const playersOnly = ['add', 'remove', 'move'].includes(subcommand);
    choices = config.squadOrder
      .filter((key) => !playersOnly || !config.squads.get(key).isGuild)
      .map((key) => {
        const squad = config.squads.get(key);
        return { name: squad.isGuild ? `🛡️ ${squad.display}` : squad.display, value: key };
      });
  } else if (focused.name === 'jugador' && subcommand === 'remove') {
    const squadInput = interaction.options.getString('squad');
    const squadKey = squadInput?.trim().toLowerCase();
    const squad = squadKey ? config.squads.get(squadKey) : null;
    choices = squad ? [...squad.members].map((name) => ({ name, value: name })) : [];
  } else if (focused.name === 'jugador') {
    // find / move: cualquier jugador conocido
    choices = [...config.playerToSquad.keys()].map((name) => ({ name, value: name }));
  }

  const query = focused.value.toLowerCase();
  const filtered = choices.filter((choice) => choice.name.toLowerCase().includes(query)).slice(0, AUTOCOMPLETE_LIMIT);

  await interaction.respond(filtered);
}
