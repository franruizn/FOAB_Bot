// Resuelve lo que escribe un oficial en un slash command (":maza:", un
// emoji unicode pegado, o ya la forma completa "<:maza:123>") a la forma
// completa que Discord necesita para RENDERIZAR un emoji dentro de un
// embed. En el cuadro de mensaje normal, ":maza:" se autocompleta solo; en
// las opciones de un slash command NO — el bot recibe el texto literal, y
// ese texto literal es justo lo que se ve si no se resuelve aquí.
//
// Sin dependencia de discord.js: recibe un `guild` duck-typed
// ({ emojis: { cache: <Map-like con .find()> } }), para poder testear sin
// un client real.

const PATRON_CODIGO = /^:([a-zA-Z0-9_]+):$/;
const PATRON_RESUELTO = /^<a?:[a-zA-Z0-9_]{2,32}:\d{15,21}>$/;

export class EmojiNoEncontradoError extends Error {
  constructor(codigo) {
    super(`El emoji "${codigo}" no existe en este servidor. Usa uno de los emojis del servidor (:nombre:), un emoji unicode, o pégalo directamente.`);
    this.name = 'EmojiNoEncontradoError';
    this.codigo = codigo;
  }
}

// Tabla de códigos unicode estándar más relevantes para roles/categorías de
// una comp (armas, alertas, los círculos de color recomendados para
// categorías...). No pretende ser exhaustiva: el camino principal son los
// emojis custom del propio servidor.
const CODIGOS_UNICODE = {
  fire: '🔥',
  star: '⭐',
  star2: '🌟',
  sparkles: '✨',
  crossed_swords: '⚔️',
  shield: '🛡️',
  dagger: '🗡️',
  bow_and_arrow: '🏹',
  skull: '💀',
  skull_and_crossbones: '☠️',
  warning: '⚠️',
  crown: '👑',
  gem: '💎',
  zap: '⚡',
  bell: '🔔',
  no_bell: '🔕',
  eyes: '👀',
  heart: '❤️',
  broken_heart: '💔',
  100: '💯',
  checkered_flag: '🏁',
  triangular_flag_on_post: '🚩',
  mage: '🧙',
  mage_man: '🧙‍♂️',
  mage_woman: '🧙‍♀️',
  snowflake: '❄️',
  comet: '☄️',
  anger: '💢',
  boom: '💥',
  collision: '💥',
  dizzy: '💫',
  droplet: '💧',
  ocean: '🌊',
  mountain: '⛰️',
  purple_circle: '🟣',
  blue_circle: '🔵',
  large_blue_circle: '🔵',
  green_circle: '🟢',
  yellow_circle: '🟡',
  orange_circle: '🟠',
  red_circle: '🔴',
  brown_circle: '🟤',
  black_circle: '⚫',
  white_circle: '⚪',
};

/**
 * Resuelve un único emoji crudo a su forma completa/definitiva.
 * @param {{ emojis?: { cache?: { find: (fn: (e: any) => boolean) => any } } }} guild
 * @param {string} crudo - ":maza:", "🔨", o ya "<:maza:123456789>"
 * @returns {string}
 * @throws {EmojiNoEncontradoError}
 */
export function resolverEmoji(guild, crudo) {
  const valor = String(crudo ?? '').trim();
  if (valor.length === 0) {
    throw new EmojiNoEncontradoError(valor);
  }

  // Ya viene resuelto (custom completo): se acepta tal cual.
  if (PATRON_RESUELTO.test(valor)) {
    return valor;
  }

  const match = PATRON_CODIGO.exec(valor);
  if (!match) {
    // No es ":nombre:" ni <...> resuelto -> se asume un emoji unicode
    // pegado directamente. No se valida que sea "de verdad" un grafema
    // emoji: normalizarEmoji() en ctaComp.js ya filtra los casos rotos
    // obvios (vacío, códigos cortos sueltos, "<...>" mal formado).
    return valor;
  }

  const nombre = match[1];
  const encontrado = guild?.emojis?.cache?.find?.((e) => e.name === nombre);
  if (encontrado) {
    return `<${encontrado.animated ? 'a' : ''}:${encontrado.name}:${encontrado.id}>`;
  }

  const unicode = CODIGOS_UNICODE[nombre];
  if (unicode) {
    return unicode;
  }

  throw new EmojiNoEncontradoError(valor);
}

/**
 * Resuelve una lista de emojis crudos. Todo o nada: si CUALQUIERA falla, se
 * lanza inmediatamente (no se devuelven los que sí resolvieron) — evita que
 * el caller tenga que deshacer nada.
 * @param {object} guild
 * @param {string[]} crudos
 * @returns {string[]}
 */
export function resolverEmojis(guild, crudos) {
  return crudos.map((crudo) => resolverEmoji(guild, crudo));
}
