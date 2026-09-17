/**
 * Une `lines` recortando al último elemento que quepa entero dentro de
 * `maxLength`, y añade un sufijo con lo que sobre. Nunca parte una línea a
 * la mitad. Por defecto une con '\n' y el sufijo "… +N más" (embeds); pasa
 * `separator`/`formatSuffix` para otros formatos (ej. listas " · " con "+N"
 * en las opciones de un select).
 * @param {string[]} lines
 * @param {number} maxLength
 * @param {{ separator?: string, formatSuffix?: (remaining: number) => string }} [options]
 * @returns {string}
 */
export function truncateList(lines, maxLength, options = {}) {
  const separator = options.separator ?? '\n';
  const formatSuffix = options.formatSuffix ?? ((remaining) => `… +${remaining} más`);

  const joined = lines.join(separator);
  if (joined.length <= maxLength) return joined;

  const kept = [];
  let acc = '';
  for (const line of lines) {
    const candidate = acc ? `${acc}${separator}${line}` : line;
    const remainingAfter = lines.length - (kept.length + 1);
    const suffix = remainingAfter > 0 ? `${separator}${formatSuffix(remainingAfter)}` : '';
    if ((candidate + suffix).length > maxLength) break;
    acc = candidate;
    kept.push(line);
  }

  const remaining = lines.length - kept.length;
  if (remaining === 0) return acc;
  return `${acc ? `${acc}${separator}` : ''}${formatSuffix(remaining)}`;
}
