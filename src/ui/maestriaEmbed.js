import { EmbedBuilder } from 'discord.js';
import { nivelDeVeces, estrellasTexto } from '../services/maestria.js';

// Propio, distinto del verde del embed de CTA y del dorado del DM de
// asignación: /maestria es una consulta aparte, no parte del ciclo de vida
// de un evento concreto.
const EMBED_COLOR = 0x9b59b6;

function nombreDeRol(rolKey, rolInfo) {
  if (!rolInfo) return rolKey;
  return rolInfo.emoji ? `${rolInfo.emoji} ${rolInfo.nombre}` : rolInfo.nombre;
}

/**
 * Embed de "mis armas": roles jugados por un jugador, de más a menos veces
 * jugadas, con sus estrellas (nunca el número crudo) y cuándo la jugó por
 * última vez.
 * @param {object} params
 * @param {string} params.nombre - nombre a mostrar en el título
 * @param {{ roles: Record<string, number>, ultimo: Record<string, string> } | null} params.jugador - entrada de maestria.jugadores[userId], o null si no tiene historial
 * @param {(rolKey: string) => { nombre: string, emoji: string } | null} params.resolverRol
 * @returns {EmbedBuilder}
 */
export function buildJugadorEmbed({ nombre, jugador, resolverRol }) {
  const embed = new EmbedBuilder().setColor(EMBED_COLOR).setTitle(`🗡️ Maestría de ${nombre}`);

  const roles = Object.entries(jugador?.roles ?? {})
    .filter(([, veces]) => veces > 0)
    .sort(([, a], [, b]) => b - a);

  if (roles.length === 0) {
    embed.setDescription('Sin historial todavía: no ha cerrado ninguna CTA con un rol asignado.');
    return embed;
  }

  const lineas = roles.map(([rolKey, veces]) => {
    const estrellas = estrellasTexto(nivelDeVeces(veces));
    const ultimo = jugador.ultimo?.[rolKey];
    const ultimoTexto = ultimo ? ` — última vez <t:${Math.floor(new Date(ultimo).getTime() / 1000)}:R>` : '';
    const sufijoEstrellas = estrellas ? ` ${estrellas}` : '';
    return `${nombreDeRol(rolKey, resolverRol(rolKey))}${sufijoEstrellas}${ultimoTexto}`;
  });

  embed.setDescription(lineas.join('\n'));
  return embed;
}

/**
 * Ranking de los jugadores con más maestría en un rol concreto: la
 * respuesta a "¿a quién llamo para santi?".
 * @param {object} params
 * @param {string} params.rolKey
 * @param {{ nombre: string, emoji: string } | null} params.rolInfo
 * @param {Array<{ userId: string, veces: number }>} params.ranking - ya ordenado y limitado por quien llama
 * @returns {EmbedBuilder}
 */
export function buildRankingEmbed({ rolKey, rolInfo, ranking }) {
  const embed = new EmbedBuilder().setColor(EMBED_COLOR).setTitle(`🏆 Ranking de maestría — ${nombreDeRol(rolKey, rolInfo)}`);

  if (ranking.length === 0) {
    embed.setDescription('Nadie tiene historial todavía en ese rol.');
    return embed;
  }

  const lineas = ranking.map((r, i) => {
    const estrellas = estrellasTexto(nivelDeVeces(r.veces));
    return `**${i + 1}.** <@${r.userId}>${estrellas ? ` ${estrellas}` : ''}`;
  });

  embed.setDescription(lineas.join('\n'));
  return embed;
}
