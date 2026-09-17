const DEFAULT_SUGGESTION_COUNT = 3;

/**
 * Distancia de Levenshtein clásica (DP de dos filas), sin dependencias.
 */
export function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prevRow = Array.from({ length: b.length + 1 }, (_, j) => j);
  let currRow = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    currRow[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(currRow[j - 1] + 1, prevRow[j] + 1, prevRow[j - 1] + cost);
    }
    [prevRow, currRow] = [currRow, prevRow];
  }

  return prevRow[b.length];
}

/**
 * Devuelve hasta `limit` nombres de `names` más cercanos a `input` por
 * distancia de Levenshtein (case-insensitive), sin duplicados, desempatando
 * alfabéticamente.
 * @param {string} input
 * @param {string[]} names
 * @param {number} [limit=3]
 * @returns {string[]}
 */
export function suggestClosestNames(input, names, limit = DEFAULT_SUGGESTION_COUNT) {
  const inputLower = input.toLowerCase();
  const scored = names
    .map((name) => ({ name, distance: levenshteinDistance(inputLower, name.toLowerCase()) }))
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));

  const seen = new Set();
  const result = [];
  for (const item of scored) {
    const key = item.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item.name);
    if (result.length >= limit) break;
  }
  return result;
}
