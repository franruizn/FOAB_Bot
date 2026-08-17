export const SERVER_HOSTS = {
  americas: 'https://gameinfo.albiononline.com/api/gameinfo',
  europe: 'https://gameinfo-ams.albiononline.com/api/gameinfo',
  asia: 'https://gameinfo-sgp.albiononline.com/api/gameinfo',
};

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 300;
const EVENTS_PAGE_LIMIT = 51;
const MAX_PAGES = 40;
const CACHE_TTL_MS = 5 * 60 * 1000;

export class AlbionApiError extends Error {
  constructor(message, { status, battleId } = {}) {
    super(message);
    this.name = 'AlbionApiError';
    this.status = status;
    this.battleId = battleId;
  }
}

function resolveHost(server) {
  const host = SERVER_HOSTS[server];
  if (!host) {
    throw new Error(`Servidor "${server}" no reconocido. Usa: ${Object.keys(SERVER_HOSTS).join(', ')}`);
  }
  return host;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createCache() {
  const store = new Map();
  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (Date.now() > entry.expiresAt) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      store.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    },
  };
}

const battleCache = createCache();
const eventsCache = createCache();

/**
 * Pide un JSON con timeout de 10s y reintento con backoff exponencial (hasta
 * MAX_ATTEMPTS intentos) solo ante 5xx o errores de red. Los 4xx no reintentan.
 */
async function fetchJson(url, { battleId } = {}) {
  let lastError;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, { signal: controller.signal });

      if (response.ok) {
        return await response.json();
      }

      if (response.status >= 400 && response.status < 500) {
        throw new AlbionApiError(
          `La API de Albion respondió ${response.status} para la batalla ${battleId}`,
          { status: response.status, battleId },
        );
      }

      lastError = new AlbionApiError(
        `La API de Albion respondió ${response.status} para la batalla ${battleId}`,
        { status: response.status, battleId },
      );
    } catch (error) {
      if (error instanceof AlbionApiError) throw error;
      lastError = error;
    } finally {
      clearTimeout(timeoutId);
    }

    if (attempt < MAX_ATTEMPTS - 1) {
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }

  throw lastError;
}

/**
 * Obtiene el detalle completo de una batalla desde la API oficial de Albion (gameinfo).
 * Incluye kills/deaths/killFame por jugador, por gremio y por alianza.
 * @param {'europe' | 'americas' | 'asia'} server
 * @param {number} battleId
 * @returns {Promise<object>} objeto de batalla con players, guilds y alliances
 * @throws {AlbionApiError} si la API responde 4xx (o 5xx tras agotar reintentos)
 */
export async function getBattle(server, battleId) {
  const cacheKey = `${server}:${battleId}`;
  const cached = battleCache.get(cacheKey);
  if (cached) return cached;

  const host = resolveHost(server);
  const battle = await fetchJson(`${host}/battles/${battleId}`, { battleId });

  battleCache.set(cacheKey, battle);
  return battle;
}

/**
 * Obtiene todos los eventos (kills) de una batalla, paginando de a
 * EVENTS_PAGE_LIMIT (51) hasta que una página venga incompleta o se
 * alcance el tope de seguridad MAX_PAGES (40).
 * @param {'europe' | 'americas' | 'asia'} server
 * @param {number} battleId
 * @returns {Promise<object[]>} array plano de eventos de kill
 * @throws {AlbionApiError} si la API responde 4xx (o 5xx tras agotar reintentos)
 */
export async function getBattleEvents(server, battleId) {
  const cacheKey = `${server}:${battleId}`;
  const cached = eventsCache.get(cacheKey);
  if (cached) return cached;

  const host = resolveHost(server);
  const events = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * EVENTS_PAGE_LIMIT;
    const url = `${host}/events/battle/${battleId}?offset=${offset}&limit=${EVENTS_PAGE_LIMIT}`;
    const pageEvents = await fetchJson(url, { battleId });

    events.push(...pageEvents);
    if (pageEvents.length < EVENTS_PAGE_LIMIT) break;
  }

  eventsCache.set(cacheKey, events);
  return events;
}
