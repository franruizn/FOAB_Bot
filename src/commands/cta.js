import { SlashCommandBuilder } from 'discord.js';
import { isCtaOfficer } from '../permissions.js';
import { errorEmbed } from '../ui/errorEmbed.js';
import { buildCtaEmbed, buildCtaButtons, buildCtaModal, buildCtaSheetUrl, buildCtaRolesListEmbed } from '../ui/ctaEmbed.js';
import { CTA_PATH, CTA_SHEET_CONFIG_PATH } from '../dataPaths.js';
import { crearCta, apuntar, desapuntar, ctaActiva, CtaError } from '../services/ctaStore.js';
import { scheduleCtaClose, cerrarCtaManualmente } from '../ctaScheduler.js';
import { scheduleEmbedRefresh, flushPendingEmbedRefreshes } from '../ctaEmbedSync.js';
import { scheduleSheetSync, syncSheetNow } from '../ctaSheetSync.js';
import { crearRolCta, borrarRolCta, reconciliarRolCta, CtaRoleError, CTA_ROLE_NAME_PATTERN } from '../services/ctaRole.js';
import { setSheetIdOverride, setSheetTabOverride, setRangoInicioOverride } from '../services/ctaSheetConfig.js';
import { parseCellRef } from '../services/sheets.js';
import { notifyCtaRoleFailure, notifyCtaRoleCapacityWarning, notifyCtaSheetConfigChange } from '../logChannel.js';

const MIN_MINUTES = 1;
const MAX_MINUTES = 1440;
const MIN_NOMBRE_LENGTH = 1;
const MAX_NOMBRE_LENGTH = 60;
const ROLE_FIELD_IDS = ['rol1', 'rol2', 'rol3'];
const ROLE_LABELS = ['Rol 1', 'Rol 2', 'Rol 3'];
const BUTTON_PREFIX = 'cta-';
const APUNTAR_PREFIX = 'cta-apuntar-';
const DESAPUNTAR_PREFIX = 'cta-desapuntar-';
const MODAL_PREFIX = 'cta-modal-';
// Nota que se añade a toda confirmación de alta/baja: la escritura en la
// hoja está agrupada 2s (y puede reintentar más si Google falla), así que
// nunca es inmediata — pero la interacción de Discord SIEMPRE se confirma
// igual, haya ido bien la hoja o no.
const SHEET_SYNC_NOTE = ' La hoja se actualizará en breve.';

// Visible para todos en el picker de Discord a propósito: el filtro real es
// isCtaOfficer() (CTA_OFFICER_ROLE_ID) en runtime, no un permiso de Discord
// que haya que reconfigurar a mano.
export const data = new SlashCommandBuilder()
  .setName('cta')
  .setDescription('CTA del gremio: apuntarse con roles (solo oficiales)')
  .addSubcommand((sub) =>
    sub
      .setName('abrir')
      .setDescription('Abre una CTA para que el gremio se apunte con roles')
      .addStringOption((option) =>
        option
          .setName('nombre')
          .setDescription(`Nombre de la actividad (${MIN_NOMBRE_LENGTH}-${MAX_NOMBRE_LENGTH} caracteres)`)
          .setRequired(true)
          .setMinLength(MIN_NOMBRE_LENGTH)
          .setMaxLength(MAX_NOMBRE_LENGTH),
      )
      .addIntegerOption((option) =>
        option
          .setName('minutos')
          .setDescription(`Duración en minutos (${MIN_MINUTES}-${MAX_MINUTES})`)
          .setRequired(true)
          .setMinValue(MIN_MINUTES)
          .setMaxValue(MAX_MINUTES),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('sync')
      .setDescription('Reintenta ya la escritura de la hoja y cuadra la membresía del rol contra los inscritos'),
  )
  .addSubcommand((sub) =>
    sub.setName('roles').setDescription('Lista los roles de CTA existentes, del más antiguo al más reciente'),
  )
  .addSubcommand((sub) => sub.setName('cerrar').setDescription('Cierra la CTA activa antes de tiempo'))
  .addSubcommand((sub) =>
    sub
      .setName('hoja')
      .setDescription('Cambia en caliente qué hoja de Google Sheets usa /cta (sin tocar .env ni reiniciar)')
      .addStringOption((option) =>
        option
          .setName('id')
          .setDescription('ID de la hoja, o pega la URL completa')
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(300),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('pestana')
      .setDescription('Cambia en caliente qué pestaña usa /cta dentro de la hoja (sin tocar .env ni reiniciar)')
      .addStringOption((option) =>
        option.setName('nombre').setDescription('Nombre exacto de la pestaña').setRequired(true).setMinLength(1).setMaxLength(100),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('rango')
      .setDescription('Cambia en caliente la celda donde empieza el bloque de /cta, ej. P3 (sin tocar .env ni reiniciar)')
      .addStringOption((option) =>
        option.setName('celda').setDescription('Celda de inicio, ej. P3').setRequired(true).setMinLength(2).setMaxLength(10),
      ),
  );

/**
 * "Tank" y "tank " (o "Tánk") deben compararse como el mismo rol: sin
 * distinguir mayúsculas ni acentos, y colapsando espacios repetidos.
 * @param {string} value
 * @returns {string}
 */
function normalizeRole(value) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * interaction.member normalmente ya es un GuildMember completo (discord.js
 * lo resuelve así para interacciones de gateway), pero no hay que asumirlo:
 * si viniera parcial (sin .roles.add utilizable), se resuelve con
 * guild.members.fetch() en vez de confiar en la caché.
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<import('discord.js').GuildMember>}
 */
async function resolveMember(interaction) {
  if (interaction.member && typeof interaction.member.roles?.add === 'function') {
    return interaction.member;
  }
  return interaction.guild.members.fetch(interaction.user.id);
}

/**
 * Deshace una creación de /cta abrir que se quedó a medias. Se usa en TODOS
 * los puntos donde puede fallar después de crear el rol, para que no haya
 * versiones de este rollback que se separen con el tiempo. `message` es
 * opcional: si todavía no se había publicado, no hay nada que borrar ahí.
 * @param {import('discord.js').Guild} guild
 * @param {{ roleId: string, message?: import('discord.js').Message }} params
 */
async function rollbackCtaAbrir(guild, { roleId, message }) {
  if (message) await message.delete().catch(() => {});
  await borrarRolCta(guild, roleId);
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  if (!isCtaOfficer(interaction)) {
    await interaction.reply({
      embeds: [errorEmbed('Sin permiso', 'Este comando es solo para el rol de oficiales.')],
      ephemeral: true,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'sync') {
    await handleSync(interaction);
    return;
  }
  if (subcommand === 'roles') {
    await handleRoles(interaction);
    return;
  }
  if (subcommand === 'cerrar') {
    await handleCerrar(interaction);
    return;
  }
  if (subcommand === 'hoja') {
    await handleHoja(interaction);
    return;
  }
  if (subcommand === 'pestana') {
    await handlePestana(interaction);
    return;
  }
  if (subcommand === 'rango') {
    await handleRango(interaction);
    return;
  }
  await handleAbrir(interaction);
}

async function handleAbrir(interaction) {
  const nombre = interaction.options.getString('nombre', true).trim();
  // Defensa en profundidad, igual que /sorteo: setMinLength/setMaxLength ya
  // lo bloquean en el cliente, pero cubre un comando registrado
  // desactualizado (y un valor que quede en solo espacios tras el trim).
  if (nombre.length < MIN_NOMBRE_LENGTH || nombre.length > MAX_NOMBRE_LENGTH) {
    await interaction.reply({
      embeds: [errorEmbed('Nombre inválido', `El nombre debe tener entre ${MIN_NOMBRE_LENGTH} y ${MAX_NOMBRE_LENGTH} caracteres.`)],
      ephemeral: true,
    });
    return;
  }

  const minutes = interaction.options.getInteger('minutos', true);
  if (!Number.isInteger(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
    await interaction.reply({
      embeds: [errorEmbed('Duración inválida', `Los minutos deben ser un entero entre ${MIN_MINUTES} y ${MAX_MINUTES}.`)],
      ephemeral: true,
    });
    return;
  }

  const yaActiva = await ctaActiva(CTA_PATH);
  if (yaActiva) {
    const cierraEnSeconds = Math.floor(new Date(yaActiva.cierraEn).getTime() / 1000);
    await interaction.reply({
      embeds: [
        errorEmbed(
          'Ya hay una CTA activa',
          `Está en <#${yaActiva.channelId}>, cierra <t:${cierraEnSeconds}:R>. Solo puede haber una CTA a la vez.`,
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  // Respondemos ephemeral y publicamos aparte con channel.send(): el token
  // de la respuesta a esta interacción caduca a los 15 minutos, y este
  // mensaje tiene que seguir editable horas después.
  await interaction.reply({ content: 'CTA creada.', ephemeral: true });

  // Un único instante para todo lo que se deriva de "ahora": el id, el
  // sufijo de fecha del rol, y el cierre.
  const createdAt = new Date();
  const ctaId = `cta_${createdAt.getTime()}`;
  const cierraEnDate = new Date(createdAt.getTime() + minutes * 60_000);
  const cierraEnUnixSeconds = Math.floor(cierraEnDate.getTime() / 1000);
  const sheetUrl = buildCtaSheetUrl();

  // El rol se crea ANTES de publicar nada: las 3 comprobaciones previas
  // (permiso, jerarquía, cupo de 250) corren dentro de crearRolCta(), y si
  // cualquiera falla no queda ni mensaje ni CTA a medias que deshacer.
  let roleId;
  let roleNombre;
  let roleWarning;
  try {
    ({ roleId, roleNombre, warning: roleWarning } = await crearRolCta(interaction.guild, nombre, ctaId, createdAt));
  } catch (error) {
    if (error instanceof CtaRoleError) {
      await interaction.followUp({ embeds: [errorEmbed('No se pudo crear la CTA', error.message)], ephemeral: true });
      return;
    }
    throw error;
  }

  if (roleWarning) {
    await interaction.followUp({ content: `⚠️ ${roleWarning}`, ephemeral: true });
    await notifyCtaRoleCapacityWarning(interaction.client, { ctaId, message: roleWarning }).catch(() => {});
  }

  const embed = buildCtaEmbed({ title: nombre, cierraEnUnixSeconds, inscritosCount: 0, sheetUrl });
  const row = buildCtaButtons(ctaId, { disabled: false });

  let message;
  try {
    message = await interaction.channel.send({ embeds: [embed], components: [row] });
  } catch (error) {
    // El rol ya existe pero el mensaje no se llegó a publicar: nada de CTA
    // a medias, se deshace el rol y se corta aquí.
    await rollbackCtaAbrir(interaction.guild, { roleId });
    throw error;
  }

  let activa;
  try {
    activa = await crearCta(CTA_PATH, {
      id: ctaId,
      nombre,
      roleId,
      roleNombre,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      messageId: message.id,
      creadorId: interaction.user.id,
      cierraEn: cierraEnDate.toISOString(),
    });
  } catch (error) {
    // Carrera improbable: otra CTA se creó justo entre nuestro chequeo y
    // ahora. El mensaje y el rol ya existen; se deshacen los dos para no
    // dejar restos de una CTA que no llegó a quedar activa.
    await rollbackCtaAbrir(interaction.guild, { roleId, message });
    if (error instanceof CtaError) {
      await interaction.followUp({ embeds: [errorEmbed('No se pudo crear la CTA', error.message)], ephemeral: true });
      return;
    }
    throw error;
  }

  scheduleCtaClose(interaction.client, activa);
  // Limpia cualquier resto de una CTA anterior en el bloque de la hoja
  // (inscritos=[] en este punto): agrupado igual que cualquier otra
  // alta/baja, no hace falta que sea inmediato.
  scheduleSheetSync(interaction.client, activa.id);
}

/**
 * /cta sync: reintenta YA (sin esperar los 2s del agrupador) la escritura
 * del bloque completo en la hoja, y ADEMÁS cuadra la membresía del rol
 * contra los inscritos. Los dos se intentan de forma independiente: que
 * falle uno no debe impedir el otro.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function handleSync(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const activa = await ctaActiva(CTA_PATH);
  if (!activa) {
    await interaction.editReply({ content: 'No hay ninguna CTA activa.' });
    return;
  }

  let sheetError = null;
  try {
    await syncSheetNow(interaction.client, activa.id);
  } catch (error) {
    sheetError = error;
  }

  let roleResult = null;
  let roleError = null;
  try {
    roleResult = await reconciliarRolCta(interaction.guild, activa);
  } catch (error) {
    roleError = error;
  }

  // Un "reintenta ya" no debe dejar el aviso de "desincronizada" (footer)
  // colgado un rato más después de confirmarlo al oficial.
  await flushPendingEmbedRefreshes().catch(() => {});

  const sheetLine = sheetError
    ? `❌ Hoja: no se pudo sincronizar (${sheetError instanceof Error ? sheetError.message : String(sheetError)}).`
    : `✔️ Hoja: ${activa.inscritos.length} inscrito(s) escritos en el bloque.`;

  let roleLine;
  if (roleError) {
    roleLine = `❌ Rol: no se pudo reconciliar (${roleError instanceof Error ? roleError.message : String(roleError)}).`;
  } else {
    const detalle = roleResult.omitidos > 0 ? ` (${roleResult.omitidos} omitido(s), p.ej. gente que se fue del servidor)` : '';
    roleLine = `✔️ Rol: +${roleResult.altas} / -${roleResult.bajas}${detalle}.`;
  }

  await interaction.editReply({ content: `${sheetLine}\n${roleLine}` });
}

/**
 * /cta roles: lista de solo lectura de los roles de CTA del servidor
 * (reconocidos por el patrón "_ddMM-HHmm" en el nombre), del más antiguo al
 * más reciente, con fecha de creación y número de miembros. No borra nada.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function handleRoles(interaction) {
  await interaction.deferReply({ ephemeral: true });

  // Para que memberCount sea fiable (ver ctaRole.js/reconciliarRolCta).
  await interaction.guild.members.fetch();

  const roles = [...interaction.guild.roles.cache.values()]
    .filter((role) => CTA_ROLE_NAME_PATTERN.test(role.name))
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map((role) => ({ name: role.name, createdTimestamp: role.createdTimestamp, memberCount: role.members.size }));

  await interaction.editReply({ embeds: [buildCtaRolesListEmbed({ roles })] });
}

/**
 * /cta cerrar: corta la CTA activa antes de tiempo. Mismo camino que el
 * cierre automático (fuerza la hoja pendiente, deshabilita botones, publica
 * la lista final) — la única diferencia es que lo dispara un oficial, no el
 * temporizador. No toca la hoja aparte de esa sincronización final: lo
 * apuntado se queda.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function handleCerrar(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const cerrada = await cerrarCtaManualmente(interaction.client);
  if (!cerrada) {
    await interaction.editReply({ content: 'No hay ninguna CTA activa.' });
    return;
  }

  await interaction.editReply({
    content: `CTA "${cerrada.nombre}" cerrada antes de tiempo. ${cerrada.inscritos.length} inscrito(s). La hoja no se ha tocado.`,
  });
}

/**
 * Si pegan la URL completa de la hoja, se queda solo con el ID (el trozo
 * entre "/d/" y la siguiente "/") — no todo el mundo sabe que hay que
 * recortarla a mano.
 * @param {string} raw
 * @returns {string}
 */
function extractSheetId(raw) {
  const trimmed = raw.trim();
  const match = /\/d\/([a-zA-Z0-9_-]+)/.exec(trimmed);
  return match ? match[1] : trimmed;
}

/**
 * /cta hoja: cambia en caliente el ID de la hoja que usa /cta (persistido en
 * DATA_DIR, sobrevive a un reinicio) — sin tocar CTA_SHEET_ID en .env ni
 * reiniciar el bot. Afecta a la siguiente escritura, no a las ya agrupadas.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function handleHoja(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const sheetId = extractSheetId(interaction.options.getString('id', true));
  if (!sheetId) {
    await interaction.editReply({ content: 'El ID de la hoja no puede estar vacío.' });
    return;
  }

  await setSheetIdOverride(CTA_SHEET_CONFIG_PATH, sheetId);
  await notifyCtaSheetConfigChange(interaction.client, { actorTag: interaction.user.tag, campo: 'hoja', valor: sheetId }).catch(() => {});

  await interaction.editReply({
    content: `Hoja cambiada a \`${sheetId}\`. Recuerda compartirla con la cuenta de servicio si es nueva, y corre \`/cta sync\` (con una CTA activa) para comprobar que funciona.`,
  });
}

/**
 * /cta pestana: igual que /cta hoja, pero para CTA_SHEET_TAB.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function handlePestana(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const nombre = interaction.options.getString('nombre', true).trim();
  if (!nombre) {
    await interaction.editReply({ content: 'El nombre de la pestaña no puede estar vacío.' });
    return;
  }

  await setSheetTabOverride(CTA_SHEET_CONFIG_PATH, nombre);
  await notifyCtaSheetConfigChange(interaction.client, { actorTag: interaction.user.tag, campo: 'pestaña', valor: nombre }).catch(() => {});

  await interaction.editReply({
    content: `Pestaña cambiada a \`${nombre}\`. Corre \`/cta sync\` (con una CTA activa) para comprobar que funciona.`,
  });
}

/**
 * /cta rango: igual que /cta hoja, pero para CTA_RANGO_INICIO. Valida el
 * formato de la celda ANTES de guardar nada (misma validación que usa
 * sheets.js en cada escritura) — así un error tipográfico se ve al momento,
 * en vez de en la siguiente escritura real.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function handleRango(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const celda = interaction.options.getString('celda', true).trim();
  try {
    parseCellRef(celda);
  } catch (error) {
    await interaction.editReply({ content: error.message });
    return;
  }

  await setRangoInicioOverride(CTA_SHEET_CONFIG_PATH, celda);
  await notifyCtaSheetConfigChange(interaction.client, {
    actorTag: interaction.user.tag,
    campo: 'rango de inicio',
    valor: celda,
  }).catch(() => {});

  await interaction.editReply({
    content: `Rango de inicio cambiado a \`${celda}\`. Corre \`/cta sync\` (con una CTA activa) para comprobar que funciona.`,
  });
}

/**
 * Enruta cualquier interacción de botón cuyo customId empiece por "cta-".
 * @param {import('discord.js').ButtonInteraction} interaction
 */
export async function handleButton(interaction) {
  if (interaction.customId.startsWith(APUNTAR_PREFIX)) {
    await handleApuntarButton(interaction, interaction.customId.slice(APUNTAR_PREFIX.length));
    return;
  }
  if (interaction.customId.startsWith(DESAPUNTAR_PREFIX)) {
    await handleDesapuntarButton(interaction, interaction.customId.slice(DESAPUNTAR_PREFIX.length));
    return;
  }
  console.error(`[cta] customId de botón desconocido: ${interaction.customId}`);
}

/**
 * showModal() DEBE ser la primera respuesta a la interacción: no se puede
 * deferir primero y mostrar el modal después (Discord lo rechaza), así que
 * aquí no se hace NINGUNA comprobación previa — ni siquiera "¿ya está
 * apuntado?". Esa comprobación (y el aviso ephemeral si corresponde) se hace
 * DESPUÉS, como followUp, que no tiene la misma urgencia de los 3s.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} ctaId
 */
async function handleApuntarButton(interaction, ctaId) {
  await interaction.showModal(buildCtaModal(ctaId));

  try {
    const activa = await ctaActiva(CTA_PATH);
    if (!activa || activa.id !== ctaId) return; // cerrada/distinta: se resuelve al enviar el modal

    const inscrito = activa.inscritos.find((i) => i.userId === interaction.user.id);
    if (inscrito) {
      await interaction.followUp({
        content:
          `Ya estabas apuntado con: ${inscrito.roles.join(', ')}. ` +
          'Si envías el formulario, se reemplazan (no pierdes tu puesto en la lista).',
        ephemeral: true,
      });
    }
  } catch (error) {
    // El modal ya se mostró (esa era la respuesta obligatoria a la
    // interacción): un fallo en este aviso extra no debe tratarse como un
    // error de comando ni intentar otra respuesta sobre la misma interacción.
    console.error(`[cta] Error comprobando inscripción previa (botón Apuntarse, CTA ${ctaId}):`, error?.stack ?? error);
  }
}

/**
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} ctaId
 */
async function handleDesapuntarButton(interaction, ctaId) {
  await interaction.deferReply({ ephemeral: true });

  const activa = await ctaActiva(CTA_PATH);
  if (!activa || activa.id !== ctaId) {
    await interaction.editReply({ content: 'Esta CTA ya no está activa.' });
    return;
  }

  let actualizada;
  try {
    actualizada = await desapuntar(CTA_PATH, interaction.user.id);
  } catch (error) {
    if (error instanceof CtaError) {
      await interaction.editReply({ content: error.message });
      return;
    }
    throw error;
  }

  // desapuntar() ya guardó en cta.json (fuente de verdad): la confirmación
  // no depende de si el rol de Discord llega a quitarse.
  let roleNote = '';
  if (actualizada.roleId) {
    try {
      const member = await resolveMember(interaction);
      if (member.roles.cache.has(actualizada.roleId)) {
        await member.roles.remove(actualizada.roleId, `CTA ${actualizada.id}`);
      }
    } catch (error) {
      console.error(`[cta] No se pudo quitar el rol a ${interaction.user.id} (CTA ${actualizada.id}):`, error?.stack ?? error);
      await notifyCtaRoleFailure(interaction.client, {
        ctaId: actualizada.id,
        userId: interaction.user.id,
        action: 'quitar',
        error,
      }).catch(() => {});
      roleNote = ' El rol se quitará en breve.';
    }
  }

  await interaction.editReply({ content: `Te has desapuntado de la CTA.${SHEET_SYNC_NOTE}${roleNote}` });
  scheduleEmbedRefresh(interaction.client, actualizada.id);
  scheduleSheetSync(interaction.client, actualizada.id);
}

/**
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 */
export async function handleModalSubmit(interaction) {
  if (!interaction.customId.startsWith(MODAL_PREFIX)) return;
  const ctaId = interaction.customId.slice(MODAL_PREFIX.length);

  await interaction.deferReply({ ephemeral: true });

  const trimmed = ROLE_FIELD_IDS.map((fieldId) => interaction.fields.getTextInputValue(fieldId).trim());

  const emptyIndex = trimmed.findIndex((value) => value.length === 0);
  if (emptyIndex !== -1) {
    await interaction.editReply({
      content: `"${ROLE_LABELS[emptyIndex]}" no puede estar vacío. Vuelve a pulsar "Apuntarse" para intentarlo de nuevo.`,
    });
    return;
  }

  const normalized = trimmed.map(normalizeRole);
  const dupIndex = normalized.findIndex((value, index) => normalized.indexOf(value) !== index);
  if (dupIndex !== -1) {
    await interaction.editReply({
      content:
        `Los tres roles deben ser distintos. "${trimmed[dupIndex]}" está repetido. ` +
        'Vuelve a pulsar "Apuntarse" para intentarlo de nuevo (lo que escribiste no se guardó).',
    });
    return;
  }

  // Caso real: el formulario puede quedar abierto minutos y la CTA cerrar
  // (o incluso cambiar) mientras tanto.
  const activa = await ctaActiva(CTA_PATH);
  if (!activa || activa.id !== ctaId) {
    await interaction.editReply({ content: 'La CTA ya cerró mientras tenías el formulario abierto. Tu inscripción no se guardó.' });
    return;
  }

  const nombre = interaction.member?.displayName || interaction.user.username;

  let actualizada;
  try {
    actualizada = await apuntar(CTA_PATH, interaction.user.id, nombre, trimmed);
  } catch (error) {
    if (error instanceof CtaError) {
      await interaction.editReply({ content: error.message });
      return;
    }
    throw error;
  }

  // apuntar() ya guardó en cta.json (fuente de verdad) antes de llegar
  // aquí: el usuario recibe su confirmación aunque el rol tarde o falle.
  let roleNote = '';
  if (actualizada.roleId) {
    try {
      const member = await resolveMember(interaction);
      // Reinscripción: si ya lo tiene, no hace falta la llamada.
      if (!member.roles.cache.has(actualizada.roleId)) {
        await member.roles.add(actualizada.roleId, `CTA ${actualizada.id}`);
      }
    } catch (error) {
      console.error(`[cta] No se pudo asignar el rol a ${interaction.user.id} (CTA ${actualizada.id}):`, error?.stack ?? error);
      await notifyCtaRoleFailure(interaction.client, {
        ctaId: actualizada.id,
        userId: interaction.user.id,
        action: 'asignar',
        error,
      }).catch(() => {});
      roleNote = ' El rol se asignará en breve.';
    }
  }

  await interaction.editReply({ content: `Apuntado con: ${trimmed.join(', ')}.${SHEET_SYNC_NOTE}${roleNote}` });
  scheduleEmbedRefresh(interaction.client, actualizada.id);
  scheduleSheetSync(interaction.client, actualizada.id);
}

export function isCtaComponent(customId) {
  return typeof customId === 'string' && customId.startsWith(BUTTON_PREFIX);
}
