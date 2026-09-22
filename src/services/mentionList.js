// Resuelve la lista de personas de /crear-rol. En un parámetro de texto de
// slash command, "@nombre" NO es una mención real: llega como la cadena
// literal "@nombre". Solo cuando alguien elige la sugerencia del
// autocompletado de Discord llega como "<@id>" o "<@!id>". Por eso hay que
// aceptar y resolver las dos formas.

const MENTION_REGEX = /^<@!?(\d+)>$/;

/**
 * Separa la lista en tokens: por espacios en blanco y por comas (los
 * nombres de usuario de Discord no llevan espacios, así que es seguro), sin
 * dejar tokens vacíos aunque haya comas o espacios dobles.
 * @param {string} text
 * @returns {string[]}
 */
export function parseMentionListTokens(text) {
  return String(text ?? '')
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/**
 * Resuelve cada token contra los miembros del guild:
 * - "<@id>" / "<@!id>" se usa directamente como id.
 * - "@nombre" se resuelve por NOMBRE DE USUARIO (único y en minúsculas desde
 *   2023), nunca por apodo ni display name, y por igualdad exacta en
 *   minúsculas — nunca por inclusión, para que "@topo" no case con
 *   "_hanstopo" ni "mistertopo".
 * Deduplica por id de miembro resuelto (dos tokens distintos pueden apuntar
 * a la misma persona) y descarta bots en silencio: no son un error de
 * ortografía que revisar, son gente que nunca debía entrar.
 * @param {string} text
 * @param {{ get: (id: string) => unknown, values: () => Iterable<unknown> }} members
 *   Colección de GuildMember (o un doble de test), duck-typed: solo hace
 *   falta member.id, member.user.username y member.user.bot.
 * @returns {{ resolved: unknown[], unresolved: string[] }}
 */
export function resolveMentionList(text, members) {
  const tokens = parseMentionListTokens(text);

  const byUsername = new Map();
  for (const member of members.values()) {
    byUsername.set(member.user.username.toLowerCase(), member);
  }

  const resolvedById = new Map();
  const unresolved = [];

  for (const token of tokens) {
    const mentionMatch = token.match(MENTION_REGEX);
    const member = mentionMatch
      ? (members.get(mentionMatch[1]) ?? null)
      : (byUsername.get((token.startsWith('@') ? token.slice(1) : token).toLowerCase()) ?? null);

    if (!member) {
      if (!unresolved.includes(token)) unresolved.push(token);
      continue;
    }
    if (member.user.bot) continue;

    resolvedById.set(member.id, member);
  }

  return { resolved: [...resolvedById.values()], unresolved };
}
