import { SlashCommandBuilder, escapeMarkdown } from 'discord.js';
import { getComp, listarComps } from '../services/ctaComp.js';
import {
  crearCta,
  ctaDeCanal,
  ctaPorId,
  ctasActivas,
  actualizarCta,
  cerrarCta,
  inscribir,
  desinscribir,
  asignar,
  mover,
  desasignar,
  bloquear,
  autorrellenar,
  slotsLibres,
  CtaError,
} from '../services/ctaStore.js';
import { crearRolDeCta, reconciliarRolDeCta, CtaRoleError } from '../services/ctaRole.js';
import { leerMaestria } from '../services/maestria.js';
import { notificarAsignacion, notificarReasignacion, notificarAsignacionesEnLote } from '../ctaDm.js';
import { crearSesion, obtenerSesion, actualizarSesion, limpiarSesion } from '../services/ctaInscripcionSesion.js';
import {
  buildCtaEmbed,
  ctaButtonCustomId,
  parseCtaButtonCustomId,
  CTA_BOTON_APUNTARSE,
  CTA_BOTON_TENTATIVO,
  CTA_BOTON_SALIR,
  CTA_BOTON_PANEL,
} from '../ui/ctaEmbed.js';
import {
  buildPanelInscripcion,
  buildSelectorDeSlot,
  CTA_SELECT_ROLES,
  CTA_SELECT_PREFERIDO,
  CTA_SELECT_SLOT,
  CTA_BOTON_CONFIRMAR,
  CTA_BOTON_CANCELAR,
  SLOT_SKIP_VALUE,
} from '../ui/ctaInscripcion.js';
import {
  buildMainPanelMessage,
  buildOpcionesJugador,
  buildOpcionesBloqueo,
  buildOpcionesSlot,
  buildSelectPanelMessage,
  ordenarPorEscasezDePreferido,
  ACCION_PANEL_ASIGNAR,
  ACCION_PANEL_MOVER,
  ACCION_PANEL_QUITAR,
  ACCION_PANEL_AUTORRELLENAR,
  ACCION_PANEL_BLOQUEAR,
  ACCION_PANEL_REFRESCAR,
  PREFIJO_ASIGNAR_JUGADOR,
  PREFIJO_ASIGNAR_SLOT,
  PREFIJO_MOVER_JUGADOR,
  PREFIJO_MOVER_SLOT,
  PREFIJO_QUITAR_JUGADOR,
  PREFIJO_BLOQUEAR_JUGADOR,
} from '../ui/ctaPanel.js';
import { buildCompNotFoundEmbed } from '../ui/compEmbed.js';
import { errorEmbed } from '../ui/errorEmbed.js';
import { isOfficer } from '../permissions.js';
import { programarCierre, cancelarTemporizador } from '../ctaScheduler.js';
import { programarReedicion } from '../ctaEmbedSync.js';
import { cerrarCtaCompleta, reintentarVolcadoDeCanal } from '../ctaCierre.js';
import { notifyCtaRoleFailure } from '../logChannel.js';
import { CTA_PATH, CTA_COMPS_PATH, MAESTRIA_PATH } from '../dataPaths.js';

const AUTOCOMPLETE_LIMIT = 25;
const SUGGESTION_COUNT = 3;
const MODO_POR_DEFECTO = 'caller';

// Copia local, igual que attendance.js y comp.js: no hay un módulo
// compartido para esto en el repo.
function levenshteinDistance(a, b) {
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

function suggestClosestNames(input, names, limit = SUGGESTION_COUNT) {
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

export const data = new SlashCommandBuilder()
  .setName('cta')
  .setDescription('Gestiona las CTAs del gremio (solo oficiales)')
  .addSubcommand((sub) =>
    sub
      .setName('abrir')
      .setDescription('Abre una CTA nueva a partir de una plantilla de composición')
      .addStringOption((o) => o.setName('nombre').setDescription('Nombre de la CTA, ej. "Hellgate"').setRequired(true))
      .addStringOption((o) => o.setName('comp').setDescription('Plantilla de composición').setRequired(true).setAutocomplete(true))
      .addIntegerOption((o) =>
        o.setName('minutos').setDescription('Minutos hasta el cierre automático').setRequired(true).setMinValue(1),
      )
      .addStringOption((o) =>
        o
          .setName('modo')
          .setDescription('Cómo se asignan los slots (por defecto: el caller asigna)')
          .addChoices(
            { name: 'Caller asigna manualmente', value: 'caller' },
            { name: 'Auto-asignación al mejor slot libre', value: 'self' },
            { name: 'Abierto: cualquiera reclama un slot libre', value: 'abierto' },
          ),
      )
      .addStringOption((o) => o.setName('ubicacion').setDescription('Dónde es la CTA, ej. "Martlock"'))
      .addUserOption((o) => o.setName('caller').setDescription('Quien dirige (por defecto, quien lanza el comando)'))
      .addStringOption((o) => o.setName('notas').setDescription('Notas libres para la cabecera del embed')),
  )
  .addSubcommand((sub) =>
    sub.setName('ping').setDescription('Reenvía el DM de asignación a todos los ya asignados de la CTA de este canal'),
  )
  .addSubcommand((sub) =>
    sub.setName('voz').setDescription('Compara los asignados de la CTA de este canal contra tu canal de voz actual'),
  )
  .addSubcommand((sub) =>
    sub.setName('cerrar').setDescription('Cierra manualmente la CTA de este canal (sin borrar rol ni asignaciones)'),
  )
  .addSubcommand((sub) =>
    sub.setName('sync').setDescription('Reintenta la sincronización con Google Sheets de la CTA de este canal'),
  );

async function resolveComp(interaction, compInput) {
  let key = compInput.trim().toLowerCase();
  let comp = await getComp(CTA_COMPS_PATH, key);

  if (!comp) {
    const lista = await listarComps(CTA_COMPS_PATH);
    const porNombre = lista.find((c) => c.nombre.toLowerCase() === compInput.trim().toLowerCase());
    if (porNombre) {
      key = porNombre.key;
      comp = await getComp(CTA_COMPS_PATH, key);
    } else {
      const suggestions = suggestClosestNames(compInput, lista.map((c) => c.nombre));
      await interaction.editReply({ embeds: [buildCompNotFoundEmbed({ compInput, suggestions })] });
      return null;
    }
  }

  return { key, comp };
}

async function borrarRolHuerfano(role, motivo) {
  await role.delete(`CTA revertida: ${motivo}`).catch((error) => {
    console.error(`[cta] No se pudo borrar el rol huérfano ${role.id} (${motivo}):`, error?.stack ?? error);
  });
}

async function handleAbrir(interaction) {
  await interaction.deferReply();

  const nombre = interaction.options.getString('nombre', true);
  const compInput = interaction.options.getString('comp', true);
  const minutos = interaction.options.getInteger('minutos', true);
  const modo = interaction.options.getString('modo') ?? MODO_POR_DEFECTO;
  const ubicacion = interaction.options.getString('ubicacion') ?? '';
  const callerUser = interaction.options.getUser('caller') ?? interaction.user;
  const notas = interaction.options.getString('notas') ?? '';

  // Una CTA activa por canal: el canal es lo que permite resolver a qué CTA
  // se refiere cada comando futuro (/cta cerrar, el panel...) sin pedir un
  // parámetro extra. En otro canal se puede abrir sin problema.
  const existente = await ctaDeCanal(CTA_PATH, interaction.channelId);
  if (existente) {
    const cierra = Math.floor(new Date(existente.cierraEn).getTime() / 1000);
    await interaction.editReply({
      embeds: [
        errorEmbed(
          'Ya hay una CTA activa en este canal',
          `**${escapeMarkdown(existente.nombre)}** cierra <t:${cierra}:R>. Ábrela en otro canal, o espera a que cierre esta.`,
        ),
      ],
    });
    return;
  }

  const resolved = await resolveComp(interaction, compInput);
  if (!resolved) return;

  // El rol se crea ANTES de crear la CTA y antes de publicar el mensaje:
  // las comprobaciones (permiso, jerarquía, cupo) tienen que pasar antes de
  // que exista cualquier otro rastro de la CTA.
  const fechaCreacion = new Date();
  let rolCreado;
  try {
    rolCreado = await crearRolDeCta(interaction.guild, { nombreCta: nombre, fecha: fechaCreacion });
  } catch (error) {
    if (error instanceof CtaRoleError) {
      await interaction.editReply({ embeds: [errorEmbed('No se pudo crear el rol de la CTA', error.message)] });
      return;
    }
    throw error;
  }

  const cierraEn = new Date(fechaCreacion.getTime() + minutos * 60_000).toISOString();

  let cta;
  try {
    cta = await crearCta(CTA_PATH, {
      nombre,
      compId: resolved.key,
      comp: resolved.comp,
      modo,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      creadorId: interaction.user.id,
      callerId: callerUser.id,
      ubicacion,
      notas,
      cierraEn,
      roleId: rolCreado.role.id,
      roleNombre: rolCreado.role.name,
    });
  } catch (error) {
    await borrarRolHuerfano(rolCreado.role, 'no se pudo crear la CTA');
    if (error instanceof CtaError) {
      await interaction.editReply({ embeds: [errorEmbed('No se pudo abrir la CTA', error.message)] });
      return;
    }
    throw error;
  }

  // La propia respuesta del comando ES el mensaje público de la CTA.
  try {
    const { embeds, components } = buildCtaEmbed({ cta });
    await interaction.editReply({ embeds, components });
    const message = await interaction.fetchReply();
    await actualizarCta(CTA_PATH, cta.id, { messageId: message.id });
  } catch (error) {
    await cerrarCta(CTA_PATH, cta.id, { razon: 'fallo al publicar el mensaje' }).catch(() => {});
    await borrarRolHuerfano(rolCreado.role, 'no se pudo publicar el mensaje');
    throw error;
  }

  programarCierre(cta);

  if (rolCreado.avisoCapacidad) {
    await interaction
      .followUp({ embeds: [errorEmbed('Aviso de capacidad de roles', rolCreado.avisoCapacidad)], ephemeral: true })
      .catch(() => {});
  }
}

/**
 * /cta ping, /cta voz, /cta cerrar y /cta sync operan siempre sobre la CTA
 * del canal donde se invocan (nunca piden un id): si no hay ninguna activa
 * ahí, responde explicándolo y listando en qué canales sí la hay, en vez de
 * fallar en silencio. Asume que la interacción ya está deferida.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @returns {Promise<object | null>}
 */
async function resolveCtaDelCanalOResponder(interaction) {
  const cta = await ctaDeCanal(CTA_PATH, interaction.channelId);
  if (cta) return cta;

  const activas = await ctasActivas(CTA_PATH);
  const descripcion =
    activas.length > 0
      ? `No hay ninguna CTA activa en este canal. Sí hay una activa en: ${activas.map((c) => `<#${c.channelId}>`).join(', ')}.`
      : 'No hay ninguna CTA activa en este canal, ni en ningún otro.';

  await interaction.editReply({ embeds: [errorEmbed('No hay ninguna CTA activa aquí', descripcion)] });
  return null;
}

/**
 * Une cada asignación de `cta` con su rol y el nombre de su party, en el
 * formato que piden notificarAsignacion()/notificarAsignacionesEnLote().
 */
function listaAsignados(cta) {
  return Object.entries(cta.asignaciones).map(([key, asignacion]) => {
    const [partyIdx, slotIdx] = key.split(':').map(Number);
    const party = cta.comp.parties[partyIdx];
    const rolKey = party.slots[slotIdx];
    return { userId: asignacion.userId, rolKey, partyNombre: party.nombre };
  });
}

async function handlePing(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const cta = await resolveCtaDelCanalOResponder(interaction);
  if (!cta) return;

  const asignados = listaAsignados(cta);
  if (asignados.length === 0) {
    await interaction.editReply({ embeds: [errorEmbed('Nadie asignado todavía', 'No hay a quién reenviar el DM.')] });
    return;
  }

  const { enviados, fallidos } = await notificarAsignacionesEnLote(interaction.client, cta, asignados);
  await interaction.editReply(`📨 DMs reenviados: **${enviados}** enviados, **${fallidos}** fallidos.`);
}

async function handleVoz(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const cta = await resolveCtaDelCanalOResponder(interaction);
  if (!cta) return;

  const canalVoz = interaction.member.voice?.channel;
  if (!canalVoz) {
    await interaction.editReply({
      embeds: [errorEmbed('No estás en un canal de voz', 'Únete a un canal de voz para poder comparar quién falta.')],
    });
    return;
  }

  const enVoz = new Set(canalVoz.members.map((m) => m.id));
  const asignados = listaAsignados(cta);
  const faltan = asignados.filter((a) => !enVoz.has(a.userId));

  if (faltan.length === 0) {
    await interaction.editReply(`✅ Todos los asignados (${asignados.length}) están en ${canalVoz}.`);
    return;
  }

  const lineas = faltan.map((a) => `<@${a.userId}> — ${cta.comp.roles[a.rolKey]?.nombre ?? a.rolKey} (${escapeMarkdown(a.partyNombre)})`);
  await interaction.editReply(`⚠️ Faltan en ${canalVoz} (${faltan.length}/${asignados.length}):\n${lineas.join('\n')}`);
}

async function handleCerrar(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const cta = await resolveCtaDelCanalOResponder(interaction);
  if (!cta) return;

  cancelarTemporizador(cta.id);
  const resultado = await cerrarCtaCompleta(interaction.client, cta.id, { razon: 'manual' });
  const avisoVolcado = resultado.sheetVolcadoPendiente
    ? '\n⚠️ No se pudo volcar la hoja de cálculo; queda pendiente. Usa `/cta sync` en este canal para reintentarlo.'
    : '';
  await interaction.editReply(
    `🔒 CTA **${escapeMarkdown(cta.nombre)}** cerrada. El rol de Discord y las asignaciones se mantienen.${avisoVolcado}`,
  );
}

async function handleSync(interaction) {
  await interaction.deferReply({ ephemeral: true });

  // /cta sync ya no "sincroniza" la hoja de una CTA abierta (se escribe una
  // sola vez, al cerrarla): con una CTA abierta, en vez de eso reconcilia el
  // ROL de Discord contra quién está inscrito de verdad ahora mismo — eso sí
  // es estado en vivo, y es justo lo que un oficial espera de "sync" mientras
  // el evento sigue en marcha. Se comprueba primero lo abierto para no dar
  // un error críptico ni intentar volcar nada a la hoja todavía.
  const activa = await ctaDeCanal(CTA_PATH, interaction.channelId);
  if (activa) {
    const { otorgados, quitados, fallos } = await reconciliarRolDeCta(interaction.guild, activa);
    const resumenRol =
      otorgados.length === 0 && quitados.length === 0
        ? 'El rol ya estaba al día: nadie necesitaba que se lo tocaran.'
        : `Rol otorgado a ${otorgados.length} persona(s) y quitado a ${quitados.length}.`;
    const avisoFallos = fallos.length > 0 ? `\n⚠️ ${fallos.length} fallo(s) tocando el rol; revísalo.` : '';
    await interaction.editReply(
      `ℹ️ Esta CTA sigue abierta: la hoja de cálculo se escribe una sola vez, al cerrarla. ${resumenRol}${avisoFallos}`,
    );
    return;
  }

  const resultado = await reintentarVolcadoDeCanal(interaction.channelId);
  if (resultado.nada) {
    await interaction.editReply('✅ No hay ningún volcado a la hoja pendiente en este canal.');
    return;
  }
  if (!resultado.ok) {
    const mensaje = resultado.error instanceof Error ? resultado.error.message : String(resultado.error);
    await interaction.editReply({ embeds: [errorEmbed('No se pudo volcar la hoja', mensaje)] });
    return;
  }
  await interaction.editReply(
    resultado.omitido
      ? 'ℹ️ Google Sheets no está configurado en este bot; no hay nada que sincronizar.'
      : `✅ Hoja de **${escapeMarkdown(resultado.ctaNombre)}** volcada correctamente.`,
  );
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  if (!isOfficer(interaction)) {
    await interaction.reply({
      embeds: [errorEmbed('Sin permiso', 'Este comando es solo para el rol de oficiales.')],
      ephemeral: true,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'abrir') {
    await handleAbrir(interaction);
    return;
  }
  if (subcommand === 'ping') {
    await handlePing(interaction);
    return;
  }
  if (subcommand === 'voz') {
    await handleVoz(interaction);
    return;
  }
  if (subcommand === 'cerrar') {
    await handleCerrar(interaction);
    return;
  }
  if (subcommand === 'sync') {
    await handleSync(interaction);
    return;
  }
  throw new Error(`Subcomando desconocido: ${subcommand}`);
}

/**
 * @param {import('discord.js').AutocompleteInteraction} interaction
 */
export async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'comp') {
    await interaction.respond([]);
    return;
  }

  try {
    const comps = await listarComps(CTA_COMPS_PATH);
    const query = String(focused.value).toLowerCase();
    const choices = comps
      .filter((c) => c.nombre.toLowerCase().includes(query))
      .slice(0, AUTOCOMPLETE_LIMIT)
      .map((c) => ({ name: c.nombre, value: c.key }));
    await interaction.respond(choices);
  } catch (error) {
    console.error('Error en autocomplete de /cta:', error);
    await interaction.respond([]).catch(() => {});
  }
}

// === Botones y selects del embed de una CTA (Apuntarse/Tentativo/Salir/
// Panel del caller, y el panel de inscripción que abren los dos primeros) ===
// Se enrutan por customId (ver ui/ctaEmbed.js), nunca por canal: un botón
// pulsado en un mensaje viejo tiene que operar sobre SU CTA, no sobre la que
// esté abierta ahora en ese canal.

/**
 * @param {string} customId
 * @returns {boolean}
 */
export function isCtaComponent(customId) {
  return parseCtaButtonCustomId(customId) !== null;
}

async function otorgarRolDiscord(interaction, cta) {
  if (!cta.roleId) return { fallo: false };
  try {
    await interaction.member.roles.add(cta.roleId, `Inscripción en CTA "${cta.nombre}"`);
    return { fallo: false };
  } catch (error) {
    console.error(`[cta] No se pudo dar el rol ${cta.roleId} a ${interaction.user.id} en la CTA ${cta.id}:`, error?.stack ?? error);
    await notifyCtaRoleFailure(interaction.client, { ctaId: cta.id, userId: interaction.user.id, action: 'asignar', error });
    return { fallo: true };
  }
}

async function quitarRolDiscord(interaction, cta) {
  if (!cta.roleId) return { fallo: false };
  try {
    await interaction.member.roles.remove(cta.roleId, `Salida de la CTA "${cta.nombre}"`);
    return { fallo: false };
  } catch (error) {
    console.error(`[cta] No se pudo quitar el rol ${cta.roleId} a ${interaction.user.id} en la CTA ${cta.id}:`, error?.stack ?? error);
    await notifyCtaRoleFailure(interaction.client, { ctaId: cta.id, userId: interaction.user.id, action: 'quitar', error });
    return { fallo: true };
  }
}

/**
 * Recorre `roles` empezando por `preferido` y devuelve el primer slot libre
 * que encaje con alguno (slotsLibresList ya viene en orden party/slot).
 */
function elegirPrimerSlotCompatible(slotsLibresList, roles, preferido) {
  const orden = [preferido, ...roles.filter((r) => r !== preferido)];
  for (const rolKey of orden) {
    const slot = slotsLibresList.find((s) => s.rolKey === rolKey);
    if (slot) return slot;
  }
  return null;
}

async function handleAbrirPanel(interaction, ctaId, { tentativo }) {
  const cta = await ctaPorId(CTA_PATH, ctaId);
  if (!cta) {
    await interaction.reply({ embeds: [errorEmbed('Esta CTA ya no está activa', 'Puede que se haya cerrado.')], ephemeral: true });
    return;
  }

  // Si ya estaba inscrito, el panel llega con sus roles actuales
  // premarcados; lo que envíe al confirmar sustituye a lo anterior.
  const existente = cta.inscritos.find((i) => i.userId === interaction.user.id);
  const seleccionRoles = existente?.roles ?? [];
  const seleccionPreferido = existente?.preferido ?? null;

  const maestria = await leerMaestria(MAESTRIA_PATH);
  const panel = buildPanelInscripcion({ cta, userId: interaction.user.id, maestria, seleccionRoles, seleccionPreferido, tentativo });

  await interaction.reply({ ...panel, ephemeral: true });
  const message = await interaction.fetchReply();
  crearSesion(message.id, { ctaId, roles: seleccionRoles, preferido: seleccionPreferido, tentativo });
}

async function handleSeleccionRoles(interaction, ctaId) {
  const sesion = obtenerSesion(interaction.message.id);
  if (!sesion) {
    await interaction.reply({ content: 'Esta selección expiró. Vuelve a pulsar "Apuntarse".', ephemeral: true });
    return;
  }

  const cta = await ctaPorId(CTA_PATH, ctaId);
  if (!cta) {
    limpiarSesion(interaction.message.id);
    await interaction.update({ content: 'Esta CTA ya cerró.', embeds: [], components: [] });
    return;
  }

  actualizarSesion(interaction.message.id, { roles: interaction.values });
  const maestria = await leerMaestria(MAESTRIA_PATH);
  const panel = buildPanelInscripcion({
    cta,
    userId: interaction.user.id,
    maestria,
    tentativo: sesion.tentativo,
    seleccionRoles: interaction.values,
    seleccionPreferido: sesion.preferido,
  });
  await interaction.update(panel);
}

async function handleSeleccionPreferido(interaction, ctaId) {
  const sesion = obtenerSesion(interaction.message.id);
  if (!sesion) {
    await interaction.reply({ content: 'Esta selección expiró. Vuelve a pulsar "Apuntarse".', ephemeral: true });
    return;
  }

  const cta = await ctaPorId(CTA_PATH, ctaId);
  if (!cta) {
    limpiarSesion(interaction.message.id);
    await interaction.update({ content: 'Esta CTA ya cerró.', embeds: [], components: [] });
    return;
  }

  const preferido = interaction.values[0];
  actualizarSesion(interaction.message.id, { preferido });
  const maestria = await leerMaestria(MAESTRIA_PATH);
  const panel = buildPanelInscripcion({
    cta,
    userId: interaction.user.id,
    maestria,
    tentativo: sesion.tentativo,
    seleccionRoles: sesion.roles,
    seleccionPreferido: preferido,
  });
  await interaction.update(panel);
}

async function handleConfirmar(interaction, ctaId) {
  const sesion = obtenerSesion(interaction.message.id);
  if (!sesion) {
    await interaction.reply({ content: 'Esta selección expiró. Vuelve a pulsar "Apuntarse".', ephemeral: true });
    return;
  }

  // Cierre entre que se abrió el panel y se envió: con veinte personas
  // apuntándose a la vez, esto pasa de verdad.
  const cta = await ctaPorId(CTA_PATH, ctaId);
  if (!cta) {
    limpiarSesion(interaction.message.id);
    await interaction.update({ content: 'Esta CTA ya cerró. No se guardó la inscripción.', embeds: [], components: [] });
    return;
  }

  if (sesion.roles.length === 0) {
    await interaction.reply({ content: 'Elige al menos un rol antes de confirmar.', ephemeral: true });
    return;
  }
  if (!sesion.preferido || !sesion.roles.includes(sesion.preferido)) {
    await interaction.reply({
      content: 'Tu rol preferido tiene que estar entre los roles que marcaste. Corrígelo y vuelve a confirmar.',
      ephemeral: true,
    });
    return;
  }

  limpiarSesion(interaction.message.id);

  // 1. Estado local PRIMERO: la inscripción.
  await inscribir(CTA_PATH, ctaId, {
    userId: interaction.user.id,
    nombre: interaction.user.username,
    roles: sesion.roles,
    preferido: sesion.preferido,
    tentativo: sesion.tentativo,
  });

  // 2. Estado local: auto-asignación en modo self, ANTES del rol de
  // Discord (lo único que puede fallar sin deshacer nada de lo anterior).
  let asignacionInfo = null;
  if (cta.modo === 'self') {
    const libres = await slotsLibres(CTA_PATH, ctaId);
    asignacionInfo = elegirPrimerSlotCompatible(libres, sesion.roles, sesion.preferido);
    if (asignacionInfo) {
      await asignar(CTA_PATH, ctaId, {
        partyIdx: asignacionInfo.partyIdx,
        slotIdx: asignacionInfo.slotIdx,
        userId: interaction.user.id,
      });
    }
  }

  // 3. El rol de Discord: si falla, se confirma igual y se avisa.
  const { fallo: falloRol } = await otorgarRolDiscord(interaction, cta);
  const avisoRol = falloRol ? '\n⚠️ No se pudo asignar el rol de Discord automáticamente; llegará en breve.' : '';

  programarReedicion(interaction.client, ctaId);

  if (cta.modo === 'abierto') {
    const libres = await slotsLibres(CTA_PATH, ctaId);
    const compatibles = libres.filter((s) => sesion.roles.includes(s.rolKey));

    if (compatibles.length === 0) {
      await interaction.update({
        content: `✅ Apuntado. Ahora mismo no hay ningún slot libre de tus roles; quedas sin asignar hasta que se libere uno.${avisoRol}`,
        embeds: [],
        components: [],
      });
      return;
    }

    const selector = buildSelectorDeSlot({ cta, slotsCompatibles: compatibles });
    await interaction.update({ content: `${selector.content}${avisoRol}`, embeds: [], components: selector.components });
    crearSesion(interaction.message.id, { ctaId, fase: 'slot' });
    return;
  }

  if (cta.modo === 'self') {
    if (asignacionInfo) {
      const rol = cta.comp.roles[asignacionInfo.rolKey];
      const party = cta.comp.parties[asignacionInfo.partyIdx];
      notificarAsignacion(interaction.client, cta, interaction.user.id, { rolKey: asignacionInfo.rolKey, partyNombre: party.nombre }).catch(() => {});
      await interaction.update({
        content: `✅ Asignado a **${escapeMarkdown(party.nombre)}** como ${rol.emoji} ${escapeMarkdown(rol.nombre)}.${avisoRol}`,
        embeds: [],
        components: [],
      });
    } else {
      const rolesTexto = sesion.roles.map((r) => escapeMarkdown(cta.comp.roles[r].nombre)).join(', ');
      await interaction.update({
        content: `✅ Apuntado. Ahora mismo no hay ningún slot libre de tus roles (${rolesTexto}); el caller te asignará cuando se libere uno.${avisoRol}`,
        embeds: [],
        components: [],
      });
    }
    return;
  }

  // modo "caller": se queda en "Sin asignar" hasta que el caller lo siente.
  await interaction.update({
    content: `✅ Apuntado a **${escapeMarkdown(cta.nombre)}**. El caller te asignará un sitio.${avisoRol}`,
    embeds: [],
    components: [],
  });
}

async function handleSeleccionSlot(interaction, ctaId) {
  limpiarSesion(interaction.message.id);
  const valor = interaction.values[0];

  const cta = await ctaPorId(CTA_PATH, ctaId);
  if (!cta) {
    await interaction.update({ content: 'Esta CTA ya cerró.', embeds: [], components: [] });
    return;
  }

  if (valor === SLOT_SKIP_VALUE) {
    await interaction.update({ content: '✅ Apuntado, sin asignar por ahora.', embeds: [], components: [] });
    return;
  }

  const [partyIdx, slotIdx] = valor.split(':').map(Number);
  try {
    await asignar(CTA_PATH, ctaId, { partyIdx, slotIdx, userId: interaction.user.id });
  } catch (error) {
    if (error instanceof CtaError) {
      await interaction.update({
        content: `No se pudo asignar ese slot (puede que alguien se te haya adelantado): ${error.message}`,
        embeds: [],
        components: [],
      });
      return;
    }
    throw error;
  }

  programarReedicion(interaction.client, ctaId);

  const rolKey = cta.comp.parties[partyIdx].slots[slotIdx];
  const rol = cta.comp.roles[rolKey];
  const party = cta.comp.parties[partyIdx];
  notificarAsignacion(interaction.client, cta, interaction.user.id, { rolKey, partyNombre: party.nombre }).catch(() => {});
  await interaction.update({
    content: `✅ Asignado a **${escapeMarkdown(party.nombre)}** como ${rol.emoji} ${escapeMarkdown(rol.nombre)}.`,
    embeds: [],
    components: [],
  });
}

async function handleSalir(interaction, ctaId) {
  const cta = await ctaPorId(CTA_PATH, ctaId);
  if (!cta) {
    await interaction.reply({ content: 'Esta CTA ya no está activa.', ephemeral: true });
    return;
  }

  let resultado;
  try {
    resultado = await desinscribir(CTA_PATH, ctaId, interaction.user.id);
  } catch (error) {
    if (error instanceof CtaError) {
      await interaction.reply({ content: 'No estabas inscrito en esta CTA.', ephemeral: true });
      return;
    }
    throw error;
  }

  const { fallo: falloRol } = await quitarRolDiscord(interaction, cta);
  programarReedicion(interaction.client, ctaId);

  const avisoSlot = resultado.liberoSlot ? ' Tu slot queda libre.' : '';
  const avisoRol = falloRol ? '\n⚠️ No se pudo quitar el rol de Discord automáticamente; se revisará.' : '';
  await interaction.reply({ content: `Has salido de **${escapeMarkdown(cta.nombre)}**.${avisoSlot}${avisoRol}`, ephemeral: true });
}

async function handleCancelar(interaction) {
  limpiarSesion(interaction.message.id);
  await interaction.update({ content: 'Cancelado, no se guardó nada.', embeds: [], components: [] });
}

async function handlePanelCaller(interaction, ctaId) {
  const cta = await ctaPorId(CTA_PATH, ctaId);
  if (!cta) {
    await interaction.reply({ content: 'Esta CTA ya no está activa.', ephemeral: true });
    return;
  }

  // Solo oficiales y el caller de ESTA CTA; a los demás, ephemeral
  // diciendo que no es para ellos (nunca se esconde el botón).
  const autorizado = isOfficer(interaction) || interaction.user.id === cta.callerId;
  if (!autorizado) {
    await interaction.reply({ content: 'El panel del caller es solo para oficiales y para el caller de esta CTA.', ephemeral: true });
    return;
  }

  const panel = buildMainPanelMessage({ cta });
  await interaction.reply({ ...panel, ephemeral: true });
}

// === Panel de asignación: Asignar/Mover/Quitar/Autorrellenar/Bloquear/
// Refrescar. Todo el panel es una cadena de reediciones (interaction.update)
// del MISMO mensaje efímero abierto por "Panel del caller" — nunca crea
// mensajes nuevos, así que Discord ya garantiza que solo lo ve/toca quien lo
// abrió (no hace falta repetir la comprobación de permisos en cada paso).
//
// CONCURRENCIA: cada mutación (asignar/mover/desasignar/bloquear) relee el
// estado dentro de su propio mutex al escribir (ver ctaStore.js); si algo
// cambió entre que se pintó un select y se pulsó, el CtaError resultante se
// captura aquí y se repinta el paso con el aviso, en vez de dejar el panel
// con una opción que ya no es válida.

function nombreDe(cta, userId) {
  return cta.inscritos.find((i) => i.userId === userId)?.nombre ?? userId;
}

async function volverAlPanelPrincipal(interaction, cta, mensaje) {
  const panel = buildMainPanelMessage({ cta });
  await interaction.update({ content: mensaje ? `${mensaje}\n\n${panel.content}` : panel.content, embeds: [], components: panel.components });
}

async function requireCtaParaPaso(interaction, ctaId) {
  const cta = await ctaPorId(CTA_PATH, ctaId);
  if (!cta) {
    await interaction.update({ content: 'Esta CTA ya cerró.', embeds: [], components: [] });
    return null;
  }
  return cta;
}

function asignadosDe(cta) {
  const asignadosIds = new Set(Object.values(cta.asignaciones).map((a) => a.userId));
  return cta.inscritos.filter((i) => asignadosIds.has(i.userId)).sort((a, b) => a.nombre.localeCompare(b.nombre, 'en', { sensitivity: 'base' }));
}

// --- Asignar ---

async function mostrarPasoJugadorAsignar(interaction, cta, pagina, aviso = '') {
  const maestria = await leerMaestria(MAESTRIA_PATH);
  const asignadosIds = new Set(Object.values(cta.asignaciones).map((a) => a.userId));
  const candidatos = ordenarPorEscasezDePreferido(cta, cta.inscritos.filter((i) => !asignadosIds.has(i.userId)));

  if (candidatos.length === 0) {
    await volverAlPanelPrincipal(interaction, cta, `${aviso}No hay nadie sin asignar.`);
    return;
  }

  const opciones = buildOpcionesJugador(cta, candidatos, maestria);
  const mensaje = buildSelectPanelMessage({
    ctaId: cta.id,
    opciones,
    selectCustomId: ctaButtonCustomId(cta.id, PREFIJO_ASIGNAR_JUGADOR),
    accionPaginaBase: `${PREFIJO_ASIGNAR_JUGADOR}-pag`,
    pagina,
    placeholder: 'Elige un jugador',
    encabezado: `${aviso}**Asignar** — elige a quién:`,
  });
  await interaction.update({ ...mensaje, embeds: [] });
}

async function mostrarPasoSlotAsignar(interaction, cta, userId, pagina, aviso = '') {
  const jugador = cta.inscritos.find((i) => i.userId === userId);
  if (!jugador) {
    await volverAlPanelPrincipal(interaction, cta, `${aviso}Ese jugador ya no está inscrito.`);
    return;
  }

  const maestria = await leerMaestria(MAESTRIA_PATH);
  const opciones = buildOpcionesSlot({ cta, inscrito: jugador, maestria, incluirOcupados: false });

  if (opciones.length === 0) {
    await volverAlPanelPrincipal(interaction, cta, `${aviso}No hay ningún slot libre para ${escapeMarkdown(jugador.nombre)}.`);
    return;
  }

  const mensaje = buildSelectPanelMessage({
    ctaId: cta.id,
    opciones,
    selectCustomId: ctaButtonCustomId(cta.id, `${PREFIJO_ASIGNAR_SLOT}:${userId}`),
    accionPaginaBase: `${PREFIJO_ASIGNAR_SLOT}-pag:${userId}`,
    pagina,
    placeholder: 'Elige un slot',
    encabezado: `${aviso}**Asignar** a ${escapeMarkdown(jugador.nombre)} — elige el slot:`,
  });
  await interaction.update({ ...mensaje, embeds: [] });
}

async function handlePanelAsignarInicio(interaction, ctaId) {
  const cta = await requireCtaParaPaso(interaction, ctaId);
  if (!cta) return;
  await mostrarPasoJugadorAsignar(interaction, cta, 0);
}

async function handlePanelAsignarJugadorPagina(interaction, ctaId, pagina) {
  const cta = await requireCtaParaPaso(interaction, ctaId);
  if (!cta) return;
  await mostrarPasoJugadorAsignar(interaction, cta, pagina);
}

async function handleSeleccionJugadorAsignar(interaction, ctaId) {
  const cta = await requireCtaParaPaso(interaction, ctaId);
  if (!cta) return;
  await mostrarPasoSlotAsignar(interaction, cta, interaction.values[0], 0);
}

async function handlePanelAsignarSlotPagina(interaction, ctaId, userId, pagina) {
  const cta = await requireCtaParaPaso(interaction, ctaId);
  if (!cta) return;
  await mostrarPasoSlotAsignar(interaction, cta, userId, pagina);
}

async function handleSeleccionSlotAsignar(interaction, ctaId, userId) {
  const cta = await requireCtaParaPaso(interaction, ctaId);
  if (!cta) return;

  const [partyIdx, slotIdx] = interaction.values[0].split(':').map(Number);

  let resultado;
  try {
    resultado = await asignar(CTA_PATH, ctaId, { partyIdx, slotIdx, userId });
  } catch (error) {
    if (error instanceof CtaError) {
      const ctaFresca = await ctaPorId(CTA_PATH, ctaId);
      if (!ctaFresca) {
        await interaction.update({ content: 'Esta CTA ya cerró.', embeds: [], components: [] });
        return;
      }
      await mostrarPasoSlotAsignar(interaction, ctaFresca, userId, 0, `⚠️ ${error.message}\n\n`);
      return;
    }
    throw error;
  }

  programarReedicion(interaction.client, ctaId);
  const ctaFinal = await ctaPorId(CTA_PATH, ctaId);
  const rol = ctaFinal.comp.roles[resultado.rolKey];
  const party = ctaFinal.comp.parties[partyIdx];
  notificarAsignacion(interaction.client, ctaFinal, userId, { rolKey: resultado.rolKey, partyNombre: party.nombre }).catch(() => {});
  await volverAlPanelPrincipal(
    interaction,
    ctaFinal,
    `✅ ${escapeMarkdown(nombreDe(ctaFinal, userId))} asignado a **${escapeMarkdown(party.nombre)}** (${rol.emoji} ${escapeMarkdown(rol.nombre)}).`,
  );
}

// --- Mover ---

async function mostrarPasoJugadorMover(interaction, cta, pagina, aviso = '') {
  const maestria = await leerMaestria(MAESTRIA_PATH);
  const candidatos = asignadosDe(cta);

  if (candidatos.length === 0) {
    await volverAlPanelPrincipal(interaction, cta, `${aviso}No hay nadie asignado todavía.`);
    return;
  }

  const opciones = buildOpcionesJugador(cta, candidatos, maestria);
  const mensaje = buildSelectPanelMessage({
    ctaId: cta.id,
    opciones,
    selectCustomId: ctaButtonCustomId(cta.id, PREFIJO_MOVER_JUGADOR),
    accionPaginaBase: `${PREFIJO_MOVER_JUGADOR}-pag`,
    pagina,
    placeholder: 'Elige un jugador',
    encabezado: `${aviso}**Mover** — elige a quién:`,
  });
  await interaction.update({ ...mensaje, embeds: [] });
}

async function mostrarPasoSlotMover(interaction, cta, userId, pagina, aviso = '') {
  const jugador = cta.inscritos.find((i) => i.userId === userId);
  if (!jugador) {
    await volverAlPanelPrincipal(interaction, cta, `${aviso}Ese jugador ya no está inscrito.`);
    return;
  }

  const maestria = await leerMaestria(MAESTRIA_PATH);
  const opciones = buildOpcionesSlot({ cta, inscrito: jugador, maestria, incluirOcupados: true });

  if (opciones.length === 0) {
    await volverAlPanelPrincipal(interaction, cta, `${aviso}No hay ningún destino disponible para ${escapeMarkdown(jugador.nombre)}.`);
    return;
  }

  const mensaje = buildSelectPanelMessage({
    ctaId: cta.id,
    opciones,
    selectCustomId: ctaButtonCustomId(cta.id, `${PREFIJO_MOVER_SLOT}:${userId}`),
    accionPaginaBase: `${PREFIJO_MOVER_SLOT}-pag:${userId}`,
    pagina,
    placeholder: 'Elige el slot destino',
    encabezado: `${aviso}**Mover** a ${escapeMarkdown(jugador.nombre)} — elige el destino:`,
  });
  await interaction.update({ ...mensaje, embeds: [] });
}

async function handlePanelMoverInicio(interaction, ctaId) {
  const cta = await requireCtaParaPaso(interaction, ctaId);
  if (!cta) return;
  await mostrarPasoJugadorMover(interaction, cta, 0);
}

async function handlePanelMoverJugadorPagina(interaction, ctaId, pagina) {
  const cta = await requireCtaParaPaso(interaction, ctaId);
  if (!cta) return;
  await mostrarPasoJugadorMover(interaction, cta, pagina);
}

async function handleSeleccionJugadorMover(interaction, ctaId) {
  const cta = await requireCtaParaPaso(interaction, ctaId);
  if (!cta) return;
  await mostrarPasoSlotMover(interaction, cta, interaction.values[0], 0);
}

async function handlePanelMoverSlotPagina(interaction, ctaId, userId, pagina) {
  const cta = await requireCtaParaPaso(interaction, ctaId);
  if (!cta) return;
  await mostrarPasoSlotMover(interaction, cta, userId, pagina);
}

async function handleSeleccionSlotMover(interaction, ctaId, userId) {
  const cta = await requireCtaParaPaso(interaction, ctaId);
  if (!cta) return;

  const [partyIdx, slotIdx] = interaction.values[0].split(':').map(Number);

  let resultado;
  try {
    resultado = await mover(CTA_PATH, ctaId, { userId, partyIdx, slotIdx });
  } catch (error) {
    if (error instanceof CtaError) {
      const ctaFresca = await ctaPorId(CTA_PATH, ctaId);
      if (!ctaFresca) {
        await interaction.update({ content: 'Esta CTA ya cerró.', embeds: [], components: [] });
        return;
      }
      await mostrarPasoSlotMover(interaction, ctaFresca, userId, 0, `⚠️ ${error.message}\n\n`);
      return;
    }
    throw error;
  }

  programarReedicion(interaction.client, ctaId);
  const ctaFinal = await ctaPorId(CTA_PATH, ctaId);
  const rol = ctaFinal.comp.roles[resultado.rolKey];
  const party = ctaFinal.comp.parties[partyIdx];
  const intercambio = resultado.intercambiadoCon
    ? ` (intercambiado con ${escapeMarkdown(nombreDe(ctaFinal, resultado.intercambiadoCon))})`
    : '';

  // Reasignación: "de dónde a dónde", con el ORIGEN leído de `cta` (el
  // estado justo antes de mover, capturado arriba). Si hubo intercambio, el
  // otro jugador también cambió de sitio y también se le avisa.
  const [origenPartyIdx, origenSlotIdx] = resultado.origenKey.split(':').map(Number);
  const partyAnterior = cta.comp.parties[origenPartyIdx];
  const rolAnteriorKey = partyAnterior.slots[origenSlotIdx];

  notificarReasignacion(interaction.client, ctaFinal, userId, {
    rolKey: resultado.rolKey,
    partyNombre: party.nombre,
    rolAnteriorKey,
    partyAnteriorNombre: partyAnterior.nombre,
  }).catch(() => {});

  if (resultado.intercambiadoCon) {
    notificarReasignacion(interaction.client, ctaFinal, resultado.intercambiadoCon, {
      rolKey: rolAnteriorKey,
      partyNombre: partyAnterior.nombre,
      rolAnteriorKey: resultado.rolKey,
      partyAnteriorNombre: party.nombre,
    }).catch(() => {});
  }

  await volverAlPanelPrincipal(
    interaction,
    ctaFinal,
    `✅ ${escapeMarkdown(nombreDe(ctaFinal, userId))} movido a **${escapeMarkdown(party.nombre)}** (${rol.emoji} ${escapeMarkdown(rol.nombre)})${intercambio}.`,
  );
}

// --- Quitar ---

async function mostrarPasoJugadorQuitar(interaction, cta, pagina, aviso = '') {
  const maestria = await leerMaestria(MAESTRIA_PATH);
  const candidatos = asignadosDe(cta);

  if (candidatos.length === 0) {
    await volverAlPanelPrincipal(interaction, cta, `${aviso}No hay nadie asignado todavía.`);
    return;
  }

  const opciones = buildOpcionesJugador(cta, candidatos, maestria);
  const mensaje = buildSelectPanelMessage({
    ctaId: cta.id,
    opciones,
    selectCustomId: ctaButtonCustomId(cta.id, PREFIJO_QUITAR_JUGADOR),
    accionPaginaBase: `${PREFIJO_QUITAR_JUGADOR}-pag`,
    pagina,
    placeholder: 'Elige un jugador',
    encabezado: `${aviso}**Quitar** — elige a quién liberar:`,
  });
  await interaction.update({ ...mensaje, embeds: [] });
}

async function handlePanelQuitarInicio(interaction, ctaId) {
  const cta = await requireCtaParaPaso(interaction, ctaId);
  if (!cta) return;
  await mostrarPasoJugadorQuitar(interaction, cta, 0);
}

async function handlePanelQuitarJugadorPagina(interaction, ctaId, pagina) {
  const cta = await requireCtaParaPaso(interaction, ctaId);
  if (!cta) return;
  await mostrarPasoJugadorQuitar(interaction, cta, pagina);
}

async function handleSeleccionJugadorQuitar(interaction, ctaId) {
  const cta = await requireCtaParaPaso(interaction, ctaId);
  if (!cta) return;

  const userId = interaction.values[0];
  const entry = Object.entries(cta.asignaciones).find(([, a]) => a.userId === userId);
  if (!entry) {
    await mostrarPasoJugadorQuitar(interaction, cta, 0, '⚠️ Ese jugador ya no estaba asignado.\n\n');
    return;
  }
  const [partyIdx, slotIdx] = entry[0].split(':').map(Number);

  try {
    await desasignar(CTA_PATH, ctaId, { partyIdx, slotIdx });
  } catch (error) {
    if (error instanceof CtaError) {
      const ctaFresca = await ctaPorId(CTA_PATH, ctaId);
      if (!ctaFresca) {
        await interaction.update({ content: 'Esta CTA ya cerró.', embeds: [], components: [] });
        return;
      }
      await mostrarPasoJugadorQuitar(interaction, ctaFresca, 0, `⚠️ ${error.message}\n\n`);
      return;
    }
    throw error;
  }

  programarReedicion(interaction.client, ctaId);
  const ctaFinal = await ctaPorId(CTA_PATH, ctaId);
  await volverAlPanelPrincipal(interaction, ctaFinal, `✅ ${escapeMarkdown(nombreDe(cta, userId))} vuelve a "Sin asignar".`);
}

// --- Bloquear ---

async function mostrarPasoJugadorBloquear(interaction, cta, pagina, aviso = '') {
  const maestria = await leerMaestria(MAESTRIA_PATH);
  const candidatos = asignadosDe(cta);

  if (candidatos.length === 0) {
    await volverAlPanelPrincipal(interaction, cta, `${aviso}No hay nadie asignado todavía.`);
    return;
  }

  const opciones = buildOpcionesBloqueo(cta, candidatos, maestria);
  const mensaje = buildSelectPanelMessage({
    ctaId: cta.id,
    opciones,
    selectCustomId: ctaButtonCustomId(cta.id, PREFIJO_BLOQUEAR_JUGADOR),
    accionPaginaBase: `${PREFIJO_BLOQUEAR_JUGADOR}-pag`,
    pagina,
    placeholder: 'Elige un jugador',
    encabezado: `${aviso}**Bloquear/desbloquear** — elige a quién (🔒 = ya bloqueado):`,
  });
  await interaction.update({ ...mensaje, embeds: [] });
}

async function handlePanelBloquearInicio(interaction, ctaId) {
  const cta = await requireCtaParaPaso(interaction, ctaId);
  if (!cta) return;
  await mostrarPasoJugadorBloquear(interaction, cta, 0);
}

async function handlePanelBloquearJugadorPagina(interaction, ctaId, pagina) {
  const cta = await requireCtaParaPaso(interaction, ctaId);
  if (!cta) return;
  await mostrarPasoJugadorBloquear(interaction, cta, pagina);
}

async function handleSeleccionJugadorBloquear(interaction, ctaId) {
  const cta = await requireCtaParaPaso(interaction, ctaId);
  if (!cta) return;

  const userId = interaction.values[0];
  const entry = Object.entries(cta.asignaciones).find(([, a]) => a.userId === userId);
  if (!entry) {
    await mostrarPasoJugadorBloquear(interaction, cta, 0, '⚠️ Ese jugador ya no está asignado.\n\n');
    return;
  }
  const [key, asignacion] = entry;
  const [partyIdx, slotIdx] = key.split(':').map(Number);
  const nuevoEstado = !asignacion.bloqueado;

  try {
    await bloquear(CTA_PATH, ctaId, { partyIdx, slotIdx, bloqueado: nuevoEstado });
  } catch (error) {
    if (error instanceof CtaError) {
      const ctaFresca = await ctaPorId(CTA_PATH, ctaId);
      if (!ctaFresca) {
        await interaction.update({ content: 'Esta CTA ya cerró.', embeds: [], components: [] });
        return;
      }
      await mostrarPasoJugadorBloquear(interaction, ctaFresca, 0, `⚠️ ${error.message}\n\n`);
      return;
    }
    throw error;
  }

  programarReedicion(interaction.client, ctaId);
  const ctaFinal = await ctaPorId(CTA_PATH, ctaId);
  await volverAlPanelPrincipal(
    interaction,
    ctaFinal,
    `✅ ${escapeMarkdown(nombreDe(cta, userId))} ${nuevoEstado ? 'bloqueado 🔒' : 'desbloqueado'}.`,
  );
}

// --- Autorrellenar / Refrescar ---

async function handlePanelAutorrellenar(interaction, ctaId) {
  const cta = await requireCtaParaPaso(interaction, ctaId);
  if (!cta) return;

  const { asignados, sinCubrir, avisosRotacion } = await autorrellenar(CTA_PATH, ctaId, { maestriaFilePath: MAESTRIA_PATH });
  programarReedicion(interaction.client, ctaId);

  const ctaFinal = await ctaPorId(CTA_PATH, ctaId);

  // Uno por persona, pero sin bloquear la respuesta del panel esperando a
  // que salgan todos (Promise.all interno sin await aquí).
  if (asignados.length > 0) {
    notificarAsignacionesEnLote(
      interaction.client,
      ctaFinal,
      asignados.map((a) => ({ userId: a.userId, rolKey: a.rolKey, partyNombre: ctaFinal.comp.parties[a.partyIdx].nombre })),
    ).catch((error) => {
      console.error(`[cta] Error mandando el lote de DMs de autorrellenar (CTA ${ctaId}):`, error?.stack ?? error);
    });
  }

  // Solo informativo: el bot nunca evita esto por su cuenta, es el caller
  // quien decide si quiere rotar.
  const lineasRotacion = avisosRotacion.map(
    (a) => `🔁 <@${a.userId}> lleva cubriendo **${ctaFinal.comp.roles[a.rolKey]?.nombre ?? a.rolKey}** los últimos 5 eventos. ¿Rotar?`,
  );

  await volverAlPanelPrincipal(
    interaction,
    ctaFinal,
    [`✅ Autorrellenado: ${asignados.length} asignado(s), ${sinCubrir.length} slot(s) sin cubrir.`, ...lineasRotacion].join('\n'),
  );
}

async function handlePanelRefrescar(interaction, ctaId) {
  const cta = await requireCtaParaPaso(interaction, ctaId);
  if (!cta) return;
  await volverAlPanelPrincipal(interaction, cta, null);
}

/**
 * @param {import('discord.js').ButtonInteraction} interaction
 */
export async function handleButton(interaction) {
  const { accion, ctaId } = parseCtaButtonCustomId(interaction.customId);

  switch (accion) {
    case CTA_BOTON_APUNTARSE:
      return handleAbrirPanel(interaction, ctaId, { tentativo: false });
    case CTA_BOTON_TENTATIVO:
      return handleAbrirPanel(interaction, ctaId, { tentativo: true });
    case CTA_BOTON_SALIR:
      return handleSalir(interaction, ctaId);
    case CTA_BOTON_PANEL:
      return handlePanelCaller(interaction, ctaId);
    case CTA_BOTON_CONFIRMAR:
      return handleConfirmar(interaction, ctaId);
    case CTA_BOTON_CANCELAR:
      return handleCancelar(interaction, ctaId);
    case ACCION_PANEL_ASIGNAR:
      return handlePanelAsignarInicio(interaction, ctaId);
    case ACCION_PANEL_MOVER:
      return handlePanelMoverInicio(interaction, ctaId);
    case ACCION_PANEL_QUITAR:
      return handlePanelQuitarInicio(interaction, ctaId);
    case ACCION_PANEL_AUTORRELLENAR:
      return handlePanelAutorrellenar(interaction, ctaId);
    case ACCION_PANEL_BLOQUEAR:
      return handlePanelBloquearInicio(interaction, ctaId);
    case ACCION_PANEL_REFRESCAR:
      return handlePanelRefrescar(interaction, ctaId);
    default:
      break;
  }

  if (accion.startsWith(`${PREFIJO_ASIGNAR_JUGADOR}-pag:`)) {
    return handlePanelAsignarJugadorPagina(interaction, ctaId, Number(accion.slice(`${PREFIJO_ASIGNAR_JUGADOR}-pag:`.length)));
  }
  if (accion.startsWith(`${PREFIJO_MOVER_JUGADOR}-pag:`)) {
    return handlePanelMoverJugadorPagina(interaction, ctaId, Number(accion.slice(`${PREFIJO_MOVER_JUGADOR}-pag:`.length)));
  }
  if (accion.startsWith(`${PREFIJO_QUITAR_JUGADOR}-pag:`)) {
    return handlePanelQuitarJugadorPagina(interaction, ctaId, Number(accion.slice(`${PREFIJO_QUITAR_JUGADOR}-pag:`.length)));
  }
  if (accion.startsWith(`${PREFIJO_BLOQUEAR_JUGADOR}-pag:`)) {
    return handlePanelBloquearJugadorPagina(interaction, ctaId, Number(accion.slice(`${PREFIJO_BLOQUEAR_JUGADOR}-pag:`.length)));
  }
  if (accion.startsWith(`${PREFIJO_ASIGNAR_SLOT}-pag:`)) {
    const resto = accion.slice(`${PREFIJO_ASIGNAR_SLOT}-pag:`.length);
    const idx = resto.lastIndexOf(':');
    return handlePanelAsignarSlotPagina(interaction, ctaId, resto.slice(0, idx), Number(resto.slice(idx + 1)));
  }
  if (accion.startsWith(`${PREFIJO_MOVER_SLOT}-pag:`)) {
    const resto = accion.slice(`${PREFIJO_MOVER_SLOT}-pag:`.length);
    const idx = resto.lastIndexOf(':');
    return handlePanelMoverSlotPagina(interaction, ctaId, resto.slice(0, idx), Number(resto.slice(idx + 1)));
  }

  throw new Error(`Acción de botón de CTA desconocida: ${accion}`);
}

/**
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
export async function handleSelectMenu(interaction) {
  const { accion, ctaId } = parseCtaButtonCustomId(interaction.customId);

  switch (accion) {
    case CTA_SELECT_ROLES:
      return handleSeleccionRoles(interaction, ctaId);
    case CTA_SELECT_PREFERIDO:
      return handleSeleccionPreferido(interaction, ctaId);
    case CTA_SELECT_SLOT:
      return handleSeleccionSlot(interaction, ctaId);
    case PREFIJO_ASIGNAR_JUGADOR:
      return handleSeleccionJugadorAsignar(interaction, ctaId);
    case PREFIJO_MOVER_JUGADOR:
      return handleSeleccionJugadorMover(interaction, ctaId);
    case PREFIJO_QUITAR_JUGADOR:
      return handleSeleccionJugadorQuitar(interaction, ctaId);
    case PREFIJO_BLOQUEAR_JUGADOR:
      return handleSeleccionJugadorBloquear(interaction, ctaId);
    default:
      break;
  }

  if (accion.startsWith(`${PREFIJO_ASIGNAR_SLOT}:`)) {
    return handleSeleccionSlotAsignar(interaction, ctaId, accion.slice(`${PREFIJO_ASIGNAR_SLOT}:`.length));
  }
  if (accion.startsWith(`${PREFIJO_MOVER_SLOT}:`)) {
    return handleSeleccionSlotMover(interaction, ctaId, accion.slice(`${PREFIJO_MOVER_SLOT}:`.length));
  }

  throw new Error(`Acción de select de CTA desconocida: ${accion}`);
}
