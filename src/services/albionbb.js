import { LocalizedError } from '../i18n.js';

const HOST_TO_SERVER = {
  'albionbb.com': 'americas',
  'europe.albionbb.com': 'europe',
  'east.albionbb.com': 'asia',
};

function isDigitsOnly(value) {
  if (value.length === 0) return false;
  for (const char of value) {
    if (char < '0' || char > '9') return false;
  }
  return true;
}

/** El enlace de albionbb no vale. El texto sale de src/i18n.js (link.*). */
export class InvalidLinkError extends LocalizedError {
  /**
   * @param {string} key
   * @param {Record<string, string | number>} [values]
   */
  constructor(key, values) {
    super(key, values);
    this.name = 'InvalidLinkError';
  }
}

/**
 * Parsea una URL de batalla de albionbb y extrae el servidor y los IDs de batalla.
 * Soporta dos formatos: /battles/<id>[,<id>...] y /battles/multi?ids=<id>[,<id>...].
 * @param {string} url - URL completa de albionbb, ej. https://europe.albionbb.com/battles/418186013
 *   o https://europe.albionbb.com/battles/multi?ids=418543901,418551073
 * @returns {{ server: 'europe' | 'americas' | 'asia', battleIds: number[] }}
 * @throws {InvalidLinkError} si la URL no es válida, el host no es de albionbb,
 *   la ruta no tiene un formato reconocido o algún id no es numérico
 */
export function parseAlbionbbUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidLinkError('link.notUrl', { url });
  }

  const server = HOST_TO_SERVER[parsed.hostname];
  if (!server) {
    throw new InvalidLinkError('link.unknownHost', { host: parsed.hostname });
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length !== 2 || segments[0] !== 'battles') {
    throw new InvalidLinkError('link.badPath', { path: parsed.pathname });
  }

  let rawIds;
  if (segments[1] === 'multi') {
    const idsParam = parsed.searchParams.get('ids');
    if (!idsParam) {
      throw new InvalidLinkError('link.multiNoIds', { url });
    }
    rawIds = idsParam.split(',');
  } else {
    rawIds = segments[1].split(',');
  }

  const battleIds = rawIds.map((rawId) => {
    if (!isDigitsOnly(rawId)) {
      throw new InvalidLinkError('link.notNumeric', { id: rawId });
    }
    return Number(rawId);
  });

  return { server, battleIds };
}
