import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { nivelEstrellas } from '../services/maestria.js';
import { truncateList } from './textTruncate.js';
import { ctaButtonCustomId } from './ctaEmbed.js';
import { emojiParaOpcion } from './emojiOption.js';

// Panel de asignación del caller (equivalente al tablero drag-and-drop de la
// web, aquí como selects encadenados). Todo el panel es EFÍMERO: solo lo ve
// quien lo abrió, así que las estrellas/labels se calculan una vez por
// interacción, no hay que preocuparse de "qué ve cada uno".

const OPTION_LABEL_MAX = 100; // límite real de Discord para el label de una opción de select
const OPTION_DESCRIPTION_MAX = 100; // ídem para la descripción
const NOMBRE_JUGADOR_MAX = 32;
const PAGE_SIZE = 25; // límite real de opciones de un select de Discord

// --- botones del panel principal ---
export const ACCION_PANEL_ASIGNAR = 'panel-asignar';
export const ACCION_PANEL_MOVER = 'panel-mover';
export const ACCION_PANEL_QUITAR = 'panel-quitar';
export const ACCION_PANEL_AUTORRELLENAR = 'panel-autorrellenar';
export const ACCION_PANEL_BLOQUEAR = 'panel-bloquear';
export const ACCION_PANEL_REFRESCAR = 'panel-refrescar';

// --- prefijos de los selects/paginación encadenados ---
// "-jugador" (select paso 1), "-jugador-pag:<pagina>" (botón de paginación
// del paso 1), "-slot:<userId>" (select paso 2, con el jugador embebido),
// "-slot-pag:<userId>:<pagina>" (paginación del paso 2).
export const PREFIJO_ASIGNAR_JUGADOR = 'panel-asignar-jugador';
export const PREFIJO_ASIGNAR_SLOT = 'panel-asignar-slot';
export const PREFIJO_MOVER_JUGADOR = 'panel-mover-jugador';
export const PREFIJO_MOVER_SLOT = 'panel-mover-slot';
export const PREFIJO_QUITAR_JUGADOR = 'panel-quitar-jugador';
export const PREFIJO_BLOQUEAR_JUGADOR = 'panel-bloquear-jugador';

function claveSlot(partyIdx, slotIdx) {
  return `${partyIdx}:${slotIdx}`;
}

function estrellasTexto(n) {
  return n > 0 ? ` ${'★'.repeat(n)}` : '';
}

function truncarNombreJugador(nombre) {
  if (nombre.length <= NOMBRE_JUGADOR_MAX) return nombre;
  return `${nombre.slice(0, NOMBRE_JUGADOR_MAX - 1)}…`;
}

/**
 * Cuántos slots de `rolKey` hay en total en la comp, y cuántos ya están
 * asignados. Base de la línea "quedan N slots" y del orden de prioridad de
 * "Asignar" (rol preferido menos cubierto primero).
 */
export function coberturaDeRol(cta, rolKey) {
  let total = 0;
  let asignados = 0;
  cta.comp.parties.forEach((party, partyIdx) => {
    party.slots.forEach((slotRol, slotIdx) => {
      if (slotRol !== rolKey) return;
      total += 1;
      if (cta.asignaciones[claveSlot(partyIdx, slotIdx)]) asignados += 1;
    });
  });
  return { asignados, total };
}

/**
 * "Fran ★★★★": nombre (recortado a 32 + "…") y las estrellas de su rol
 * PREFERIDO — el que va a acabar jugando casi siempre.
 */
function labelJugador(inscrito, maestria) {
  const estrellas = nivelEstrellas(maestria, inscrito.userId, inscrito.preferido);
  return `${truncarNombreJugador(inscrito.nombre)}${estrellasTexto(estrellas)}`.slice(0, OPTION_LABEL_MAX);
}

function entradaDeRolJugador(cta, inscrito, rolKey, maestria) {
  const rol = cta.comp.roles[rolKey];
  const categoria = rol.categoria ? cta.comp.categorias[rol.categoria] : null;
  const prefijo = categoria ? `${categoria.emoji} ` : '';
  const estrellas = nivelEstrellas(maestria, inscrito.userId, rolKey);
  return { texto: `${prefijo}${rol.nombre}${estrellasTexto(estrellas)}`, estrellas };
}

/**
 * "🔵 Maza Pesada ★★★★ · 🟣 HOJ ★ · 🟢 Santi ★★": desglose completo de sus
 * roles por maestría descendente. Si no cabe en 100 caracteres, se queda con
 * los 3 de más maestría y añade "+N" — nunca a medio rol (eso cortaría un
 * emoji personalizado y saldría como texto crudo).
 */
function descripcionJugador(cta, inscrito, maestria) {
  const entradas = inscrito.roles
    .map((rolKey) => entradaDeRolJugador(cta, inscrito, rolKey, maestria))
    .sort((a, b) => b.estrellas - a.estrellas);

  const completo = entradas.map((e) => e.texto).join(' · ');
  if (completo.length <= OPTION_DESCRIPTION_MAX) return completo;

  const top3 = entradas.slice(0, 3).map((e) => e.texto);
  const resto = entradas.length - 3;
  const conSufijo = resto > 0 ? `${top3.join(' · ')} +${resto}` : top3.join(' · ');
  if (conSufijo.length <= OPTION_DESCRIPTION_MAX) return conSufijo;

  // Caso extremo (nombres de rol larguísimos): ni el top 3 cabe. Recorta por
  // entradas completas, igual que un field del embed público.
  return truncateList(top3, OPTION_DESCRIPTION_MAX, {
    separator: ' · ',
    formatSuffix: (nDentroDelTop3) => `+${nDentroDelTop3 + resto}`,
  });
}

/**
 * Opciones de un select de jugador (mismo formato en Asignar/Mover/Quitar):
 * label = nombre + estrellas del preferido, descripción = desglose completo.
 * @param {object} cta
 * @param {object[]} inscritos
 * @param {object} maestria
 * @returns {import('discord.js').StringSelectMenuOptionBuilder[]}
 */
export function buildOpcionesJugador(cta, inscritos, maestria) {
  return inscritos.map((inscrito) => {
    const option = new StringSelectMenuOptionBuilder()
      .setValue(inscrito.userId)
      .setLabel(labelJugador(inscrito, maestria));
    const desc = descripcionJugador(cta, inscrito, maestria);
    if (desc) option.setDescription(desc);
    return option;
  });
}

/**
 * Igual que buildOpcionesJugador(), para el select de "Bloquear": antepone
 * 🔒 a quien ya tiene su slot bloqueado (elegirlo alterna el estado).
 */
export function buildOpcionesBloqueo(cta, inscritosAsignados, maestria) {
  return inscritosAsignados.map((inscrito) => {
    const asignacion = Object.values(cta.asignaciones).find((a) => a.userId === inscrito.userId);
    const bloqueado = Boolean(asignacion?.bloqueado);
    const option = new StringSelectMenuOptionBuilder()
      .setValue(inscrito.userId)
      .setLabel(`${bloqueado ? '🔒 ' : ''}${labelJugador(inscrito, maestria)}`.slice(0, OPTION_LABEL_MAX));

    const desc = descripcionJugador(cta, inscrito, maestria);
    const descFinal = bloqueado ? `Bloqueado · ${desc}` : desc;
    if (descFinal) option.setDescription(descFinal.slice(0, OPTION_DESCRIPTION_MAX));
    return option;
  });
}

/**
 * "Ordena poniendo primero a los que tienen el rol preferido menos
 * cubierto": prioridad = menor ratio asignados/total en SU rol preferido.
 * @param {object} cta
 * @param {object[]} inscritos
 * @returns {object[]}
 */
export function ordenarPorEscasezDePreferido(cta, inscritos) {
  return [...inscritos].sort((a, b) => {
    const covA = coberturaDeRol(cta, a.preferido);
    const covB = coberturaDeRol(cta, b.preferido);
    const ratioA = covA.total === 0 ? Number.POSITIVE_INFINITY : covA.asignados / covA.total;
    const ratioB = covB.total === 0 ? Number.POSITIVE_INFINITY : covB.asignados / covB.total;
    if (ratioA !== ratioB) return ratioA - ratioB;
    return a.nombre.localeCompare(b.nombre, 'en', { sensitivity: 'base' });
  });
}

/**
 * "🟢 Party 1 · Maza Pesada ★★": el emoji de categoría (unicode) SÍ va
 * inline en el texto porque unicode renderiza igual ahí que en el campo
 * `emoji`; el del arma NO — ver ui/emojiOption.js. El nombre del arma es lo
 * único que se recorta para caber en 100 caracteres: el resto (marca,
 * emoji de categoría, party, estrellas, y el sufijo de desambiguación si
 * hace falta) se reserva primero como presupuesto fijo.
 * @param {{ party: object, rol: object, categoria: object | null, estrellas: number, compatible: boolean, sufijoDesambiguacion?: string }} params
 */
function labelSlot({ party, rol, categoria, estrellas, compatible, sufijoDesambiguacion = '' }) {
  const marca = compatible ? '' : '⚠️ ';
  const prefijoCategoria = categoria ? `${categoria.emoji} ` : '';
  const prefijo = `${marca}${prefijoCategoria}${party.nombre} · `;
  const sufijo = (compatible ? estrellasTexto(estrellas) : '') + sufijoDesambiguacion;

  const maxNombre = Math.max(0, OPTION_LABEL_MAX - prefijo.length - sufijo.length);
  const nombre = rol.nombre.length > maxNombre ? `${rol.nombre.slice(0, Math.max(0, maxNombre - 1))}…` : rol.nombre;

  return `${prefijo}${nombre}${sufijo}`;
}

/**
 * Opciones de destino para "Asignar" (solo libres) o "Mover" (libres +
 * ocupados, para poder intercambiar). Compatibles primero (con las
 * estrellas de ESE jugador en ese rol), incompatibles al final, marcados y
 * sin estrellas — la web los permite igual, por si el caller quiere forzar.
 * Nunca ofrece un slot bloqueado, ni el propio slot actual del jugador.
 *
 * Dos slots del mismo rol en la misma party (frecuente: una party con
 * varios "Maza Pesada") producen el mismo label hasta que se desambiguan
 * con "#N" — se detecta en dos pasadas: primero se construyen todos los
 * labels tal cual, y solo a los que colisionan se les añade el sufijo (así
 * el 95% de las opciones, que no colisionan, no llevan un "#1" de más).
 * @param {object} params
 * @param {object} params.cta
 * @param {object} params.inscrito - a quien se le busca destino
 * @param {object} params.maestria
 * @param {boolean} params.incluirOcupados - true para "Mover" (permite intercambio)
 * @returns {import('discord.js').StringSelectMenuOptionBuilder[]}
 */
export function buildOpcionesSlot({ cta, inscrito, maestria, incluirOcupados }) {
  const entradas = [];

  cta.comp.parties.forEach((party, partyIdx) => {
    party.slots.forEach((rolKey, slotIdx) => {
      const key = claveSlot(partyIdx, slotIdx);
      const asignacion = cta.asignaciones[key];

      if (asignacion?.bloqueado) return;
      if (asignacion && asignacion.userId === inscrito.userId) return; // su propio slot: no es un destino
      if (asignacion && !incluirOcupados) return; // "Asignar" solo ofrece libres

      const rol = cta.comp.roles[rolKey];
      const categoria = rol.categoria ? cta.comp.categorias[rol.categoria] : null;
      const compatible = inscrito.roles.includes(rolKey);
      const estrellas = compatible ? nivelEstrellas(maestria, inscrito.userId, rolKey) : 0;

      entradas.push({ key, party, rolKey, rol, categoria, estrellas, compatible, asignacion });
    });
  });

  const veces = new Map(); // label base -> cuántas entradas lo producen
  for (const e of entradas) {
    const base = labelSlot(e);
    veces.set(base, (veces.get(base) ?? 0) + 1);
  }

  const contador = new Map(); // label base -> cuántas ya se han desambiguado
  const compatibles = [];
  const incompatibles = [];

  for (const e of entradas) {
    const base = labelSlot(e);
    let label = base;
    if (veces.get(base) > 1) {
      const n = (contador.get(base) ?? 0) + 1;
      contador.set(base, n);
      label = labelSlot({ ...e, sufijoDesambiguacion: ` #${n}` });
    }

    const option = new StringSelectMenuOptionBuilder().setValue(e.key).setLabel(label).setEmoji(emojiParaOpcion(e.rol.emoji));

    if (e.asignacion) {
      const ocupante = cta.inscritos.find((i) => i.userId === e.asignacion.userId);
      option.setDescription(
        `Ocupado por ${truncarNombreJugador(ocupante?.nombre ?? 'alguien')} · se intercambian`.slice(0, OPTION_DESCRIPTION_MAX),
      );
    } else {
      const { total, asignados } = coberturaDeRol(cta, e.rolKey);
      option.setDescription(`quedan ${total - asignados} slot(s) de este rol`.slice(0, OPTION_DESCRIPTION_MAX));
    }

    (e.compatible ? compatibles : incompatibles).push(option);
  }

  return [...compatibles, ...incompatibles];
}

function paginar(lista, pagina) {
  const totalPaginas = Math.max(1, Math.ceil(lista.length / PAGE_SIZE));
  const paginaSegura = Math.min(Math.max(0, pagina), totalPaginas - 1);
  const inicio = paginaSegura * PAGE_SIZE;
  return { pageItems: lista.slice(inicio, inicio + PAGE_SIZE), pagina: paginaSegura, totalPaginas };
}

function buildPaginacionRow(ctaId, accionPaginaBase, pagina, totalPaginas) {
  if (totalPaginas <= 1) return null;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(ctaButtonCustomId(ctaId, `${accionPaginaBase}:${pagina - 1}`))
      .setLabel('◀ Anterior')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pagina <= 0),
    new ButtonBuilder()
      .setCustomId(ctaButtonCustomId(ctaId, `${accionPaginaBase}:${pagina + 1}`))
      .setLabel(`Página ${pagina + 1}/${totalPaginas} ▶`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pagina >= totalPaginas - 1),
  );
}

/**
 * Envuelve una lista de opciones ya construidas en un mensaje efímero: el
 * select (paginado si hace falta) + fila de paginación. Devuelve null si no
 * hay ninguna opción (el caller decide qué decir en ese caso).
 * @param {object} params
 * @param {string} params.ctaId
 * @param {import('discord.js').StringSelectMenuOptionBuilder[]} params.opciones
 * @param {string} params.selectCustomId
 * @param {string} params.accionPaginaBase
 * @param {number} [params.pagina]
 * @param {string} params.placeholder
 * @param {string} params.encabezado
 * @returns {{ content: string, components: import('discord.js').ActionRowBuilder[] } | null}
 */
export function buildSelectPanelMessage({ ctaId, opciones, selectCustomId, accionPaginaBase, pagina = 0, placeholder, encabezado }) {
  if (opciones.length === 0) return null;

  const { pageItems, pagina: paginaFinal, totalPaginas } = paginar(opciones, pagina);

  const select = new StringSelectMenuBuilder()
    .setCustomId(selectCustomId)
    .setPlaceholder(placeholder)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(pageItems);

  const paginacionRow = buildPaginacionRow(ctaId, accionPaginaBase, paginaFinal, totalPaginas);

  return {
    content: `${encabezado}${totalPaginas > 1 ? ` (página ${paginaFinal + 1}/${totalPaginas})` : ''}`,
    components: [new ActionRowBuilder().addComponents(select), ...(paginacionRow ? [paginacionRow] : [])],
  };
}

function nombreDeNoLocalizable(cta, userId) {
  return cta.inscritos.find((i) => i.userId === userId)?.nombre ?? `<@${userId}>`;
}

/**
 * El panel principal: título con el nombre de la CTA y su canal (para no
 * confundir eventos si hay varias abiertas), un resumen rápido, y los 6
 * botones de acción.
 * @param {object} params
 * @param {object} params.cta
 * @returns {{ content: string, components: import('discord.js').ActionRowBuilder[] }}
 */
export function buildMainPanelMessage({ cta }) {
  const totalSlots = cta.comp.parties.reduce((acc, party) => acc + party.slots.length, 0);
  const asignados = Object.keys(cta.asignaciones).length;
  const sinAsignar = cta.inscritos.length - asignados;

  const fila1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(ctaButtonCustomId(cta.id, ACCION_PANEL_ASIGNAR)).setLabel('Asignar').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(ctaButtonCustomId(cta.id, ACCION_PANEL_MOVER)).setLabel('Mover').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(ctaButtonCustomId(cta.id, ACCION_PANEL_QUITAR)).setLabel('Quitar').setStyle(ButtonStyle.Danger),
  );
  const fila2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(ctaButtonCustomId(cta.id, ACCION_PANEL_AUTORRELLENAR))
      .setLabel('Autorrellenar')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(ctaButtonCustomId(cta.id, ACCION_PANEL_BLOQUEAR)).setLabel('Bloquear').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(ctaButtonCustomId(cta.id, ACCION_PANEL_REFRESCAR)).setLabel('Refrescar').setStyle(ButtonStyle.Secondary),
  );

  const noLocalizables = cta.noLocalizables ?? [];
  const lineaNoLocalizables =
    noLocalizables.length > 0
      ? `⚠️ No localizables (avísales por voz): ${noLocalizables.map((userId) => nombreDeNoLocalizable(cta, userId)).join(', ')}`
      : null;

  const content = [
    `**Panel de asignación — ${cta.nombre}** (<#${cta.channelId}>)`,
    `Asignados: ${asignados}/${totalSlots} · Sin asignar: ${sinAsignar}`,
    lineaNoLocalizables,
  ]
    .filter((linea) => linea !== null)
    .join('\n');

  return { content, components: [fila1, fila2] };
}
