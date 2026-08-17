// Ver docs/albionbb-api.md para el detalle completo de cómo se descubrió este
// endpoint (no es una API oficial ni documentada por albionbb).

const SERVER_CODES = {
  europe: 'eu',
  americas: 'us',
  asia: 'asia',
};

const USER_AGENT = 'FOAB-DiscordBot/1.0 (+attendance tracker; contacto: oficiales del gremio)';
const REQUEST_TIMEOUT_MS = 10_000;
const MIN_REQUEST_INTERVAL_MS = 2_000;
const CACHE_TTL_MS = 15 * 60 * 1000;

// Nombres de rol inferidos por forma/color de icono, NO confirmados por una
// etiqueta de texto real (ver docs/albionbb-api.md). Fáciles de renombrar
// aquí si alguien los contrasta visualmente y resultan incorrectos.
const ROLE_LABELS = ['tank', 'support', 'healer', 'meleeDps', 'rangedDps', 'mounted'];

export class AlbionbbApiError extends Error {
  constructor(message, { status, guildId } = {}) {
    super(message);
    this.name = 'AlbionbbApiError';
    this.status = status;
    this.guildId = guildId;
  }
}

function resolveServerCode(server) {
  const code = SERVER_CODES[server];
  if (!code) {
    throw new Error(`Servidor "${server}" no reconocido. Usa: ${Object.keys(SERVER_CODES).join(', ')}`);
  }
  return code;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- caché de 15 min por guildId + rango de fechas (+ minPlayers) ---

const cacheStore = new Map();

function cacheGet(key) {
  const entry = cacheStore.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cacheStore.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key, value) {
  cacheStore.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

// --- rate limit global: como mucho 1 petición cada 2s, en cola ---

let lastRequestAt = 0;
let requestQueue = Promise.resolve();

function scheduleRequest(task) {
  const run = requestQueue.then(async () => {
    const wait = Math.max(0, lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now());
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return task();
  });
  requestQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function mapRoles(rolesArray) {
  const roles = {};
  ROLE_LABELS.forEach((label, index) => {
    roles[label] = rolesArray?.[index] ?? 0;
  });
  return roles;
}

/**
 * Obtiene la asistencia de TODO el gremio (no hay endpoint por jugador: la
 * API de albionbb solo expone el roster completo por rango de fechas).
 * @param {'europe' | 'americas' | 'asia'} server
 * @param {string} guildId - guildId oficial de Albion (el mismo que usa gameinfo)
 * @param {{ start?: string, end?: string, minPlayers?: number }} [options] - start/end en formato YYYY-MM-DD
 * @returns {Promise<Array<{
 *   name: string, guildName: string, allianceName: string, lastBattle: Date,
 *   attendance: number, kills: number, deaths: number, killFame: number,
 *   deathFame: number, heal: number, damage: number, avgIp: number,
 *   roles: { tank: number, support: number, healer: number, meleeDps: number, rangedDps: number, mounted: number }
 * }>>}
 * @throws {AlbionbbApiError} si el guild no existe o la API responde con error
 */
export async function getGuildAttendance(server, guildId, options = {}) {
  const { start, end, minPlayers } = options;
  const cacheKey = `${server}:${guildId}:${start ?? ''}:${end ?? ''}:${minPlayers ?? ''}`;

  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const code = resolveServerCode(server);
  const url = new URL(`https://api.albionbb.com/${code}/stats/guilds/${guildId}`);
  if (start) url.searchParams.set('start', start);
  if (end) url.searchParams.set('end', end);
  if (minPlayers !== undefined) url.searchParams.set('minPlayers', String(minPlayers));

  const entries = await scheduleRequest(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT },
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new AlbionbbApiError(`albionbb respondió ${response.status} para el gremio ${guildId}: ${body}`, {
        status: response.status,
        guildId,
      });
    }

    return response.json();
  });

  const mapped = entries.map((entry) => ({
    name: entry.name,
    guildName: entry.guildName,
    allianceName: entry.allianceName,
    lastBattle: new Date(entry.lastBattle),
    attendance: entry.attendance,
    kills: entry.kills,
    deaths: entry.deaths,
    killFame: entry.killFame,
    deathFame: entry.deathFame,
    heal: entry.heal,
    damage: entry.damage,
    avgIp: entry.avgIp,
    roles: mapRoles(entry.roles),
  }));

  cacheSet(cacheKey, mapped);
  return mapped;
}
