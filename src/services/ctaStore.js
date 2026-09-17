import { createMutex, readJsonFile, backupCurrentFile, atomicWriteJson } from './fileStore.js';
import { leerMaestria, vecesJugado, jugadorQueRepiteRol } from './maestria.js';
import { ordenarRoles } from './ctaComp.js';

const CTA_VERSION = 2;
const BACKUP_PREFIX = 'cta';
const MODOS_VALIDOS = new Set(['caller', 'self', 'abierto']);

export class CtaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CtaError';
  }
}

// --- mutex propio: UN fichero (cta.json), UN candado global, cubriendo la
// secuencia completa leer-modificar-escribir. No es un candado por CTA: dos
// CTAs distintas escribiendo el mismo fichero a la vez se pisarían igual
// que dos altas en la misma CTA. ---
const { withWriteLock, waitForPendingWrites: waitForPendingCtaWrites } = createMutex();
export { waitForPendingCtaWrites };

function defaultCta() {
  return { version: CTA_VERSION, activas: {}, cerradasPendientes: {} };
}

// `cerradasPendientes` se añadió después de que CTA_VERSION ya fuera 2: un
// cta.json de esa época en disco es "formato nuevo" válido pero sin esa
// clave. Se normaliza aquí en vez de forzar una migración (que borraría las
// CTAs activas de quien lo tuviera abierto) — un campo aditivo no necesita
// una migración destructiva.
async function readCta(filePath) {
  const raw = await readJsonFile(filePath, defaultCta());
  return { ...defaultCta(), ...raw, activas: raw.activas ?? {}, cerradasPendientes: raw.cerradasPendientes ?? {} };
}

function buscarPorId(current, ctaId) {
  for (const [channelId, cta] of Object.entries(current.activas)) {
    if (cta.id === ctaId) return { channelId, cta };
  }
  return null;
}

function claveSlot(partyIdx, slotIdx) {
  return `${partyIdx}:${slotIdx}`;
}

function obtenerRolDeSlot(cta, partyIdx, slotIdx) {
  const party = cta.comp.parties[partyIdx];
  if (!party) {
    throw new CtaError(`No existe la party en la posición ${partyIdx}.`);
  }
  const rolKey = party.slots[slotIdx];
  if (rolKey === undefined) {
    throw new CtaError(`No existe el slot ${slotIdx} en la party "${party.nombre}".`);
  }
  return rolKey;
}

function buscarAsignacionDeUsuario(cta, userId) {
  for (const [key, asignacion] of Object.entries(cta.asignaciones)) {
    if (asignacion.userId === userId) return [key, asignacion];
  }
  return null;
}

function requireInscrito(cta, userId) {
  if (!cta.inscritos.some((i) => i.userId === userId)) {
    throw new CtaError('Ese usuario no está inscrito en esta CTA.');
  }
}

function requireString(value, label) {
  const str = String(value ?? '').trim();
  if (str.length === 0) {
    throw new CtaError(`"${label}" es obligatorio.`);
  }
  return str;
}

/**
 * Coloca a `userId` en el slot (partyIdx, slotIdx), mutando `cta` en sitio.
 * Núcleo compartido de asignar()/mover(): si el usuario ya tenía OTRA
 * asignación, la libera (es un movimiento, no un alta duplicada) — ver
 * "CLAVES DE ASIGNACIÓN" del prompt.
 */
function colocar(cta, { partyIdx, slotIdx, userId }) {
  const rolKey = obtenerRolDeSlot(cta, partyIdx, slotIdx);
  const key = claveSlot(partyIdx, slotIdx);
  const actual = cta.asignaciones[key];

  if (actual && actual.bloqueado) {
    throw new CtaError(`El slot ${key} está bloqueado.`);
  }
  if (actual && actual.userId !== userId) {
    throw new CtaError(`El slot ${key} ya está ocupado por otro usuario. Desasígnalo primero.`);
  }

  const anterior = buscarAsignacionDeUsuario(cta, userId);
  let movidoDesde = null;
  if (anterior && anterior[0] !== key) {
    delete cta.asignaciones[anterior[0]];
    movidoDesde = anterior[0];
  }

  cta.asignaciones[key] = { userId, bloqueado: false, avisadoEn: null };
  return { rolKey, movidoDesde };
}

function validarRolesDeclarados(cta, roles) {
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new CtaError('Debes declarar al menos un rol.');
  }
  const limpios = [];
  const vistos = new Set();
  for (const rawRol of roles) {
    const key = String(rawRol ?? '').trim().toLowerCase();
    if (!cta.comp.roles[key]) {
      throw new CtaError(`El rol "${key}" no existe en la composición de esta CTA.`);
    }
    if (!vistos.has(key)) {
      vistos.add(key);
      limpios.push(key);
    }
  }
  return limpios;
}

function validarPreferido(roles, preferido) {
  if (preferido === null || preferido === undefined || String(preferido).trim() === '') {
    return roles[0];
  }
  const key = String(preferido).trim().toLowerCase();
  if (!roles.includes(key)) {
    throw new CtaError(`El rol preferido "${key}" debe estar entre los roles declarados.`);
  }
  return key;
}

/**
 * Ejecuta `fn(cta)` sobre la CTA con id `ctaId` (localizada por id, NUNCA
 * por canal: quien llama ya sabe de cuál habla) dentro del mutex global,
 * persistiendo el resultado. `fn` muta `cta` en sitio y puede devolver datos
 * extra para el caller; si lanza, no se hace backup ni escritura.
 */
async function mutateCtaById(filePath, ctaId, fn) {
  return withWriteLock(async () => {
    const current = await readCta(filePath);
    const found = buscarPorId(current, ctaId);
    if (!found) {
      throw new CtaError(`No existe ninguna CTA activa con id "${ctaId}".`);
    }

    const extra = (await fn(found.cta)) ?? {};

    await backupCurrentFile(filePath, BACKUP_PREFIX);
    await atomicWriteJson(filePath, current);

    return { cta: found.cta, ...extra };
  });
}

// --- lecturas (sin mutex: el rename() atómico ya garantiza fichero completo) ---

/**
 * @param {string} filePath
 * @param {string} channelId
 * @returns {Promise<object | null>}
 */
export async function ctaDeCanal(filePath, channelId) {
  const current = await readCta(filePath);
  return current.activas[channelId] ?? null;
}

/**
 * @param {string} filePath
 * @param {string} ctaId
 * @returns {Promise<object | null>}
 */
export async function ctaPorId(filePath, ctaId) {
  const current = await readCta(filePath);
  return buscarPorId(current, ctaId)?.cta ?? null;
}

/**
 * @param {string} filePath
 * @returns {Promise<object[]>}
 */
export async function ctasActivas(filePath) {
  const current = await readCta(filePath);
  return Object.values(current.activas);
}

async function requireCtaPorId(filePath, ctaId) {
  const cta = await ctaPorId(filePath, ctaId);
  if (!cta) {
    throw new CtaError(`No existe ninguna CTA activa con id "${ctaId}".`);
  }
  return cta;
}

/**
 * @param {string} filePath
 * @param {string} ctaId
 * @returns {Promise<Array<{ partyIdx: number, slotIdx: number, rolKey: string }>>}
 */
export async function slotsLibres(filePath, ctaId) {
  const cta = await requireCtaPorId(filePath, ctaId);
  const libres = [];
  cta.comp.parties.forEach((party, partyIdx) => {
    party.slots.forEach((rolKey, slotIdx) => {
      if (!cta.asignaciones[claveSlot(partyIdx, slotIdx)]) {
        libres.push({ partyIdx, slotIdx, rolKey });
      }
    });
  });
  return libres;
}

/**
 * @param {string} filePath
 * @param {string} ctaId
 * @returns {Promise<object[]>} inscritos que no ocupan ningún slot
 */
export async function sinAsignar(filePath, ctaId) {
  const cta = await requireCtaPorId(filePath, ctaId);
  const asignados = new Set(Object.values(cta.asignaciones).map((a) => a.userId));
  return cta.inscritos.filter((i) => !asignados.has(i.userId));
}

/**
 * Roles cuyos slots no están todos cubiertos, con cuántos faltan y su
 * categoría (para poder mostrarlos agrupados/ordenados en un futuro embed).
 * @param {string} filePath
 * @param {string} ctaId
 */
export async function rolesQueFaltan(filePath, ctaId) {
  const cta = await requireCtaPorId(filePath, ctaId);
  const faltantes = new Map();

  cta.comp.parties.forEach((party, partyIdx) => {
    party.slots.forEach((rolKey, slotIdx) => {
      if (!cta.asignaciones[claveSlot(partyIdx, slotIdx)]) {
        faltantes.set(rolKey, (faltantes.get(rolKey) ?? 0) + 1);
      }
    });
  });

  return ordenarRoles(cta.comp)
    .filter(([rolKey]) => faltantes.has(rolKey))
    .map(([rolKey, rol]) => {
      const categoria = rol.categoria ? cta.comp.categorias[rol.categoria] : null;
      return {
        rolKey,
        rolNombre: rol.nombre,
        rolEmoji: rol.emoji,
        categoriaKey: rol.categoria,
        categoriaNombre: categoria?.nombre ?? null,
        categoriaEmoji: categoria?.emoji ?? null,
        faltan: faltantes.get(rolKey),
      };
    });
}

// --- mutaciones ---

/**
 * Crea una CTA nueva en `channelId` a partir de un snapshot ya resuelto de
 * la plantilla (quien llama debe haber hecho `ctaComp.getComp()` antes: este
 * store no conoce comps.json). `comp` se clona profundamente antes de
 * guardarse — nunca se referencia, para que editar la plantilla original más
 * tarde no cambie los slots bajo los pies de gente ya asignada.
 * @param {string} filePath
 * @param {object} datos
 * @returns {Promise<object>} la CTA creada
 * @throws {CtaError} si ya hay una CTA activa en ese canal
 */
export async function crearCta(filePath, datos) {
  const {
    nombre,
    compId,
    comp,
    modo,
    guildId,
    channelId,
    creadorId,
    callerId = null,
    ubicacion = '',
    notas = '',
    cierraEn,
    roleId = null,
    roleNombre = null,
    messageId = null,
  } = datos ?? {};

  const nombreLimpio = requireString(nombre, 'nombre');
  const compIdLimpio = requireString(compId, 'compId');
  if (comp === null || typeof comp !== 'object' || !comp.roles || !comp.parties || !comp.categorias) {
    throw new CtaError('"comp" (el snapshot de la plantilla) es obligatorio y debe tener roles/parties/categorias.');
  }
  if (!MODOS_VALIDOS.has(modo)) {
    throw new CtaError(`"modo" debe ser uno de: ${[...MODOS_VALIDOS].join(', ')}.`);
  }
  const guildIdLimpio = requireString(guildId, 'guildId');
  const channelIdLimpio = requireString(channelId, 'channelId');
  const creadorIdLimpio = requireString(creadorId, 'creadorId');
  if (modo === 'caller' && !callerId) {
    throw new CtaError('El modo "caller" requiere callerId.');
  }
  const cierraEnDate = new Date(cierraEn);
  if (Number.isNaN(cierraEnDate.getTime())) {
    throw new CtaError('"cierraEn" debe ser una fecha válida.');
  }

  return withWriteLock(async () => {
    const current = await readCta(filePath);

    // Una CTA por canal a propósito: es lo que permite resolver "de qué CTA
    // hablamos" en /cta cerrar, /cta ping, etc. sin pedir un parámetro extra.
    if (current.activas[channelIdLimpio]) {
      throw new CtaError(`Ya hay una CTA activa en este canal (id "${current.activas[channelIdLimpio].id}").`);
    }

    const cta = {
      id: `cta_${Date.now()}`,
      nombre: nombreLimpio,
      compId: compIdLimpio,
      comp: structuredClone(comp),
      modo,
      guildId: guildIdLimpio,
      channelId: channelIdLimpio,
      messageId,
      creadorId: creadorIdLimpio,
      callerId,
      ubicacion: String(ubicacion ?? ''),
      notas: String(notas ?? ''),
      cierraEn: cierraEnDate.toISOString(),
      roleId,
      roleNombre,
      inscritos: [],
      asignaciones: {},
      // userIds a los que el bot no pudo mandar un DM de asignación (DMs
      // cerrados): se muestran en el panel del caller para avisarles por voz.
      noLocalizables: [],
    };

    current.activas[channelIdLimpio] = cta;
    await backupCurrentFile(filePath, BACKUP_PREFIX);
    await atomicWriteJson(filePath, current);
    return cta;
  });
}

const CAMPOS_ACTUALIZABLES = new Set(['messageId', 'roleId', 'roleNombre', 'callerId']);

/**
 * Parche superficial de campos que solo se conocen DESPUÉS de crear la CTA
 * en Discord (el mensaje, el rol...). Lista blanca a propósito: no es un
 * mutateFn genérico, para no convertirse en la puerta trasera de todas las
 * demás funciones de este fichero.
 * @param {string} filePath
 * @param {string} ctaId
 * @param {Partial<{ messageId: string, roleId: string, roleNombre: string, callerId: string }>} patch
 */
export async function actualizarCta(filePath, ctaId, patch) {
  const { cta } = await mutateCtaById(filePath, ctaId, (cta) => {
    for (const [campo, valor] of Object.entries(patch ?? {})) {
      if (!CAMPOS_ACTUALIZABLES.has(campo)) {
        throw new CtaError(`El campo "${campo}" no se puede actualizar con actualizarCta().`);
      }
      cta[campo] = valor;
    }
  });
  return cta;
}

/**
 * Marca (o desmarca) a `userId` como "no localizable" (falló el DM de
 * asignación) para que el panel del caller lo muestre y le avisen por voz.
 * @param {string} filePath
 * @param {string} ctaId
 * @param {string} userId
 * @param {boolean} localizable - true para QUITARLO de la lista (un DM posterior sí llegó)
 */
export async function marcarLocalizable(filePath, ctaId, userId, localizable) {
  const { cta } = await mutateCtaById(filePath, ctaId, (cta) => {
    const lista = cta.noLocalizables ?? (cta.noLocalizables = []);
    const idx = lista.indexOf(userId);
    if (localizable && idx !== -1) lista.splice(idx, 1);
    if (!localizable && idx === -1) lista.push(userId);
  });
  return cta;
}

/**
 * Quita la CTA de `activas` y persiste. Solo la capa de datos: el envío del
 * resumen final a Discord, sumar maestría y sincronizar la hoja son de
 * prompts aparte (Z6/Z7) que llamarán a esto como su primer paso.
 * @param {string} filePath
 * @param {string} ctaId
 * @param {{ razon?: string }} [options]
 * @returns {Promise<object>} la CTA tal como estaba justo antes de cerrarse
 */
export async function cerrarCta(filePath, ctaId, { razon = 'manual' } = {}) {
  return withWriteLock(async () => {
    const current = await readCta(filePath);
    const found = buscarPorId(current, ctaId);
    if (!found) {
      throw new CtaError(`No existe ninguna CTA activa con id "${ctaId}".`);
    }

    delete current.activas[found.channelId];
    await backupCurrentFile(filePath, BACKUP_PREFIX);
    await atomicWriteJson(filePath, current);

    return { ...found.cta, razonCierre: razon };
  });
}

// --- volcado pendiente a Google Sheets ---
//
// La hoja de una CTA se escribe UNA sola vez, al cerrarla (ver ctaCierre.js):
// ya no hay un agrupador de 2s reescribiéndola en cada alta/movimiento. Si
// ese único volcado falla, la CTA cerrada (con todo lo necesario para
// reintentarlo: comp, inscritos, asignaciones...) se guarda aquí, indexada
// por canal igual que `activas` — así /cta sync puede resolverla sin pedir
// un id. Solo puede haber un volcado pendiente por canal: si una CTA
// posterior en el mismo canal también falla al cerrar, sustituye a la
// anterior (la de antes ya llevaba un aviso propio en el canal de logs).

/**
 * @param {string} filePath
 * @param {object} ctaCerrada - snapshot devuelto por cerrarCta(), con
 *   sheetTabName ya puesto si la pestaña llegó a crearse antes de que
 *   fallara la escritura.
 */
export async function guardarCierrePendiente(filePath, ctaCerrada) {
  return withWriteLock(async () => {
    const current = await readCta(filePath);
    current.cerradasPendientes[ctaCerrada.channelId] = ctaCerrada;
    await backupCurrentFile(filePath, BACKUP_PREFIX);
    await atomicWriteJson(filePath, current);
  });
}

/**
 * @param {string} filePath
 * @param {string} channelId
 * @returns {Promise<object | null>}
 */
export async function pendienteDeVolcarDeCanal(filePath, channelId) {
  const current = await readCta(filePath);
  return current.cerradasPendientes[channelId] ?? null;
}

/**
 * Quita la marca de "pendiente de volcar" de `channelId` (el volcado ya se
 * consiguió). No falla si no había ninguna.
 * @param {string} filePath
 * @param {string} channelId
 */
export async function quitarCierrePendiente(filePath, channelId) {
  return withWriteLock(async () => {
    const current = await readCta(filePath);
    delete current.cerradasPendientes[channelId];
    await backupCurrentFile(filePath, BACKUP_PREFIX);
    await atomicWriteJson(filePath, current);
  });
}

/**
 * Inscribe (o, si ya estaba inscrito, ACTUALIZA sus roles) sin tocar su
 * `ts` ni perder su asignación — salvo que el rol que tenía asignado ya no
 * esté entre los que declara ahora: en ese caso se le desasigna.
 * @param {string} filePath
 * @param {string} ctaId
 * @param {{ userId: string, nombre: string, roles: string[], preferido?: string, tentativo?: boolean }} datos
 */
export async function inscribir(filePath, ctaId, { userId, nombre, roles, preferido, tentativo = false }) {
  const userIdLimpio = requireString(userId, 'userId');
  const nombreLimpio = requireString(nombre, 'nombre');

  return mutateCtaById(filePath, ctaId, (cta) => {
    const rolesLimpios = validarRolesDeclarados(cta, roles);
    const preferidoLimpio = validarPreferido(rolesLimpios, preferido);

    const existente = cta.inscritos.find((i) => i.userId === userIdLimpio);
    let actualizado = false;
    let desasignado = false;

    if (existente) {
      existente.nombre = nombreLimpio;
      existente.roles = rolesLimpios;
      existente.preferido = preferidoLimpio;
      existente.tentativo = Boolean(tentativo);
      actualizado = true;

      const asignacion = buscarAsignacionDeUsuario(cta, userIdLimpio);
      if (asignacion) {
        const [key] = asignacion;
        const [partyIdx, slotIdx] = key.split(':').map(Number);
        const rolAsignado = cta.comp.parties[partyIdx].slots[slotIdx];
        if (!rolesLimpios.includes(rolAsignado)) {
          delete cta.asignaciones[key];
          desasignado = true;
        }
      }
    } else {
      cta.inscritos.push({
        userId: userIdLimpio,
        nombre: nombreLimpio,
        roles: rolesLimpios,
        preferido: preferidoLimpio,
        tentativo: Boolean(tentativo),
        ts: new Date().toISOString(),
      });
    }

    const inscrito = cta.inscritos.find((i) => i.userId === userIdLimpio);
    return { actualizado, desasignado, inscrito };
  });
}

/**
 * @param {string} filePath
 * @param {string} ctaId
 * @param {string} userId
 */
export async function desinscribir(filePath, ctaId, userId) {
  return mutateCtaById(filePath, ctaId, (cta) => {
    const index = cta.inscritos.findIndex((i) => i.userId === userId);
    if (index === -1) {
      throw new CtaError('Ese usuario no está inscrito en esta CTA.');
    }
    const [inscrito] = cta.inscritos.splice(index, 1);

    let liberoSlot = false;
    const asignacion = buscarAsignacionDeUsuario(cta, userId);
    if (asignacion) {
      delete cta.asignaciones[asignacion[0]];
      liberoSlot = true;
    }

    return { inscrito, liberoSlot };
  });
}

/**
 * Coloca a `userId` (ya inscrito) en (partyIdx, slotIdx). Si ya estaba
 * asignado a otra clave, la libera (es un movimiento, no una segunda alta).
 * @param {string} filePath
 * @param {string} ctaId
 * @param {{ partyIdx: number, slotIdx: number, userId: string }} datos
 */
export async function asignar(filePath, ctaId, { partyIdx, slotIdx, userId }) {
  return mutateCtaById(filePath, ctaId, (cta) => {
    requireInscrito(cta, userId);
    return colocar(cta, { partyIdx, slotIdx, userId });
  });
}

/**
 * Igual que asignar(), pero exige que el usuario YA tuviera una asignación
 * (si no, dile que use asignar): distingue la acción "mover" del panel de
 * la acción "asignar" de una alta en frío.
 *
 * Si el destino está ocupado por OTRO usuario, INTERCAMBIA a los dos en vez
 * de fallar — es lo que el caller quiere el 90% de las veces, y evita el
 * baile de quitar, asignar, asignar. Un slot bloqueado (origen o destino)
 * nunca se toca por esta vía: desbloquéalo primero.
 * @param {string} filePath
 * @param {string} ctaId
 * @param {{ userId: string, partyIdx: number, slotIdx: number }} datos
 * @returns {Promise<{ cta: object, rolKey: string, origenKey: string, destinoKey: string, intercambiadoCon: string | null }>}
 */
export async function mover(filePath, ctaId, { userId, partyIdx, slotIdx }) {
  return mutateCtaById(filePath, ctaId, (cta) => {
    requireInscrito(cta, userId);
    const origen = buscarAsignacionDeUsuario(cta, userId);
    if (!origen) {
      throw new CtaError('Ese usuario no tiene ninguna asignación todavía; usa asignar.');
    }
    const [origenKey, origenAsignacion] = origen;
    if (origenAsignacion.bloqueado) {
      throw new CtaError(`El slot ${origenKey} está bloqueado. Desbloquéalo antes de mover a su ocupante.`);
    }

    const rolKey = obtenerRolDeSlot(cta, partyIdx, slotIdx);
    const destinoKey = claveSlot(partyIdx, slotIdx);

    if (destinoKey === origenKey) {
      return { rolKey, origenKey, destinoKey, intercambiadoCon: null };
    }

    const destinoActual = cta.asignaciones[destinoKey];
    if (destinoActual && destinoActual.bloqueado) {
      throw new CtaError(`El slot ${destinoKey} está bloqueado.`);
    }

    if (destinoActual) {
      // Intercambio: el ocupante del destino pasa al slot de origen.
      cta.asignaciones[origenKey] = { userId: destinoActual.userId, bloqueado: false, avisadoEn: null };
      cta.asignaciones[destinoKey] = { userId, bloqueado: false, avisadoEn: null };
      return { rolKey, origenKey, destinoKey, intercambiadoCon: destinoActual.userId };
    }

    delete cta.asignaciones[origenKey];
    cta.asignaciones[destinoKey] = { userId, bloqueado: false, avisadoEn: null };
    return { rolKey, origenKey, destinoKey, intercambiadoCon: null };
  });
}

/**
 * @param {string} filePath
 * @param {string} ctaId
 * @param {{ partyIdx: number, slotIdx: number }} datos
 */
export async function desasignar(filePath, ctaId, { partyIdx, slotIdx }) {
  return mutateCtaById(filePath, ctaId, (cta) => {
    obtenerRolDeSlot(cta, partyIdx, slotIdx);
    const key = claveSlot(partyIdx, slotIdx);
    const liberado = cta.asignaciones[key];
    if (!liberado) {
      throw new CtaError(`El slot ${key} ya está vacío.`);
    }
    delete cta.asignaciones[key];
    return { liberado };
  });
}

/**
 * Marca (o desmarca) un slot YA asignado como bloqueado, para que
 * autorrellenar() nunca lo toque. No se puede bloquear un slot vacío: el
 * bloqueo es una propiedad de la asignación, no del hueco.
 * @param {string} filePath
 * @param {string} ctaId
 * @param {{ partyIdx: number, slotIdx: number, bloqueado: boolean }} datos
 */
export async function bloquear(filePath, ctaId, { partyIdx, slotIdx, bloqueado }) {
  return mutateCtaById(filePath, ctaId, (cta) => {
    obtenerRolDeSlot(cta, partyIdx, slotIdx);
    const key = claveSlot(partyIdx, slotIdx);
    const asignacion = cta.asignaciones[key];
    if (!asignacion) {
      throw new CtaError(`No se puede bloquear el slot ${key}: está vacío.`);
    }
    asignacion.bloqueado = Boolean(bloqueado);
    return { asignacion };
  });
}

/**
 * Recorre los slots vacíos en orden (party 0, slot 0, 1, 2... luego party 1...)
 * y les asigna, de entre los inscritos SIN asignación que declaren ese rol,
 * por este orden de prioridad: primero quien NO es tentativo (un tentativo
 * solo cubre un slot si no queda nadie confirmado que pueda jugarlo), luego
 * quien lo tiene como preferido, luego por mayor maestría en ese rol
 * (maestriaFilePath opcional; sin él, se trata como si nadie tuviera
 * historial), y por último quien se inscribió antes. Nunca toca un slot ya
 * ocupado (bloqueado o no) ni mueve a nadie que ya esté asignado.
 *
 * La maestría es solo el DESEMPATE dentro del grupo de preferencia, nunca el
 * criterio principal: a propósito, para que un rol nunca se "atrinquere" en
 * quien más lo ha jugado y alguien nuevo pueda entrar declarándolo
 * preferido. Ver avisosRotacion más abajo para el otro lado de ese mismo
 * riesgo.
 * @param {string} filePath
 * @param {string} ctaId
 * @param {{ maestriaFilePath?: string }} [options]
 * @returns {Promise<{ cta: object, asignados: Array<{partyIdx:number,slotIdx:number,rolKey:string,userId:string}>, sinCubrir: Array<{partyIdx:number,slotIdx:number,rolKey:string}>, avisosRotacion: Array<{rolKey:string,userId:string}> }>}
 */
export async function autorrellenar(filePath, ctaId, { maestriaFilePath } = {}) {
  const maestria = maestriaFilePath ? await leerMaestria(maestriaFilePath) : {};

  const { cta, asignados, sinCubrir } = await mutateCtaById(filePath, ctaId, (cta) => {
    const asignadosUserIds = new Set(Object.values(cta.asignaciones).map((a) => a.userId));
    const asignados = [];
    const sinCubrir = [];

    cta.comp.parties.forEach((party, partyIdx) => {
      party.slots.forEach((rolKey, slotIdx) => {
        const key = claveSlot(partyIdx, slotIdx);
        if (cta.asignaciones[key]) return;

        const candidatos = cta.inscritos.filter((i) => !asignadosUserIds.has(i.userId) && i.roles.includes(rolKey));

        if (candidatos.length === 0) {
          sinCubrir.push({ partyIdx, slotIdx, rolKey });
          return;
        }

        candidatos.sort((a, b) => {
          const tentA = a.tentativo ? 1 : 0;
          const tentB = b.tentativo ? 1 : 0;
          if (tentA !== tentB) return tentA - tentB; // confirmados antes que tentativos

          const prefA = a.preferido === rolKey ? 1 : 0;
          const prefB = b.preferido === rolKey ? 1 : 0;
          if (prefA !== prefB) return prefB - prefA;

          const vecesA = vecesJugado(maestria, a.userId, rolKey);
          const vecesB = vecesJugado(maestria, b.userId, rolKey);
          if (vecesA !== vecesB) return vecesB - vecesA;

          return new Date(a.ts).getTime() - new Date(b.ts).getTime();
        });

        const elegido = candidatos[0];
        cta.asignaciones[key] = { userId: elegido.userId, bloqueado: false, avisadoEn: null };
        asignadosUserIds.add(elegido.userId);
        asignados.push({ partyIdx, slotIdx, rolKey, userId: elegido.userId });
      });
    });

    return { asignados, sinCubrir };
  });

  // Puramente informativo: si a alguien lo acabamos de mandar a un rol que
  // en los últimos 5 cierres SIEMPRE cubrió la misma persona, que el caller
  // lo sepa y decida si quiere rotar. autorrellenar() nunca evita esto por
  // su cuenta.
  const avisosRotacion = [];
  for (const { rolKey, userId } of asignados) {
    const repite = jugadorQueRepiteRol(maestria, rolKey);
    if (repite && repite === userId) avisosRotacion.push({ rolKey, userId });
  }

  return { cta, asignados, sinCubrir, avisosRotacion };
}

/**
 * Si cta.json está en el formato viejo (una sola CTA activa en singular, o
 * el modelo previo de 3 roles de texto libre) lo cierra y lo reescribe en
 * el formato nuevo con "activas" vacío — no intenta inventar parties a
 * partir de tres roles de texto libre, no hay forma de hacerlo. Debe
 * llamarse una vez al arrancar, antes de reconciliar los temporizadores.
 * @param {string} filePath
 * @returns {Promise<{ migrado: boolean }>}
 */
export async function migrarCtaSiHaceFalta(filePath) {
  const raw = await readJsonFile(filePath, defaultCta());
  const esFormatoNuevo =
    raw && raw.version === CTA_VERSION && raw.activas && typeof raw.activas === 'object' && !Array.isArray(raw.activas);

  if (esFormatoNuevo) {
    return { migrado: false };
  }

  const habiaAlgo = raw && typeof raw === 'object' && Object.keys(raw).length > 0;

  await withWriteLock(async () => {
    await backupCurrentFile(filePath, BACKUP_PREFIX);
    await atomicWriteJson(filePath, defaultCta());
  });

  if (habiaAlgo) {
    console.warn(
      `[cta] "${filePath}" estaba en un formato antiguo (CTA en singular, o el modelo previo de 3 roles de ` +
        'texto libre). No hay forma de migrar ese contenido a parties/roles: se cerró y se reescribió en formato ' +
        'nuevo con "activas" vacío. Backup conservado en DATA_DIR/backups/.',
    );
  }

  return { migrado: Boolean(habiaAlgo) };
}
