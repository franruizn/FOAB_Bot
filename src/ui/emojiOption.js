// LA REGLA (motivo de este fichero): dentro de una opción de select menu de
// Discord, un emoji PERSONALIZADO solo se renderiza pasado por el campo
// `emoji` de la opción (StringSelectMenuOptionBuilder#setEmoji). Escrito
// dentro de `label` o `description` sale como texto crudo
// ("<:nombre:1234567890>"), nunca como el icono — y esa cadena es larga,
// así que además se come casi todo el presupuesto de 100 caracteres. Un
// emoji unicode (🟢 ⚠️ ★) sí renderiza igual en label/description que en el
// campo `emoji`, así que esos pueden ir inline en texto sin problema.
//
// Compartido entre ui/ctaInscripcion.js y ui/ctaPanel.js: es la misma
// conversión en los dos sitios, y que diverjan sería justo el bug que este
// fichero existe para evitar.

const CUSTOM_EMOJI_RESUELTO = /^<(a)?:([a-zA-Z0-9_]{2,32}):(\d{15,21})>$/;

/**
 * Convierte un emoji ya resuelto (string, ver services/emojiResolver.js) a
 * la forma que espera StringSelectMenuOptionBuilder#setEmoji(): un objeto
 * {id,name,animated} para un custom emoji, o el string unicode tal cual.
 * @param {string} emojiStr
 * @returns {string | { id: string, name: string, animated: boolean }}
 */
export function emojiParaOpcion(emojiStr) {
  const match = CUSTOM_EMOJI_RESUELTO.exec(emojiStr);
  if (!match) return emojiStr;
  const [, animated, name, id] = match;
  return { id, name, animated: Boolean(animated) };
}

/**
 * @param {string} emojiStr - ya resuelto (ver services/emojiResolver.js)
 * @returns {boolean} true si es un custom emoji del servidor (nunca se
 *   renderiza si se escribe dentro de label/description de una opción)
 */
export function esEmojiPersonalizado(emojiStr) {
  return CUSTOM_EMOJI_RESUELTO.test(String(emojiStr ?? ''));
}
