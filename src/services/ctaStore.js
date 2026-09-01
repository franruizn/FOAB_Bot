import { readFile, writeFile, rename, mkdir, readdir, unlink, copyFile } from 'node:fs/promises';
import path from 'node:path';

const BACKUP_DIR_NAME = 'backups';
const MAX_BACKUPS = 10;

export class CtaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CtaError';
  }
}

// --- mutex de escritura: mismo patrón que squadsStore/rafflesStore. Protege
// SOLO cta.json (leer -> mutar -> escribir), no la sincronización con la
// hoja: esa se agrupa 2s y se dispara desde la capa de comando (ver
// ctaSheetSync.js), fuera de este lock — si esperase aquí a la escritura de
// Sheets, agrupar no serviría de nada (cada alta/baja seguiría bloqueando
// hasta que termine su propia llamada de red). La corrección no depende de
// que la hoja se escriba dentro de esta sección crítica: cada sincronización
// SIEMPRE relee el estado más reciente de cta.json y manda el bloque
// COMPLETO, así que nunca hay una fila a medias ni un hueco, sin importar
// cuándo llegue esa escritura respecto a otras altas/bajas. ---

let writeTail = Promise.resolve();

function withWriteLock(task) {
  const run = writeTail.then(task, task);
  writeTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Igual que squadsStore.waitForPendingWrites(): se resuelve cuando termina la
 * última operación (fichero + hoja) encolada en este momento.
 * @returns {Promise<void>}
 */
export function waitForPendingCtaWrites() {
  return writeTail;
}

// --- lectura / escritura del fichero ---

async function readCtaFile(filePath) {
  try {
    const content = await readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') return { activa: null };
    throw error;
  }
}

async function backupCurrentFile(filePath) {
  try {
    await readFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return; // nada que respaldar todavía
    throw error;
  }

  const backupDir = path.join(path.dirname(filePath), BACKUP_DIR_NAME);
  await mkdir(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  await copyFile(filePath, path.join(backupDir, `cta-${timestamp}.json`));

  const entries = (await readdir(backupDir))
    .filter((name) => name.startsWith('cta-') && name.endsWith('.json'))
    .sort(); // timestamps ISO -> orden lexicográfico == orden cronológico

  const excess = entries.length - MAX_BACKUPS;
  for (let i = 0; i < excess; i++) {
    await unlink(path.join(backupDir, entries[i]));
  }
}

async function atomicWrite(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmpPath, filePath);
}

async function writeCtaFile(filePath, activa) {
  await backupCurrentFile(filePath);
  await atomicWrite(filePath, { activa });
}

// --- lectura ---

/**
 * @param {string} filePath
 * @returns {Promise<object | null>}
 */
export async function ctaActiva(filePath) {
  const raw = await readCtaFile(filePath);
  return raw.activa ?? null;
}

/**
 * @param {string} filePath
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function estaApuntado(filePath, userId) {
  const activa = await ctaActiva(filePath);
  if (!activa) return false;
  return activa.inscritos.some((i) => i.userId === userId);
}

// --- mutaciones ---

const CREAR_CTA_REQUIRED_FIELDS = ['nombre', 'guildId', 'channelId', 'messageId', 'creadorId', 'cierraEn'];

// LIMITACIÓN ACEPTADA, no un descuido: cta.json guarda una única `activa`
// global (no una por guildId), así que solo puede haber una CTA a la vez en
// TODO el bot, no una por servidor. Esto NO lo impone este fichero — el
// store no tiene ningún código que agrupe o filtre por guild — lo impone la
// hoja: escribirBloque() siempre escribe el bloque fijo P3:S (ver
// services/sheets.js/CTA_RANGO_INICIO), así que dos CTAs activas a la vez
// escribirían sobre las mismas celdas sin importar cómo se organice el
// estado aquí. Aislar `activa` por servidor no arreglaría nada por sí solo.
// Si algún día hace falta más de una CTA simultánea (p.ej. una por
// servidor), lo primero que hay que cambiar es la HOJA (una pestaña por
// servidor, o un bloque de columnas distinto por servidor) y solo después
// este store, para que tenga sentido guardar varias `activa` a la vez. Con
// los dos servidores actuales siendo del mismo gremio, una CTA a la vez es
// el comportamiento correcto, no una limitación a arreglar.

/**
 * Crea la CTA activa. Falla si ya hay una (el rango fijo P3:S de la hoja no
 * admite dos bloques a la vez) y, al crear, limpia el margen gestionado de
 * la hoja para que no queden restos de una CTA anterior.
 * @param {string} filePath
 * @param {{ id?: string, nombre: string, roleId?: string | null, roleNombre?: string | null, guildId: string, channelId: string, messageId: string, creadorId: string, cierraEn: string | number | Date }} datos
 *   `id` es opcional: si no se pasa, se genera aquí. El comando /cta lo pasa
 *   explícito porque necesita conocer el id ANTES de crear la CTA, para
 *   poder incrustarlo en el customId de los botones del mensaje que publica
 *   (y ese mensaje tiene que existir antes de poder pasar su messageId aquí).
 *   `roleId`/`roleNombre` son opcionales (null si no se pasan): todavía no
 *   hay ninguna interfaz que cree/asigne un rol de Discord por CTA, pero el
 *   estado ya reserva el hueco para cuando la haya.
 * @returns {Promise<object>}
 */
export async function crearCta(filePath, datos) {
  for (const field of CREAR_CTA_REQUIRED_FIELDS) {
    if (!datos?.[field]) {
      throw new CtaError(`Falta "${field}" para crear la CTA.`);
    }
  }

  const now = new Date();
  const cierraEn = new Date(datos.cierraEn);
  if (Number.isNaN(cierraEn.getTime())) {
    throw new CtaError(`"${datos.cierraEn}" no es una fecha válida para cierraEn.`);
  }
  if (cierraEn.getTime() <= now.getTime()) {
    throw new CtaError('cierraEn debe ser una fecha futura.');
  }

  return withWriteLock(async () => {
    const raw = await readCtaFile(filePath);
    if (raw.activa) {
      const cierraEnSeconds = Math.floor(new Date(raw.activa.cierraEn).getTime() / 1000);
      throw new CtaError(
        `Ya hay una CTA activa en <#${raw.activa.channelId}>, cierra <t:${cierraEnSeconds}:R>. ` +
          'Solo puede haber una CTA a la vez.',
      );
    }

    const activa = {
      id: datos.id ?? `cta_${now.getTime()}`,
      nombre: datos.nombre,
      roleId: datos.roleId ?? null,
      roleNombre: datos.roleNombre ?? null,
      guildId: datos.guildId,
      channelId: datos.channelId,
      messageId: datos.messageId,
      creadorId: datos.creadorId,
      creadaEn: now.toISOString(),
      cierraEn: cierraEn.toISOString(),
      inscritos: [],
      sincronizada: true,
    };

    await writeCtaFile(filePath, activa);
    return activa;
  });
}

/**
 * Apunta (o actualiza) a un jugador en la CTA activa. Si `userId` ya estaba
 * inscrito, actualiza su nombre/roles SIN mover su posición en la lista —
 * cambiar de rol no debe reordenar las filas de la hoja para quien ya
 * estaba apuntado.
 * @param {string} filePath
 * @param {string} userId
 * @param {string} nombre - member.displayName si existe, si no el username
 * @param {string[]} roles
 * @returns {Promise<object>}
 */
export async function apuntar(filePath, userId, nombre, roles) {
  if (!userId) throw new CtaError('Falta userId.');
  if (!nombre) throw new CtaError('Falta nombre.');
  if (!Array.isArray(roles)) throw new CtaError('roles debe ser un array.');

  return withWriteLock(async () => {
    const raw = await readCtaFile(filePath);
    if (!raw.activa) {
      throw new CtaError('No hay ninguna CTA activa.');
    }

    const { inscritos } = raw.activa;
    const index = inscritos.findIndex((i) => i.userId === userId);

    const inscritosSiguientes =
      index === -1
        ? [...inscritos, { userId, nombre, roles, ts: new Date().toISOString() }]
        : inscritos.map((i, idx) => (idx === index ? { ...i, nombre, roles } : i));

    const activa = { ...raw.activa, inscritos: inscritosSiguientes };
    await writeCtaFile(filePath, activa);
    return activa;
  });
}

/**
 * Quita a un jugador de la CTA activa.
 * @param {string} filePath
 * @param {string} userId
 * @returns {Promise<object>}
 */
export async function desapuntar(filePath, userId) {
  return withWriteLock(async () => {
    const raw = await readCtaFile(filePath);
    if (!raw.activa) {
      throw new CtaError('No hay ninguna CTA activa.');
    }

    const index = raw.activa.inscritos.findIndex((i) => i.userId === userId);
    if (index === -1) {
      throw new CtaError('No estás apuntado a la CTA activa.');
    }

    const inscritosSiguientes = raw.activa.inscritos.filter((_, idx) => idx !== index);
    const activa = { ...raw.activa, inscritos: inscritosSiguientes };
    await writeCtaFile(filePath, activa);
    return activa;
  });
}

/**
 * Cierra la CTA activa (deja `activa: null`). La hoja NO se limpia al
 * cerrar: el listado final queda visible como registro hasta que la
 * siguiente crearCta() limpie el bloque al abrir.
 * @param {string} filePath
 * @returns {Promise<object>} la CTA que se acaba de cerrar
 */
export async function cerrarCta(filePath) {
  return withWriteLock(async () => {
    const raw = await readCtaFile(filePath);
    if (!raw.activa) {
      throw new CtaError('No hay ninguna CTA activa.');
    }

    const cerrada = raw.activa;
    await writeCtaFile(filePath, null);
    return cerrada;
  });
}

/**
 * Marca (o desmarca) la CTA activa como desincronizada de la hoja. La usa
 * ctaSheetSync.js cuando agota los reintentos de escribirBloque, y cuando
 * una sincronización posterior vuelve a tener éxito. Devuelve `null` (sin
 * escribir nada) si no hay CTA activa, si `ctaId` no coincide con la activa
 * actual (pudo cerrar entretanto), o si el valor ya era el mismo — así quien
 * llama sabe si hace falta avisar/reeditar el embed o si no cambió nada.
 * @param {string} filePath
 * @param {string} ctaId
 * @param {boolean} sincronizada
 * @returns {Promise<object | null>}
 */
export async function marcarSincronizacion(filePath, ctaId, sincronizada) {
  return withWriteLock(async () => {
    const raw = await readCtaFile(filePath);
    if (!raw.activa || raw.activa.id !== ctaId) return null;
    if ((raw.activa.sincronizada ?? true) === sincronizada) return null;

    const activa = { ...raw.activa, sincronizada };
    await writeCtaFile(filePath, activa);
    return activa;
  });
}
