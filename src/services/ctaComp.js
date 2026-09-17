import { createMutex, readJsonFile, backupCurrentFile, atomicWriteJson } from './fileStore.js';

const COMPS_VERSION = 1;
const BACKUP_PREFIX = 'comps';

const MAX_ROLES = 25; // límite de un select menu de Discord
const MAX_PARTIES = 20; // límite de fields de un embed, dejando sitio para la cabecera
const SLUG_MAX_LENGTH = 32;
const NOMBRE_MAX_LENGTH = 100; // límite real de label/nombre de opción de Discord
const NOTA_MAX_LENGTH = 100; // límite real de la descripción de una opción de select de Discord

const CUSTOM_EMOJI_RESUELTO = /^<a?:[a-zA-Z0-9_]{2,32}:\d{15,21}>$/;
const CUSTOM_EMOJI_CODIGO = /^:[a-zA-Z0-9_]+:$/;

export class CtaCompError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, [k: string]: unknown }} [context] - `code` deja
   *   que la capa de comandos distinga QUÉ falta (comp_not_found,
   *   categoria_not_found, rol_not_found, ...) sin parsear el mensaje, para
   *   poder responder "créalo antes con /comp X" en vez de un "no encontrado"
   *   genérico.
   */
  constructor(message, { code, ...context } = {}) {
    super(message);
    this.name = 'CtaCompError';
    this.code = code;
    Object.assign(this, context);
  }
}

// --- mutex propio (independiente del de ctaStore.js/squadsStore.js: es un
// fichero distinto, no tiene sentido serializarlo con los demás) ---
const { withWriteLock, waitForPendingWrites: waitForPendingCompWrites } = createMutex();
export { waitForPendingCompWrites };

function defaultComps() {
  return { version: COMPS_VERSION, comps: {} };
}

async function readComps(filePath) {
  return readJsonFile(filePath, defaultComps());
}

async function mutateComps(filePath, mutateFn) {
  return withWriteLock(async () => {
    const current = await readComps(filePath);
    const { data, report } = mutateFn(current); // si lanza, no se hace backup ni escritura
    await backupCurrentFile(filePath, BACKUP_PREFIX);
    await atomicWriteJson(filePath, data);
    return { data, report };
  });
}

// --- slugs: validación (para claves ya dadas) vs. derivación (a partir de un nombre libre) ---

function normalizarSlug(input, { label, maxLength = SLUG_MAX_LENGTH }) {
  const key = String(input ?? '').trim().toLowerCase();
  if (key.length === 0 || key.length > maxLength) {
    throw new CtaCompError(`${label} "${input}" debe tener entre 1 y ${maxLength} caracteres.`);
  }
  for (const char of key) {
    const isLower = char >= 'a' && char <= 'z';
    const isDigit = char >= '0' && char <= '9';
    const isDash = char === '-';
    if (!isLower && !isDigit && !isDash) {
      throw new CtaCompError(`${label} "${key}" solo puede contener minúsculas (a-z), números y guiones.`);
    }
  }
  return key;
}

/**
 * Deriva un slug a partir de un nombre libre: minúsculas, sin acentos,
 * espacios y demás separadores a guiones. "ZvZ Standard" -> "zvz-standard".
 * A diferencia de normalizarSlug() (que VALIDA una clave ya dada), esto
 * nunca lanza: siempre produce algo usable.
 * @param {string} input
 * @param {number} [maxLength]
 * @returns {string}
 */
export function slugify(input, maxLength = SLUG_MAX_LENGTH) {
  const base = String(input ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita acentos/diacríticos (marcas combinantes tras NFD)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const slug = base.slice(0, maxLength).replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'x';
}

function resolverSlugUnico(existingKeys, base) {
  if (!existingKeys.has(base)) return base;
  let n = 2;
  while (existingKeys.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * "Maza Pesada, Martillo Largo,, Golem " -> ["Maza Pesada", "Martillo Largo", "Golem"].
 * Separa SOLO por comas (nunca espacios ni caracteres sueltos: los nombres
 * llevan espacios y muchos emojis son varios puntos de código), recorta cada
 * elemento y descarta los vacíos de comas dobles sin contarlos como error.
 * @param {string} input
 * @returns {string[]}
 */
export function parsearLista(input) {
  return String(input ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function normalizarNombre(input, { label, maxLength = NOMBRE_MAX_LENGTH }) {
  const nombre = String(input ?? '').trim();
  if (nombre.length === 0 || nombre.length > maxLength) {
    throw new CtaCompError(`${label} debe tener entre 1 y ${maxLength} caracteres (recibido: ${JSON.stringify(input)}).`);
  }
  return nombre;
}

/**
 * Valida un emoji ya resuelto: un emoji Unicode normal, o un custom emoji de
 * Discord en su forma completa `<:nombre:id>`/`<a:nombre:id>`. Rechaza
 * explícitamente el código corto (`:nombre:`): resolverlo es responsabilidad
 * de quien llama (ver services/emojiResolver.js), ANTES de invocar nada de
 * este fichero.
 */
function normalizarEmoji(input, { label }) {
  const emoji = String(input ?? '').trim();
  if (emoji.length === 0) {
    throw new CtaCompError(`${label} no puede estar vacío.`);
  }
  if (CUSTOM_EMOJI_CODIGO.test(emoji)) {
    throw new CtaCompError(
      `${label} "${emoji}" es un código corto de Discord, no un emoji resuelto. Debe guardarse como "<:nombre:id>".`,
    );
  }
  if (emoji.startsWith('<') && !CUSTOM_EMOJI_RESUELTO.test(emoji)) {
    throw new CtaCompError(`${label} "${emoji}" no tiene la forma de un custom emoji resuelto ("<:nombre:id>").`);
  }
  return emoji;
}

function validarCategorias(rawCategorias) {
  if (rawCategorias === null || typeof rawCategorias !== 'object' || Array.isArray(rawCategorias)) {
    throw new CtaCompError('"categorias" debe ser un objeto.');
  }

  const categorias = {};
  const emojisVistos = new Map(); // emoji -> categoriaKey

  for (const [rawKey, rawCat] of Object.entries(rawCategorias)) {
    const key = normalizarSlug(rawKey, { label: 'La clave de categoría' });
    if (categorias[key]) {
      throw new CtaCompError(`La categoría "${key}" está duplicada (case-insensitive).`);
    }
    if (rawCat === null || typeof rawCat !== 'object') {
      throw new CtaCompError(`La categoría "${key}" debe ser un objeto.`);
    }

    const nombre = normalizarNombre(rawCat.nombre, { label: `El nombre de la categoría "${key}"` });
    const emoji = normalizarEmoji(rawCat.emoji, { label: `El emoji de la categoría "${key}"` });
    const orden = Number(rawCat.orden);
    if (!Number.isFinite(orden) || !Number.isInteger(orden)) {
      throw new CtaCompError(`"orden" de la categoría "${key}" debe ser un número entero (recibido: ${JSON.stringify(rawCat.orden)}).`);
    }

    if (emojisVistos.has(emoji)) {
      throw new CtaCompError(
        `El emoji "${emoji}" ya lo usa la categoría "${emojisVistos.get(emoji)}". Dos categorías de la misma ` +
          'plantilla no pueden compartir emoji: serían indistinguibles en el embed.',
        { code: 'emoji_duplicado' },
      );
    }
    emojisVistos.set(emoji, key);

    categorias[key] = { nombre, emoji, orden };
  }

  return categorias;
}

function validarRoles(rawRoles, categorias) {
  if (rawRoles === null || typeof rawRoles !== 'object' || Array.isArray(rawRoles)) {
    throw new CtaCompError('"roles" debe ser un objeto.');
  }

  // Sin mínimo a propósito: una comp recién creada con /comp crear no tiene
  // roles todavía, se construye en pasos (Z1: categoría -> rol -> party).
  const roleKeys = Object.keys(rawRoles);
  if (roleKeys.length > MAX_ROLES) {
    throw new CtaCompError(`Máximo ${MAX_ROLES} roles distintos por plantilla (límite de un select menu de Discord); hay ${roleKeys.length}.`);
  }

  const roles = {};
  for (const rawKey of roleKeys) {
    const key = normalizarSlug(rawKey, { label: 'La clave de rol' });
    if (roles[key]) {
      throw new CtaCompError(`El rol "${key}" está duplicado (case-insensitive).`);
    }
    const rawRole = rawRoles[rawKey];
    if (rawRole === null || typeof rawRole !== 'object') {
      throw new CtaCompError(`El rol "${key}" debe ser un objeto.`);
    }

    const nombre = normalizarNombre(rawRole.nombre, { label: `El nombre del rol "${key}"` });
    const emoji = normalizarEmoji(rawRole.emoji, { label: `El emoji del rol "${key}"` });

    // Un rol sin categoría es válido a propósito: no hay que categorizarlo
    // todo el primer día.
    const categoriaRaw = rawRole.categoria;
    let categoria = null;
    if (categoriaRaw !== null && categoriaRaw !== undefined && String(categoriaRaw).trim() !== '') {
      const categoriaKey = String(categoriaRaw).trim().toLowerCase();
      if (!categorias[categoriaKey]) {
        throw new CtaCompError(`El rol "${key}" referencia la categoría "${categoriaKey}", que no existe en "categorias".`);
      }
      categoria = categoriaKey;
    }

    const notaRaw = rawRole.nota;
    const nota = notaRaw === null || notaRaw === undefined ? '' : String(notaRaw).trim();
    if (nota.length > NOTA_MAX_LENGTH) {
      throw new CtaCompError(`La nota del rol "${key}" no puede superar los ${NOTA_MAX_LENGTH} caracteres.`);
    }

    roles[key] = { nombre, emoji, categoria, nota };
  }

  return roles;
}

function validarParties(rawParties, roles) {
  if (!Array.isArray(rawParties)) {
    throw new CtaCompError('"parties" debe ser un array.');
  }
  // Sin mínimo a propósito, mismo motivo que validarRoles(): /comp party add
  // crea una party sin slots todavía.
  if (rawParties.length > MAX_PARTIES) {
    throw new CtaCompError(`Máximo ${MAX_PARTIES} parties por plantilla (límite de fields de un embed); hay ${rawParties.length}.`);
  }

  return rawParties.map((rawParty, index) => {
    if (rawParty === null || typeof rawParty !== 'object') {
      throw new CtaCompError(`La party en la posición ${index} debe ser un objeto.`);
    }
    const nombre = normalizarNombre(rawParty.nombre, { label: `El nombre de la party en la posición ${index}` });

    if (!Array.isArray(rawParty.slots)) {
      throw new CtaCompError(`Los "slots" de la party "${nombre}" deben ser un array.`);
    }

    const slots = rawParty.slots.map((rawSlot, slotIndex) => {
      const slotKey = String(rawSlot ?? '').trim().toLowerCase();
      if (!roles[slotKey]) {
        throw new CtaCompError(
          `El slot ${slotIndex} de la party "${nombre}" referencia el rol "${slotKey}", que no existe en "roles".`,
        );
      }
      return slotKey;
    });

    return { nombre, slots };
  });
}

/**
 * Valida y normaliza una plantilla de composición cruda a la estructura
 * canónica que se guarda en comps.json. Nunca resuelve códigos cortos de
 * emoji (":morado:"): eso es responsabilidad de quien llama, ANTES de
 * invocar esto (ver services/emojiResolver.js). Aquí solo se acepta la
 * forma ya resuelta. Se reusa tras CADA mutación granular (agregar
 * categoría, rol, party, slot...) como comprobación de invariantes de
 * extremo a extremo, no solo en la creación.
 * @param {unknown} raw
 * @returns {{ nombre: string, creadoPor: string, categorias: object, roles: object, parties: object[] }}
 * @throws {CtaCompError}
 */
export function validarComp(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CtaCompError('La plantilla debe ser un objeto.');
  }

  const nombre = normalizarNombre(raw.nombre, { label: 'El nombre de la plantilla' });
  const creadoPor = String(raw.creadoPor ?? '').trim();
  if (creadoPor.length === 0) {
    throw new CtaCompError('"creadoPor" (el discordId de quien crea la plantilla) es obligatorio.');
  }

  const categorias = validarCategorias(raw.categorias ?? {});
  const roles = validarRoles(raw.roles ?? {}, categorias);
  const parties = validarParties(raw.parties ?? [], roles);

  return { nombre, creadoPor, categorias, roles, parties };
}

function normalizarCompKey(input) {
  return normalizarSlug(input, { label: 'La clave de la plantilla' });
}

function requireComp(current, key) {
  const comp = current.comps[key];
  if (!comp) {
    throw new CtaCompError(`La composición "${key}" no existe. Créala primero con "/comp crear".`, {
      code: 'comp_not_found',
      compKey: key,
    });
  }
  return comp;
}

function requireCategoria(comp, compKey, categoriaKey) {
  const categoria = comp.categorias[categoriaKey];
  if (!categoria) {
    throw new CtaCompError(
      `La categoría "${categoriaKey}" no existe en "${comp.nombre}". Créala primero con "/comp categoria crear".`,
      { code: 'categoria_not_found', compKey },
    );
  }
  return categoria;
}

function requireParty(comp, compKey, indiceInput) {
  const indice = Number(indiceInput);
  if (!Number.isInteger(indice) || indice < 0 || indice >= comp.parties.length) {
    throw new CtaCompError(`No existe la party en la posición ${indiceInput} de "${comp.nombre}".`, {
      code: 'party_not_found',
      compKey,
    });
  }
  return indice;
}

// --- API pública: comp ---

/**
 * Crea o reemplaza por completo la plantilla `compKeyInput`. Pensada para
 * escrituras "de bloque completo" (import, o herramientas futuras); el
 * comando /comp usa las funciones granulares de más abajo, que solo tocan
 * lo que corresponde a cada paso.
 * @param {string} filePath
 * @param {string} compKeyInput
 * @param {object} compInput - forma cruda, ver validarComp()
 * @returns {Promise<{ key: string, comp: object }>}
 * @throws {CtaCompError}
 */
export async function guardarComp(filePath, compKeyInput, compInput) {
  const key = normalizarCompKey(compKeyInput);
  const comp = validarComp(compInput); // valida ANTES de tocar el fichero

  const { report } = await mutateComps(filePath, (current) => {
    const comps = { ...current.comps, [key]: comp };
    return { data: { ...current, comps }, report: { key, comp } };
  });

  return report;
}

/**
 * PASO 1. Crea una plantilla vacía (sin categorías/roles/parties) a partir
 * de un nombre libre. El slug se deriva automáticamente; si ya existe, se le
 * añade un sufijo numérico — nunca se le pide al oficial que invente un id.
 * @param {string} filePath
 * @param {{ nombre: string, creadoPor: string }} datos
 * @returns {Promise<{ key: string, comp: object }>}
 */
export async function crearComp(filePath, { nombre, creadoPor }) {
  const nombreLimpio = normalizarNombre(nombre, { label: 'El nombre de la plantilla' });
  const creadoPorLimpio = String(creadoPor ?? '').trim();
  if (creadoPorLimpio.length === 0) {
    throw new CtaCompError('"creadoPor" es obligatorio.');
  }
  const base = slugify(nombreLimpio);

  const { report } = await mutateComps(filePath, (current) => {
    const key = resolverSlugUnico(new Set(Object.keys(current.comps)), base);
    const comp = validarComp({ nombre: nombreLimpio, creadoPor: creadoPorLimpio, categorias: {}, roles: {}, parties: [] });
    return { data: { ...current, comps: { ...current.comps, [key]: comp } }, report: { key, comp } };
  });

  return report;
}

/**
 * @param {string} filePath
 * @param {string} compKeyInput
 * @returns {Promise<{ key: string, comp: object }>}
 * @throws {CtaCompError} si no existe
 */
export async function borrarComp(filePath, compKeyInput) {
  const key = normalizarCompKey(compKeyInput);

  const { report } = await mutateComps(filePath, (current) => {
    const comp = requireComp(current, key);
    const comps = { ...current.comps };
    delete comps[key];
    return { data: { ...current, comps }, report: { key, comp } };
  });

  return report;
}

/**
 * @param {string} filePath
 * @returns {Promise<Array<{ key: string, nombre: string, creadoPor: string, numRoles: number, numCategorias: number, numParties: number }>>}
 */
export async function listarComps(filePath) {
  const current = await readComps(filePath);
  return Object.entries(current.comps)
    .map(([key, comp]) => ({
      key,
      nombre: comp.nombre,
      creadoPor: comp.creadoPor,
      numRoles: Object.keys(comp.roles).length,
      numCategorias: Object.keys(comp.categorias).length,
      numParties: comp.parties.length,
    }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'en', { sensitivity: 'base' }));
}

/**
 * @param {string} filePath
 * @param {string} compKeyInput
 * @returns {Promise<object | null>} la plantilla cruda, o null si no existe
 */
export async function getComp(filePath, compKeyInput) {
  const key = String(compKeyInput ?? '').trim().toLowerCase();
  const current = await readComps(filePath);
  return current.comps[key] ?? null;
}

// --- API pública: categorías (PASO 2, depende de que la comp exista) ---

/**
 * Crea una categoría, o ACTUALIZA su emoji si ya existe una con ese mismo
 * nombre (derivan el mismo slug) — corregir un emoji mal puesto es lo más
 * frecuente, así que no falla.
 * @param {string} filePath
 * @param {string} compKeyInput
 * @param {{ nombre: string, emojiCrudo: string }} datos
 * @param {{ resolverEmoji: (crudo: string) => string }} deps - función SÍNCRONA
 *   que resuelve ":nombre:"/unicode/forma completa a la forma completa; la
 *   inyecta el comando ya atada al guild (este servicio no conoce discord.js).
 * @returns {Promise<{ compKey: string, categoriaKey: string, categoria: object, actualizado: boolean }>}
 */
export async function agregarOActualizarCategoria(filePath, compKeyInput, { nombre, emojiCrudo }, { resolverEmoji }) {
  const key = normalizarCompKey(compKeyInput);
  const nombreLimpio = normalizarNombre(nombre, { label: 'El nombre de la categoría' });
  const categoriaKey = slugify(nombreLimpio);

  const { report } = await mutateComps(filePath, (current) => {
    const comp = requireComp(current, key);

    const emojiResuelto = resolverEmoji(emojiCrudo);
    const emoji = normalizarEmoji(emojiResuelto, { label: `El emoji de la categoría "${nombreLimpio}"` });

    for (const [otroKey, otraCat] of Object.entries(comp.categorias)) {
      if (otroKey !== categoriaKey && otraCat.emoji === emoji) {
        throw new CtaCompError(
          `El emoji "${emoji}" ya lo usa la categoría "${otraCat.nombre}". Dos categorías de la misma plantilla ` +
            'no pueden compartir emoji: serían indistinguibles en el embed.',
          { code: 'emoji_duplicado' },
        );
      }
    }

    const existente = comp.categorias[categoriaKey];
    const actualizado = Boolean(existente);
    const orden = existente
      ? existente.orden
      : Object.values(comp.categorias).reduce((max, c) => Math.max(max, c.orden), 0) + 1;

    const categorias = { ...comp.categorias, [categoriaKey]: { nombre: nombreLimpio, emoji, orden } };
    const comp2 = validarComp({ ...comp, categorias });

    return {
      data: { ...current, comps: { ...current.comps, [key]: comp2 } },
      report: { compKey: key, categoriaKey, categoria: comp2.categorias[categoriaKey], actualizado },
    };
  });

  return report;
}

/**
 * Rechaza si algún rol de la comp sigue usando esta categoría, nombrándolos.
 * @param {string} filePath
 * @param {string} compKeyInput
 * @param {string} categoriaKeyInput
 */
export async function borrarCategoria(filePath, compKeyInput, categoriaKeyInput) {
  const key = normalizarCompKey(compKeyInput);
  const categoriaKey = String(categoriaKeyInput ?? '').trim().toLowerCase();

  const { report } = await mutateComps(filePath, (current) => {
    const comp = requireComp(current, key);
    const categoria = requireCategoria(comp, key, categoriaKey);

    const rolesConEsaCategoria = Object.values(comp.roles).filter((r) => r.categoria === categoriaKey);
    if (rolesConEsaCategoria.length > 0) {
      throw new CtaCompError(
        `No se puede borrar la categoría "${categoria.nombre}": la usan estos roles: ` +
          `${rolesConEsaCategoria.map((r) => r.nombre).join(', ')}.`,
        { code: 'categoria_en_uso' },
      );
    }

    const categorias = { ...comp.categorias };
    delete categorias[categoriaKey];
    const comp2 = validarComp({ ...comp, categorias });

    return {
      data: { ...current, comps: { ...current.comps, [key]: comp2 } },
      report: { compKey: key, categoriaKey, categoria },
    };
  });

  return report;
}

// --- API pública: roles (PASO 3, depende de que la categoría exista) ---

/**
 * Crea VARIOS roles de una vez, emparejados por posición entre `entradas`.
 * Todo o nada: si CUALQUIER nombre choca con un rol existente (o con otro
 * del mismo lote) o CUALQUIER emoji no resuelve, no se crea ninguno.
 * @param {string} filePath
 * @param {string} compKeyInput
 * @param {string} categoriaKeyInput
 * @param {Array<{ nombre: string, emojiCrudo: string }>} entradas - ya
 *   emparejadas 1:1 por quien llama (la comprobación de longitudes de las
 *   listas separadas por comas es responsabilidad del comando, que es quien
 *   conoce los conteos exactos para el mensaje de error).
 * @param {{ resolverEmoji: (crudo: string) => string }} deps
 * @returns {Promise<{ compKey: string, categoriaKey: string, categoria: object, creados: Array<{key: string, nombre: string, emoji: string}> }>}
 */
export async function crearRoles(filePath, compKeyInput, categoriaKeyInput, entradas, { resolverEmoji }) {
  const key = normalizarCompKey(compKeyInput);
  const categoriaKey = String(categoriaKeyInput ?? '').trim().toLowerCase();

  if (!Array.isArray(entradas) || entradas.length === 0) {
    throw new CtaCompError('Debes indicar al menos un rol.');
  }

  const { report } = await mutateComps(filePath, (current) => {
    const comp = requireComp(current, key);
    const categoria = requireCategoria(comp, key, categoriaKey);

    const nuevosRoles = { ...comp.roles };
    const creados = [];

    for (const { nombre, emojiCrudo } of entradas) {
      const nombreLimpio = normalizarNombre(nombre, { label: 'El nombre del rol' });
      const rolKey = slugify(nombreLimpio);

      if (nuevosRoles[rolKey]) {
        throw new CtaCompError(
          `El rol "${nombreLimpio}" (clave "${rolKey}") ya existe en "${comp.nombre}". Bórralo primero o usa otro nombre.`,
          { code: 'rol_duplicado', rolKey },
        );
      }

      const emojiResuelto = resolverEmoji(emojiCrudo);
      const emoji = normalizarEmoji(emojiResuelto, { label: `El emoji del rol "${nombreLimpio}"` });

      nuevosRoles[rolKey] = { nombre: nombreLimpio, emoji, categoria: categoriaKey, nota: '' };
      creados.push({ key: rolKey, nombre: nombreLimpio, emoji });
    }

    const comp2 = validarComp({ ...comp, roles: nuevosRoles });

    return {
      data: { ...current, comps: { ...current.comps, [key]: comp2 } },
      report: { compKey: key, categoriaKey, categoria, creados },
    };
  });

  return report;
}

/**
 * Rechaza si alguno de los roles está usado en algún slot, diciendo en
 * cuántos.
 * @param {string} filePath
 * @param {string} compKeyInput
 * @param {string[]} roleKeysInput
 */
export async function borrarRoles(filePath, compKeyInput, roleKeysInput) {
  const key = normalizarCompKey(compKeyInput);
  const keys = (Array.isArray(roleKeysInput) ? roleKeysInput : [roleKeysInput]).map((k) =>
    String(k ?? '').trim().toLowerCase(),
  );
  if (keys.length === 0) {
    throw new CtaCompError('Debes indicar al menos un rol.');
  }

  const { report } = await mutateComps(filePath, (current) => {
    const comp = requireComp(current, key);

    for (const rolKey of keys) {
      if (!comp.roles[rolKey]) {
        throw new CtaCompError(`El rol "${rolKey}" no existe en "${comp.nombre}".`, { code: 'rol_not_found', compKey: key });
      }
    }

    const enUso = keys
      .map((rolKey) => {
        let count = 0;
        for (const party of comp.parties) {
          for (const slot of party.slots) {
            if (slot === rolKey) count += 1;
          }
        }
        return { rolKey, nombre: comp.roles[rolKey].nombre, count };
      })
      .filter((r) => r.count > 0);

    if (enUso.length > 0) {
      throw new CtaCompError(
        `No se puede borrar: ${enUso.map((r) => `"${r.nombre}" se usa en ${r.count} slot(s)`).join(', ')}.`,
        { code: 'rol_en_uso', roles: enUso },
      );
    }

    const roles = { ...comp.roles };
    const borrados = keys.map((rolKey) => {
      const borrado = { key: rolKey, ...roles[rolKey] };
      delete roles[rolKey];
      return borrado;
    });

    const comp2 = validarComp({ ...comp, roles });
    return { data: { ...current, comps: { ...current.comps, [key]: comp2 } }, report: { compKey: key, borrados } };
  });

  return report;
}

/**
 * Cambia de categoría uno o varios roles a la vez.
 * @param {string} filePath
 * @param {string} compKeyInput
 * @param {string[]} roleKeysInput
 * @param {string} nuevaCategoriaKeyInput
 */
export async function moverRoles(filePath, compKeyInput, roleKeysInput, nuevaCategoriaKeyInput) {
  const key = normalizarCompKey(compKeyInput);
  const keys = (Array.isArray(roleKeysInput) ? roleKeysInput : [roleKeysInput]).map((k) =>
    String(k ?? '').trim().toLowerCase(),
  );
  const nuevaCategoriaKey = String(nuevaCategoriaKeyInput ?? '').trim().toLowerCase();
  if (keys.length === 0) {
    throw new CtaCompError('Debes indicar al menos un rol.');
  }

  const { report } = await mutateComps(filePath, (current) => {
    const comp = requireComp(current, key);
    requireCategoria(comp, key, nuevaCategoriaKey);

    for (const rolKey of keys) {
      if (!comp.roles[rolKey]) {
        throw new CtaCompError(`El rol "${rolKey}" no existe en "${comp.nombre}".`, { code: 'rol_not_found', compKey: key });
      }
    }

    const roles = { ...comp.roles };
    const movidos = keys.map((rolKey) => {
      roles[rolKey] = { ...roles[rolKey], categoria: nuevaCategoriaKey };
      return { key: rolKey, nombre: roles[rolKey].nombre };
    });

    const comp2 = validarComp({ ...comp, roles });
    return {
      data: { ...current, comps: { ...current.comps, [key]: comp2 } },
      report: { compKey: key, categoriaKey: nuevaCategoriaKey, movidos },
    };
  });

  return report;
}

// --- API pública: parties ---

/**
 * @param {string} filePath
 * @param {string} compKeyInput
 * @param {{ nombre: string }} datos
 */
export async function agregarParty(filePath, compKeyInput, { nombre }) {
  const key = normalizarCompKey(compKeyInput);
  const nombreLimpio = normalizarNombre(nombre, { label: 'El nombre de la party' });

  const { report } = await mutateComps(filePath, (current) => {
    const comp = requireComp(current, key);
    const parties = [...comp.parties, { nombre: nombreLimpio, slots: [] }];
    const comp2 = validarComp({ ...comp, parties });
    const indice = comp2.parties.length - 1;

    return {
      data: { ...current, comps: { ...current.comps, [key]: comp2 } },
      report: { compKey: key, indice, party: comp2.parties[indice] },
    };
  });

  return report;
}

/**
 * @param {string} filePath
 * @param {string} compKeyInput
 * @param {number} indiceInput - base 0
 */
export async function borrarParty(filePath, compKeyInput, indiceInput) {
  const key = normalizarCompKey(compKeyInput);

  const { report } = await mutateComps(filePath, (current) => {
    const comp = requireComp(current, key);
    const indice = requireParty(comp, key, indiceInput);

    const removida = comp.parties[indice];
    const parties = comp.parties.filter((_, i) => i !== indice);
    const comp2 = validarComp({ ...comp, parties });

    return {
      data: { ...current, comps: { ...current.comps, [key]: comp2 } },
      report: { compKey: key, indice, party: removida },
    };
  });

  return report;
}

/**
 * Copia los slots de la party `indiceInput` en una nueva al final ("Duplicate
 * party" de la web). El nombre se deriva ("Party 1" -> "Party 1 (copia)"): no
 * hay parámetro de nombre en el comando.
 * @param {string} filePath
 * @param {string} compKeyInput
 * @param {number} indiceInput - base 0
 */
export async function duplicarParty(filePath, compKeyInput, indiceInput) {
  const key = normalizarCompKey(compKeyInput);

  const { report } = await mutateComps(filePath, (current) => {
    const comp = requireComp(current, key);
    const indice = requireParty(comp, key, indiceInput);

    const original = comp.parties[indice];
    const copia = { nombre: `${original.nombre} (copia)`, slots: [...original.slots] };
    const parties = [...comp.parties, copia];
    const comp2 = validarComp({ ...comp, parties });
    const indiceNuevo = comp2.parties.length - 1;

    return {
      data: { ...current, comps: { ...current.comps, [key]: comp2 } },
      report: { compKey: key, indiceOriginal: indice, indiceNuevo, party: comp2.parties[indiceNuevo] },
    };
  });

  return report;
}

// --- API pública: slots ---

/**
 * @param {string} filePath
 * @param {string} compKeyInput
 * @param {number} partyIndiceInput - base 0
 * @param {string} rolKeyInput
 * @param {number} [cantidadInput=1] - añade varios slots del mismo rol de una vez
 */
export async function agregarSlot(filePath, compKeyInput, partyIndiceInput, rolKeyInput, cantidadInput = 1) {
  const key = normalizarCompKey(compKeyInput);
  const rolKey = String(rolKeyInput ?? '').trim().toLowerCase();
  const cantidad = Number(cantidadInput);
  if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > MAX_ROLES) {
    throw new CtaCompError(`"cantidad" debe ser un entero entre 1 y ${MAX_ROLES}.`);
  }

  const { report } = await mutateComps(filePath, (current) => {
    const comp = requireComp(current, key);
    const partyIndice = requireParty(comp, key, partyIndiceInput);
    if (!comp.roles[rolKey]) {
      throw new CtaCompError(`El rol "${rolKey}" no existe en "${comp.nombre}".`, { code: 'rol_not_found', compKey: key });
    }

    const parties = comp.parties.map((party, i) =>
      i === partyIndice ? { ...party, slots: [...party.slots, ...Array(cantidad).fill(rolKey)] } : party,
    );
    const comp2 = validarComp({ ...comp, parties });

    return {
      data: { ...current, comps: { ...current.comps, [key]: comp2 } },
      report: { compKey: key, indice: partyIndice, rolKey, cantidad, party: comp2.parties[partyIndice] },
    };
  });

  return report;
}

/**
 * @param {string} filePath
 * @param {string} compKeyInput
 * @param {number} partyIndiceInput - base 0
 * @param {number} slotIndiceInput - base 0
 */
export async function borrarSlot(filePath, compKeyInput, partyIndiceInput, slotIndiceInput) {
  const key = normalizarCompKey(compKeyInput);

  const { report } = await mutateComps(filePath, (current) => {
    const comp = requireComp(current, key);
    const partyIndice = requireParty(comp, key, partyIndiceInput);
    const party = comp.parties[partyIndice];

    const slotIndice = Number(slotIndiceInput);
    if (!Number.isInteger(slotIndice) || slotIndice < 0 || slotIndice >= party.slots.length) {
      throw new CtaCompError(`No existe el slot en la posición ${slotIndiceInput} de la party "${party.nombre}".`, {
        code: 'slot_not_found',
        compKey: key,
      });
    }

    const rolKey = party.slots[slotIndice];
    const parties = comp.parties.map((p, i) =>
      i === partyIndice ? { ...p, slots: p.slots.filter((_, si) => si !== slotIndice) } : p,
    );
    const comp2 = validarComp({ ...comp, parties });

    return {
      data: { ...current, comps: { ...current.comps, [key]: comp2 } },
      report: { compKey: key, indice: partyIndice, slotIndice, rolKey },
    };
  });

  return report;
}

/**
 * Roles de una comp ordenados por categoría (campo `orden`; los roles sin
 * categoría van al final) y, dentro de cada una, por nombre — para que las
 * armas de la misma función salgan juntas en listados y selects. Reutilizada
 * por ctaStore.rolesQueFaltan() y por los selects de inscripción.
 * @param {{ roles: object, categorias: object }} comp
 * @returns {Array<[string, object]>} pares [rolKey, rol]
 */
export function ordenarRoles(comp) {
  return Object.entries(comp.roles).sort(([, a], [, b]) => {
    const ordenA = a.categoria ? comp.categorias[a.categoria].orden : Number.POSITIVE_INFINITY;
    const ordenB = b.categoria ? comp.categorias[b.categoria].orden : Number.POSITIVE_INFINITY;
    if (ordenA !== ordenB) return ordenA - ordenB;
    return a.nombre.localeCompare(b.nombre, 'en', { sensitivity: 'base' });
  });
}

export { MAX_ROLES, MAX_PARTIES };
