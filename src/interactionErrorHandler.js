import { InvalidLinkError } from './services/albionbb.js';
import { AlbionApiError } from './services/albionApi.js';
import { AlbionbbApiError } from './services/albionbbApi.js';
import { ConfigError } from './services/config.js';
import { SheetsError } from './services/sheets.js';
import { errorEmbed } from './ui/errorEmbed.js';
import { isOfficer } from './permissions.js';

/**
 * Clasifica un error y arma el embed correspondiente. Los errores "conocidos"
 * (entrada de usuario o fallos esperados de la API) se loguean en una línea;
 * cualquier error no reconocido se loguea con el stack completo, ya que ahí
 * sí puede tratarse de un bug real. `known: false` marca justo ese último
 * caso, para que el llamador decida si avisa por LOG_CHANNEL_ID.
 * @returns {{ embed: import('discord.js').EmbedBuilder, officerOnly: boolean, known: boolean }}
 */
function classifyError(error) {
  if (error instanceof InvalidLinkError) {
    console.error(`InvalidLinkError: ${error.message}`);
    return {
      embed: errorEmbed(
        'Enlace de albionbb no válido',
        `${error.message}\n\nEjemplo válido: \`https://europe.albionbb.com/battles/418186013\``,
      ),
      officerOnly: false,
      known: true,
    };
  }

  if (error instanceof AlbionApiError && error.status === 404) {
    console.error(`AlbionApiError 404 (battleId=${error.battleId})`);
    return {
      embed: errorEmbed('Batalla no encontrada', 'No se encontró esa batalla en la API oficial.'),
      officerOnly: false,
      known: true,
    };
  }

  if (error instanceof AlbionApiError && error.status >= 500) {
    console.error(`AlbionApiError ${error.status} (battleId=${error.battleId})`);
    return {
      embed: errorEmbed('API de Albion no disponible', 'La API de Albion no responde, inténtalo en un minuto.'),
      officerOnly: false,
      known: true,
    };
  }

  if (error instanceof AlbionbbApiError && error.status === 404) {
    console.error(`AlbionbbApiError 404 (guildId=${error.guildId})`);
    return {
      embed: errorEmbed('Gremio no encontrado en albionbb', 'No se encontró ese gremio en albionbb.'),
      officerOnly: false,
      known: true,
    };
  }

  if (error instanceof AlbionbbApiError) {
    console.error(`AlbionbbApiError ${error.status} (guildId=${error.guildId})`);
    return {
      embed: errorEmbed('albionbb no disponible', 'albionbb no responde ahora mismo, inténtalo más tarde.'),
      officerOnly: false,
      known: true,
    };
  }

  if (error instanceof ConfigError) {
    console.error(`ConfigError (${error.reason}) en "${error.path}": ${error.message}`);
    return {
      embed: errorEmbed('Error de configuración', error.message),
      officerOnly: true,
      known: true,
    };
  }

  if (error instanceof SheetsError) {
    console.error(`SheetsError${error.status ? ` (${error.status})` : ''}: ${error.message}`);
    return {
      embed: errorEmbed('No se pudo sincronizar con la hoja', error.message),
      officerOnly: true,
      known: true,
    };
  }

  console.error('Error inesperado en interacción:', error.stack ?? error);
  return {
    embed: errorEmbed(
      'Ha ocurrido un error inesperado',
      'Inténtalo de nuevo en unos minutos. Si el problema persiste, avisa a un oficial.',
    ),
    officerOnly: false,
    known: false,
  };
}

/**
 * Maneja cualquier error lanzado durante la ejecución de un comando: clasifica
 * el error, construye el embed adecuado (ocultando detalle técnico de
 * ConfigError a quien no sea oficial) y responde por el canal correcto según
 * el estado de la interacción.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {unknown} error
 * @returns {Promise<{ known: boolean }>} known=false si el error cayó en el genérico (no tipado)
 */
export async function handleInteractionError(interaction, error) {
  const { embed, officerOnly, known } = classifyError(error);

  const visibleEmbed =
    officerOnly && !isOfficer(interaction)
      ? errorEmbed('Ha ocurrido un error', 'Ha ocurrido un error de configuración. Contacta a un oficial.')
      : embed;

  const replyPayload = { embeds: [visibleEmbed], ephemeral: true };

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(replyPayload);
  } else {
    await interaction.reply(replyPayload);
  }

  return { known };
}
