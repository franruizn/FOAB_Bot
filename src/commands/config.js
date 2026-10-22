import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  InteractionContextType,
  ChannelType,
  escapeMarkdown,
} from 'discord.js';
import { getConfig, updateConfig, defaultConfig, ALBION_SERVERS } from '../services/guildStore.js';
import { CONFIG_FIELDS, fieldBySub } from '../services/configFields.js';
import { loadConfig, isValidGuildName, MAX_GUILD_NAME_LENGTH } from '../services/config.js';
import { getGuildAttendance, AlbionbbApiError } from '../services/albionbbApi.js';
import { isAdministrator } from '../permissions.js';
import { notifyConfigChange } from '../logChannel.js';
import { buildConfigViewEmbed, buildConfigChangeEmbed, formatValue } from '../ui/configEmbed.js';
import { errorEmbed } from '../ui/errorEmbed.js';

const LOG_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
// Lo que necesita el bot en el canal de logs: los avisos son embeds y los
// textos largos de /dm van como fichero adjunto.
const LOG_CHANNEL_PERMISSIONS = [
  [PermissionFlagsBits.ViewChannel, 'Ver canal'],
  [PermissionFlagsBits.SendMessages, 'Enviar mensajes'],
  [PermissionFlagsBits.EmbedLinks, 'Insertar enlaces'],
  [PermissionFlagsBits.AttachFiles, 'Adjuntar archivos'],
];
const ALBIONBB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// Quien copia la URL de la página del gremio en albionbb en vez del id:
// https://europe.albionbb.com/guilds/<id>/attendance
const ALBIONBB_URL_ID_PATTERN = /\/guilds\/([A-Za-z0-9_-]+)/;
const ALBIONBB_CHECK_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Entrada de /config que no se puede guardar: se explica y no se toca nada. */
class ConfigInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigInputError';
  }
}

// Solo para tests: comprobar un id en albionbb sin salir a la red.
let albionbbCheckImpl = (server, albionbbGuildId) => {
  const end = new Date();
  const start = new Date(end.getTime() - ALBIONBB_CHECK_DAYS * DAY_MS);
  return getGuildAttendance(server, albionbbGuildId, {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  });
};
export function __setAlbionbbCheckForTests(fn) {
  albionbbCheckImpl = fn;
}

// Administrador y no rol de oficiales: en un servidor recién añadido no hay
// rol de oficiales que exigir. setDefaultMemberPermissions solo lo esconde
// del picker (y se puede sobrescribir en los ajustes del servidor); el
// filtro real es isAdministrator() en runtime.
export const data = new SlashCommandBuilder()
  .setName('config')
  .setDescription('Configura el bot en este servidor (solo administradores)')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) => sub.setName('ver').setDescription('Muestra la configuración actual y lo que falta'))
  .addSubcommand((sub) =>
    sub
      .setName('oficial')
      .setDescription('Rol de oficiales: puede usar /squads, /sorteo, /crear-rol y /health')
      .addRoleOption((o) => o.setName('rol').setDescription('Rol de oficiales').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('logs')
      .setDescription('Canal donde el bot deja constancia de cambios y errores')
      .addChannelOption((o) =>
        o.setName('canal').setDescription('Canal de texto').setRequired(true).addChannelTypes(...LOG_CHANNEL_TYPES),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('sorteo-rol')
      .setDescription('Rol al que /sorteo menciona al anunciar un sorteo (opcional)')
      .addRoleOption((o) => o.setName('rol').setDescription('Rol a mencionar').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('dm-optout')
      .setDescription('Rol cuyos miembros no reciben /dm (opcional)')
      .addRoleOption((o) => o.setName('rol').setDescription('Rol de exclusión').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('servidor')
      .setDescription('Servidor de Albion del gremio')
      .addStringOption((o) =>
        o
          .setName('servidor')
          .setDescription('Servidor de Albion')
          .setRequired(true)
          .addChoices(...[...ALBION_SERVERS].map((server) => ({ name: server, value: server }))),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('gremio')
      .setDescription('Gremio principal de Albion (uno solo; los demás, con /squads create)')
      .addStringOption((o) =>
        o.setName('nombre').setDescription('Nombre exacto del gremio en Albion').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('albionbb')
      .setDescription('Id del gremio en albionbb, para /attendance')
      .addStringOption((o) =>
        o.setName('id').setDescription('Id del gremio (o la URL de su página en albionbb)').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('reset')
      .setDescription('Vuelve un campo a su valor por defecto')
      .addStringOption((o) =>
        o
          .setName('campo')
          .setDescription('Campo a resetear')
          .setRequired(true)
          .addChoices(...CONFIG_FIELDS.map((field) => ({ name: field.sub, value: field.sub }))),
      ),
  );

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  if (!isAdministrator(interaction)) {
    await interaction.reply({
      embeds: [
        errorEmbed('Sin permiso', 'Este comando es solo para quien tiene el permiso de Administrador en este servidor.'),
      ],
      ephemeral: true,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  await interaction.deferReply({ ephemeral: true });

  if (subcommand === 'ver') {
    const config = await getConfig(interaction.guildId);
    await interaction.editReply({ embeds: [buildConfigViewEmbed({ config, guild: interaction.guild })] });
    return;
  }

  try {
    if (subcommand === 'reset') {
      const field = fieldBySub(interaction.options.getString('campo', true));
      if (!field) throw new ConfigInputError('Ese campo no existe.');
      await applyChange(interaction, field, defaultConfig(interaction.guildId)[field.key]);
      return;
    }

    const field = fieldBySub(subcommand);
    if (!field) throw new Error(`Subcomando desconocido: ${subcommand}`);
    const { value, note } = await VALIDATORS[field.sub](interaction);
    await applyChange(interaction, field, value, note);
  } catch (error) {
    if (error instanceof ConfigInputError) {
      await interaction.editReply({ embeds: [errorEmbed('No se ha cambiado nada', error.message)] });
      return;
    }
    throw error;
  }
}

/**
 * Guarda el campo (escritura atómica, bajo el candado de config.json), lo
 * deja registrado en el canal de logs y responde con el antes y el después.
 */
async function applyChange(interaction, field, value, note = null) {
  const { guildId } = interaction;
  if ((await getConfig(guildId))[field.key] === value) {
    await interaction.editReply({
      embeds: [errorEmbed('No ha cambiado nada', `${field.label} ya era ${formatValue(field, value)}.`)],
    });
    return;
  }

  const { previous, config } = await updateConfig(guildId, {
    [field.key]: value,
    configuradoEn: new Date().toISOString(),
    configuradoPor: interaction.user.id,
  });
  const before = formatValue(field, previous[field.key]);
  const after = formatValue(field, value);

  await notifyConfigChange(interaction.client, {
    guildId,
    actorTag: interaction.user.tag,
    actorId: interaction.user.id,
    label: field.label,
    before,
    after,
    // Al quitar el canal de logs, el aviso va al que deja de serlo: si no,
    // ese cambio sería justo el único sin rastro.
    logChannelId: field.key === 'logChannelId' && !value ? previous.logChannelId ?? undefined : undefined,
  });

  await interaction.editReply({
    embeds: [buildConfigChangeEmbed({ label: field.label, before, after, note, config, guild: interaction.guild })],
  });
}

// --- validación por subcomando: devuelven { value, note } o lanzan ConfigInputError ---

function validateRole(interaction, what) {
  const role = interaction.options.getRole('rol', true);
  // El rol @everyone tiene el mismo id que el servidor.
  if (role.id === interaction.guildId) {
    throw new ConfigInputError(`@everyone no puede ser ${what}: elige un rol concreto.`);
  }
  if (role.managed) {
    throw new ConfigInputError(
      `${role.name} lo gestiona una integración (un bot o una suscripción): no se le puede dar a nadie a mano. Elige otro rol.`,
    );
  }
  return { value: role.id, note: null };
}

async function validateLogChannel(interaction) {
  const option = interaction.options.getChannel('canal', true);
  const channel = await interaction.guild.channels.fetch(option.id).catch(() => null);
  if (!channel || !LOG_CHANNEL_TYPES.includes(channel.type)) {
    throw new ConfigInputError('El canal de logs tiene que ser un canal de texto (o de anuncios) de este servidor.');
  }

  const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe());
  const permissions = channel.permissionsFor(me);
  const missing = LOG_CHANNEL_PERMISSIONS.filter(([flag]) => !permissions?.has(flag)).map(([, name]) => name);
  if (missing.length > 0) {
    throw new ConfigInputError(
      `No puedo escribir en <#${channel.id}>: me falta ${missing.map((name) => `**${name}**`).join(', ')} en ese canal. ` +
        'Dame esos permisos y vuelve a intentarlo.',
    );
  }
  return { value: channel.id, note: null };
}

async function validateAlbionServer(interaction) {
  const server = interaction.options.getString('servidor', true);
  if (!ALBION_SERVERS.has(server)) {
    throw new ConfigInputError(`El servidor de Albion tiene que ser uno de: ${[...ALBION_SERVERS].join(', ')}.`);
  }
  const { albionbbGuildId } = await getConfig(interaction.guildId);
  return {
    value: server,
    note: albionbbGuildId
      ? 'El id de albionbb es de un servidor concreto: si el gremio no está en este, cámbialo con `/config albionbb`.'
      : null,
  };
}

async function validateMainGuild(interaction) {
  const input = interaction.options.getString('nombre', true);
  if (input.includes(',')) {
    throw new ConfigInputError(
      '`/config gremio` acepta un solo gremio: el principal. Los demás se siguen como squads de gremio, ' +
        'uno a uno, con `/squads create name:<gremio> is-guild:true`.',
    );
  }

  const name = input.trim();
  if (!isValidGuildName(name)) {
    throw new ConfigInputError(`El nombre del gremio tiene que tener entre 1 y ${MAX_GUILD_NAME_LENGTH} caracteres.`);
  }

  // El gremio principal ya es MAIN ZERG: si además hubiera un squad de
  // gremio siguiéndolo, /getkills contaría a todos dos veces.
  const squads = await loadConfig(interaction.guildId);
  const clash = squads.guildToSquad.get(name.toLowerCase());
  if (clash) {
    throw new ConfigInputError(
      `Ya hay un squad de gremio que sigue a **${escapeMarkdown(squads.squads.get(clash).display)}**. Como gremio ` +
        'principal contaría a todos dos veces: bórralo antes con `/squads delete`.',
    );
  }

  return {
    value: name,
    note: 'Tiene que coincidir exactamente con el nombre del gremio en Albion, mayúsculas y espacios incluidos.',
  };
}

async function validateAlbionbbId(interaction) {
  const input = interaction.options.getString('id', true).trim();
  const id = input.match(ALBIONBB_URL_ID_PATTERN)?.[1] ?? input;
  if (!ALBIONBB_ID_PATTERN.test(id)) {
    throw new ConfigInputError(
      'Eso no parece un id de albionbb. Sale en la URL de la página del gremio: ' +
        '`https://europe.albionbb.com/guilds/<id>/...`. También puedes pegar la URL entera.',
    );
  }

  const { albionServer } = await getConfig(interaction.guildId);
  try {
    await albionbbCheckImpl(albionServer, id);
  } catch (error) {
    if (error instanceof AlbionbbApiError && error.status === 404) {
      throw new ConfigInputError(
        `albionbb no tiene ningún gremio con id \`${id}\` en el servidor **${albionServer}**. Revisa el id o, si el ` +
          'gremio es de otro servidor, cámbialo antes con `/config servidor`.',
      );
    }
    console.error(`[config] No se pudo comprobar el id de albionbb ${id} (${albionServer}):`, error);
    return { value: id, note: '⚠️ albionbb no responde ahora mismo: no he podido comprobar el id, se guarda igualmente.' };
  }
  return { value: id, note: null };
}

const VALIDATORS = {
  oficial: (interaction) => validateRole(interaction, 'el rol de oficiales'),
  logs: validateLogChannel,
  'sorteo-rol': (interaction) => validateRole(interaction, 'el rol de sorteos'),
  'dm-optout': (interaction) => validateRole(interaction, 'el rol de exclusión de /dm'),
  servidor: validateAlbionServer,
  gremio: validateMainGuild,
  albionbb: validateAlbionbbId,
};
