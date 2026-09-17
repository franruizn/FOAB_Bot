import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, escapeMarkdown } from 'discord.js';
import {
  crearComp,
  borrarComp,
  listarComps,
  getComp,
  agregarOActualizarCategoria,
  borrarCategoria,
  crearRoles,
  borrarRoles,
  moverRoles,
  agregarParty,
  borrarParty,
  duplicarParty,
  agregarSlot,
  borrarSlot,
  parsearLista,
  CtaCompError,
} from '../services/ctaComp.js';
import { resolverEmoji, EmojiNoEncontradoError } from '../services/emojiResolver.js';
import { ctasActivas } from '../services/ctaStore.js';
import {
  mutationEmbed,
  buildCompNotFoundEmbed,
  buildRolesCreadosEmbed,
  buildCompVerEmbed,
  buildCompListaEmbed,
} from '../ui/compEmbed.js';
import { errorEmbed } from '../ui/errorEmbed.js';
import { isOfficer } from '../permissions.js';
import { CTA_COMPS_PATH, CTA_PATH } from '../dataPaths.js';

const AUTOCOMPLETE_LIMIT = 25;
const CONFIRM_TIMEOUT_MS = 30_000;
const SUGGESTION_COUNT = 3;

/**
 * Distancia de Levenshtein clásica (DP de dos filas), sin dependencias.
 * Copia local: no hay un módulo compartido para esto (ver attendance.js,
 * que tiene la suya propia con el mismo código).
 */
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

// Visible para todos en el picker de Discord a propósito (igual que
// /squads): el filtro real es isOfficer() en runtime.
export const data = new SlashCommandBuilder()
  .setName('comp')
  .setDescription('Gestiona las plantillas de composición para CTAs (solo oficiales)')
  .addSubcommand((sub) =>
    sub
      .setName('crear')
      .setDescription('Paso 1: crea una composición vacía')
      .addStringOption((o) => o.setName('nombre').setDescription('Nombre visible, ej. "ZvZ Standard"').setRequired(true)),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('categoria')
      .setDescription('Paso 2: categorías (agrupan roles y les dan un emoji/color)')
      .addSubcommand((sub) =>
        sub
          .setName('crear')
          .setDescription('Crea una categoría, o actualiza su emoji si ya existe')
          .addStringOption((o) => o.setName('comp').setDescription('Composición').setRequired(true).setAutocomplete(true))
          .addStringOption((o) => o.setName('nombre').setDescription('Nombre, ej. "Caller"').setRequired(true))
          .addStringOption((o) => o.setName('emoji').setDescription(':codigo: del servidor, o pégalo directamente').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('borrar')
          .setDescription('Borra una categoría (falla si tiene roles dentro)')
          .addStringOption((o) => o.setName('comp').setDescription('Composición').setRequired(true).setAutocomplete(true))
          .addStringOption((o) => o.setName('categoria').setDescription('Categoría').setRequired(true).setAutocomplete(true)),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('rol')
      .setDescription('Paso 3: roles (el arma por la que se apunta la gente)')
      .addSubcommand((sub) =>
        sub
          .setName('crear')
          .setDescription('Crea varios roles de una vez, emparejados por posición')
          .addStringOption((o) => o.setName('comp').setDescription('Composición').setRequired(true).setAutocomplete(true))
          .addStringOption((o) => o.setName('categoria').setDescription('Categoría de todos estos roles').setRequired(true).setAutocomplete(true))
          .addStringOption((o) => o.setName('roles').setDescription('Nombres separados por comas: "Maza Pesada, HOJ"').setRequired(true))
          .addStringOption((o) => o.setName('emojis').setDescription('Emojis en el MISMO orden: ":maza:, :hoj:"').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('borrar')
          .setDescription('Borra uno o varios roles (falla si algún se usa en un slot)')
          .addStringOption((o) => o.setName('comp').setDescription('Composición').setRequired(true).setAutocomplete(true))
          .addStringOption((o) => o.setName('roles').setDescription('Roles separados por comas').setRequired(true).setAutocomplete(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('mover')
          .setDescription('Cambia de categoría uno o varios roles')
          .addStringOption((o) => o.setName('comp').setDescription('Composición').setRequired(true).setAutocomplete(true))
          .addStringOption((o) => o.setName('roles').setDescription('Roles separados por comas').setRequired(true).setAutocomplete(true))
          .addStringOption((o) => o.setName('categoria').setDescription('Categoría destino').setRequired(true).setAutocomplete(true)),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('party')
      .setDescription('Grupos de slots dentro de una composición')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Añade una party vacía')
          .addStringOption((o) => o.setName('comp').setDescription('Composición').setRequired(true).setAutocomplete(true))
          .addStringOption((o) => o.setName('nombre').setDescription('Nombre, ej. "Party 1"').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('borrar')
          .setDescription('Borra una party')
          .addStringOption((o) => o.setName('comp').setDescription('Composición').setRequired(true).setAutocomplete(true))
          .addIntegerOption((o) => o.setName('party').setDescription('Party').setRequired(true).setMinValue(1).setAutocomplete(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('duplicar')
          .setDescription('Duplica una party copiando sus slots')
          .addStringOption((o) => o.setName('comp').setDescription('Composición').setRequired(true).setAutocomplete(true))
          .addIntegerOption((o) => o.setName('party').setDescription('Party').setRequired(true).setMinValue(1).setAutocomplete(true)),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('slot')
      .setDescription('Slots dentro de una party')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Añade slot(s) de un rol a una party')
          .addStringOption((o) => o.setName('comp').setDescription('Composición').setRequired(true).setAutocomplete(true))
          .addIntegerOption((o) => o.setName('party').setDescription('Party').setRequired(true).setMinValue(1).setAutocomplete(true))
          .addStringOption((o) => o.setName('rol').setDescription('Rol').setRequired(true).setAutocomplete(true))
          .addIntegerOption((o) => o.setName('cantidad').setDescription('Cuántos slots (por defecto 1)').setMinValue(1).setMaxValue(25)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('borrar')
          .setDescription('Borra un slot de una party')
          .addStringOption((o) => o.setName('comp').setDescription('Composición').setRequired(true).setAutocomplete(true))
          .addIntegerOption((o) => o.setName('party').setDescription('Party').setRequired(true).setMinValue(1).setAutocomplete(true))
          .addIntegerOption((o) => o.setName('slot').setDescription('Slot').setRequired(true).setMinValue(1).setAutocomplete(true)),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('ver')
      .setDescription('Previsualiza una composición tal como se verá en la CTA')
      .addStringOption((o) => o.setName('comp').setDescription('Composición').setRequired(true).setAutocomplete(true)),
  )
  .addSubcommand((sub) => sub.setName('lista').setDescription('Lista todas las composiciones'))
  .addSubcommand((sub) =>
    sub
      .setName('borrar')
      .setDescription('Borra una composición (pide confirmación)')
      .addStringOption((o) => o.setName('comp').setDescription('Composición').setRequired(true).setAutocomplete(true)),
  );

// --- resolución tolerante: el select de Discord ya manda la clave interna,
// pero si el oficial escribe a mano el nombre visible en vez de elegir la
// sugerencia, esto lo resuelve igual en vez de fallar con "no existe". ---

async function resolveCompOrRespond(interaction) {
  const compInput = interaction.options.getString('comp', true);
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

function resolverCategoriaKey(comp, texto) {
  const raw = String(texto ?? '').trim().toLowerCase();
  if (comp.categorias[raw]) return raw;
  const porNombre = Object.entries(comp.categorias).find(([, cat]) => cat.nombre.toLowerCase() === raw);
  return porNombre ? porNombre[0] : raw;
}

function resolverRolKey(comp, texto) {
  const raw = String(texto ?? '').trim().toLowerCase();
  if (comp.roles[raw]) return raw;
  const porNombre = Object.entries(comp.roles).find(([, rol]) => rol.nombre.toLowerCase() === raw);
  return porNombre ? porNombre[0] : raw;
}

// --- handlers: comp ---

async function handleCrear(interaction) {
  const nombre = interaction.options.getString('nombre', true);
  const { key, comp } = await crearComp(CTA_COMPS_PATH, { nombre, creadoPor: interaction.user.id });

  await interaction.editReply({
    embeds: [
      mutationEmbed({
        title: 'Composición creada',
        description: `**${escapeMarkdown(comp.nombre)}** (\`${key}\`)\n\nAhora añade categorías con \`/comp categoria crear\`.`,
        actorTag: interaction.user.tag,
      }),
    ],
  });
}

async function handleVer(interaction) {
  const resolved = await resolveCompOrRespond(interaction);
  if (!resolved) return;

  await interaction.editReply({
    embeds: [buildCompVerEmbed({ compKey: resolved.key, comp: resolved.comp, guild: interaction.guild })],
  });
}

async function handleLista(interaction) {
  const comps = await listarComps(CTA_COMPS_PATH);
  await interaction.editReply({ embeds: [buildCompListaEmbed(comps)] });
}

async function handleBorrar(interaction) {
  const resolved = await resolveCompOrRespond(interaction);
  if (!resolved) return;

  const activas = (await ctasActivas(CTA_PATH)).filter((cta) => cta.compId === resolved.key);
  if (activas.length > 0) {
    const canales = activas.map((cta) => `<#${cta.channelId}>`).join(', ');
    await interaction.editReply({
      embeds: [
        errorEmbed(
          'No se puede borrar',
          `**${escapeMarkdown(resolved.comp.nombre)}** la está usando una CTA activa en: ${canales}. Ciérrala primero.`,
        ),
      ],
    });
    return;
  }

  const confirmId = `comp-borrar-confirm-${interaction.id}`;
  const cancelId = `comp-borrar-cancel-${interaction.id}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(confirmId).setLabel('Confirmar borrado').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(cancelId).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
  );

  const message = await interaction.editReply({
    content: `¿Seguro que quieres borrar la composición **${escapeMarkdown(resolved.comp.nombre)}**? Esta acción no se puede deshacer.`,
    embeds: [],
    components: [row],
  });

  let buttonInteraction;
  try {
    buttonInteraction = await message.awaitMessageComponent({
      filter: (i) => i.user.id === interaction.user.id,
      time: CONFIRM_TIMEOUT_MS,
    });
  } catch {
    await interaction.editReply({ content: 'Confirmación expirada. La composición no se borró.', components: [] });
    return;
  }

  if (buttonInteraction.customId === cancelId) {
    await buttonInteraction.update({ content: 'Borrado cancelado.', components: [] });
    return;
  }

  const { comp } = await borrarComp(CTA_COMPS_PATH, resolved.key);
  await buttonInteraction.update({
    content: null,
    embeds: [mutationEmbed({ title: 'Composición borrada', description: `**${escapeMarkdown(comp.nombre)}**.`, actorTag: interaction.user.tag })],
    components: [],
  });
}

// --- handlers: categoria ---

async function handleCategoriaCrear(interaction) {
  const resolved = await resolveCompOrRespond(interaction);
  if (!resolved) return;

  const nombre = interaction.options.getString('nombre', true);
  const emojiCrudo = interaction.options.getString('emoji', true);
  const resolver = (crudo) => resolverEmoji(interaction.guild, crudo);

  const { categoria, actualizado } = await agregarOActualizarCategoria(
    CTA_COMPS_PATH,
    resolved.key,
    { nombre, emojiCrudo },
    { resolverEmoji: resolver },
  );

  await interaction.editReply({
    embeds: [
      mutationEmbed({
        title: actualizado ? 'Categoría actualizada' : 'Categoría creada',
        description: `${categoria.emoji} **${escapeMarkdown(categoria.nombre)}** en "${resolved.comp.nombre}".` +
          (actualizado ? '' : '\n\nAhora añade roles con `/comp rol crear`.'),
        actorTag: interaction.user.tag,
      }),
    ],
  });
}

async function handleCategoriaBorrar(interaction) {
  const resolved = await resolveCompOrRespond(interaction);
  if (!resolved) return;

  const categoriaKey = resolverCategoriaKey(resolved.comp, interaction.options.getString('categoria', true));
  const { categoria } = await borrarCategoria(CTA_COMPS_PATH, resolved.key, categoriaKey);

  await interaction.editReply({
    embeds: [
      mutationEmbed({
        title: 'Categoría borrada',
        description: `${categoria.emoji} **${escapeMarkdown(categoria.nombre)}** ya no existe en "${resolved.comp.nombre}".`,
        actorTag: interaction.user.tag,
      }),
    ],
  });
}

// --- handlers: rol ---

async function handleRolCrear(interaction) {
  const resolved = await resolveCompOrRespond(interaction);
  if (!resolved) return;

  const categoriaKey = resolverCategoriaKey(resolved.comp, interaction.options.getString('categoria', true));
  const nombres = parsearLista(interaction.options.getString('roles', true));
  const emojis = parsearLista(interaction.options.getString('emojis', true));

  if (nombres.length !== emojis.length) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          'Los nombres y los emojis no emparejan',
          `Contaste ${nombres.length} nombre(s) y ${emojis.length} emoji(s). Deben ser el mismo número, en el mismo ` +
            'orden, separados por comas.',
        ),
      ],
    });
    return;
  }

  const entradas = nombres.map((nombre, i) => ({ nombre, emojiCrudo: emojis[i] }));
  const resolver = (crudo) => resolverEmoji(interaction.guild, crudo);

  const { categoria, creados } = await crearRoles(CTA_COMPS_PATH, resolved.key, categoriaKey, entradas, {
    resolverEmoji: resolver,
  });

  await interaction.editReply({
    embeds: [buildRolesCreadosEmbed({ compNombre: resolved.comp.nombre, categoria, creados })],
  });
}

async function handleRolBorrar(interaction) {
  const resolved = await resolveCompOrRespond(interaction);
  if (!resolved) return;

  const roleKeys = parsearLista(interaction.options.getString('roles', true)).map((texto) =>
    resolverRolKey(resolved.comp, texto),
  );
  const { borrados } = await borrarRoles(CTA_COMPS_PATH, resolved.key, roleKeys);

  await interaction.editReply({
    embeds: [
      mutationEmbed({
        title: 'Roles borrados',
        description: borrados.map((r) => `${r.emoji} ${escapeMarkdown(r.nombre)}`).join('\n'),
        actorTag: interaction.user.tag,
      }),
    ],
  });
}

async function handleRolMover(interaction) {
  const resolved = await resolveCompOrRespond(interaction);
  if (!resolved) return;

  const roleKeys = parsearLista(interaction.options.getString('roles', true)).map((texto) =>
    resolverRolKey(resolved.comp, texto),
  );
  const categoriaKey = resolverCategoriaKey(resolved.comp, interaction.options.getString('categoria', true));

  const { movidos, categoriaKey: destinoKey } = await moverRoles(CTA_COMPS_PATH, resolved.key, roleKeys, categoriaKey);
  const destino = resolved.comp.categorias[destinoKey] ?? (await getComp(CTA_COMPS_PATH, resolved.key)).categorias[destinoKey];

  await interaction.editReply({
    embeds: [
      mutationEmbed({
        title: 'Roles movidos',
        description: `${movidos.map((r) => escapeMarkdown(r.nombre)).join(', ')} → ${destino.emoji} **${escapeMarkdown(destino.nombre)}**`,
        actorTag: interaction.user.tag,
      }),
    ],
  });
}

// --- handlers: party ---

async function handlePartyAdd(interaction) {
  const resolved = await resolveCompOrRespond(interaction);
  if (!resolved) return;

  const nombre = interaction.options.getString('nombre', true);
  const { indice, party } = await agregarParty(CTA_COMPS_PATH, resolved.key, { nombre });

  await interaction.editReply({
    embeds: [
      mutationEmbed({
        title: 'Party añadida',
        description: `**${indice + 1}. ${escapeMarkdown(party.nombre)}** en "${resolved.comp.nombre}". Añádele slots con \`/comp slot add\`.`,
        actorTag: interaction.user.tag,
      }),
    ],
  });
}

async function handlePartyBorrar(interaction) {
  const resolved = await resolveCompOrRespond(interaction);
  if (!resolved) return;

  const indice1based = interaction.options.getInteger('party', true);
  const { party } = await borrarParty(CTA_COMPS_PATH, resolved.key, indice1based - 1);

  await interaction.editReply({
    embeds: [mutationEmbed({ title: 'Party borrada', description: `**${escapeMarkdown(party.nombre)}**.`, actorTag: interaction.user.tag })],
  });
}

async function handlePartyDuplicar(interaction) {
  const resolved = await resolveCompOrRespond(interaction);
  if (!resolved) return;

  const indice1based = interaction.options.getInteger('party', true);
  const { indiceNuevo, party } = await duplicarParty(CTA_COMPS_PATH, resolved.key, indice1based - 1);

  await interaction.editReply({
    embeds: [
      mutationEmbed({
        title: 'Party duplicada',
        description: `**${indiceNuevo + 1}. ${escapeMarkdown(party.nombre)}** (${party.slots.length} slot(s) copiados).`,
        actorTag: interaction.user.tag,
      }),
    ],
  });
}

// --- handlers: slot ---

async function handleSlotAdd(interaction) {
  const resolved = await resolveCompOrRespond(interaction);
  if (!resolved) return;

  const indice1based = interaction.options.getInteger('party', true);
  const rolKey = resolverRolKey(resolved.comp, interaction.options.getString('rol', true));
  const cantidadInput = interaction.options.getInteger('cantidad') ?? 1;

  const { cantidad, party } = await agregarSlot(CTA_COMPS_PATH, resolved.key, indice1based - 1, rolKey, cantidadInput);
  const rol = resolved.comp.roles[rolKey];

  await interaction.editReply({
    embeds: [
      mutationEmbed({
        title: 'Slot(s) añadidos',
        description:
          `${cantidad}× ${rol?.emoji ?? ''} ${escapeMarkdown(rol?.nombre ?? rolKey)} en **${escapeMarkdown(party.nombre)}** ` +
          `(ahora ${party.slots.length} slot(s)).`,
        actorTag: interaction.user.tag,
      }),
    ],
  });
}

async function handleSlotBorrar(interaction) {
  const resolved = await resolveCompOrRespond(interaction);
  if (!resolved) return;

  const indice1based = interaction.options.getInteger('party', true);
  const slot1based = interaction.options.getInteger('slot', true);

  const { rolKey } = await borrarSlot(CTA_COMPS_PATH, resolved.key, indice1based - 1, slot1based - 1);
  const rol = resolved.comp.roles[rolKey];

  await interaction.editReply({
    embeds: [
      mutationEmbed({
        title: 'Slot borrado',
        description: `${rol?.emoji ?? ''} ${escapeMarkdown(rol?.nombre ?? rolKey)}.`,
        actorTag: interaction.user.tag,
      }),
    ],
  });
}

// --- dispatch ---

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
  const group = interaction.options.getSubcommandGroup(false);
  const publico = group === null && (subcommand === 'ver' || subcommand === 'lista');

  await interaction.deferReply({ ephemeral: !publico });

  try {
    if (group === 'categoria') {
      if (subcommand === 'crear') return await handleCategoriaCrear(interaction);
      if (subcommand === 'borrar') return await handleCategoriaBorrar(interaction);
    } else if (group === 'rol') {
      if (subcommand === 'crear') return await handleRolCrear(interaction);
      if (subcommand === 'borrar') return await handleRolBorrar(interaction);
      if (subcommand === 'mover') return await handleRolMover(interaction);
    } else if (group === 'party') {
      if (subcommand === 'add') return await handlePartyAdd(interaction);
      if (subcommand === 'borrar') return await handlePartyBorrar(interaction);
      if (subcommand === 'duplicar') return await handlePartyDuplicar(interaction);
    } else if (group === 'slot') {
      if (subcommand === 'add') return await handleSlotAdd(interaction);
      if (subcommand === 'borrar') return await handleSlotBorrar(interaction);
    } else {
      if (subcommand === 'crear') return await handleCrear(interaction);
      if (subcommand === 'ver') return await handleVer(interaction);
      if (subcommand === 'lista') return await handleLista(interaction);
      if (subcommand === 'borrar') return await handleBorrar(interaction);
    }
    throw new Error(`Subcomando desconocido: ${group ? `${group} ` : ''}${subcommand}`);
  } catch (error) {
    // CtaCompError/EmojiNoEncontradoError son errores de validación esperados
    // (su mensaje ya dice qué hacer, ver services/ctaComp.js): se muestran
    // tal cual, sin pasar por el handler genérico.
    if (error instanceof CtaCompError || error instanceof EmojiNoEncontradoError) {
      await interaction.editReply({ embeds: [errorEmbed('No se pudo completar la operación', error.message)], components: [] });
      return;
    }
    throw error;
  }
}

// --- autocomplete ---

function autocompletarListaRoles(currentInput, comp) {
  const partes = String(currentInput ?? '').split(',');
  const ultima = (partes[partes.length - 1] ?? '').trim().toLowerCase();
  const prefijoKeys = partes
    .slice(0, -1)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  return Object.entries(comp.roles)
    .filter(([key, rol]) => rol.nombre.toLowerCase().includes(ultima) || key.includes(ultima))
    .slice(0, AUTOCOMPLETE_LIMIT)
    .map(([key, rol]) => {
      const keysCompletas = [...prefijoKeys, key];
      const valor = keysCompletas.join(',');
      const nombresCompletos = keysCompletas.map((k) => comp.roles[k]?.nombre ?? k).join(', ');
      return {
        name: (nombresCompletos.length <= 100 ? nombresCompletos : `…, ${rol.nombre}`).slice(0, 100),
        value: valor.length <= 100 ? valor : key,
      };
    });
}

/**
 * @param {import('discord.js').AutocompleteInteraction} interaction
 */
export async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);

  try {
    if (focused.name === 'comp') {
      const comps = await listarComps(CTA_COMPS_PATH);
      const query = String(focused.value).toLowerCase();
      const choices = comps
        .filter((c) => c.nombre.toLowerCase().includes(query))
        .slice(0, AUTOCOMPLETE_LIMIT)
        .map((c) => ({ name: c.nombre, value: c.key }));
      await interaction.respond(choices);
      return;
    }

    const compInput = interaction.options.getString('comp');
    if (!compInput) {
      await interaction.respond([]);
      return;
    }
    const comp = await getComp(CTA_COMPS_PATH, compInput);
    if (!comp) {
      await interaction.respond([]);
      return;
    }

    if (focused.name === 'categoria') {
      const query = String(focused.value).toLowerCase();
      const choices = Object.entries(comp.categorias)
        .filter(([, cat]) => cat.nombre.toLowerCase().includes(query))
        .slice(0, AUTOCOMPLETE_LIMIT)
        .map(([key, cat]) => ({ name: `${cat.emoji} ${cat.nombre}`, value: key }));
      await interaction.respond(choices);
      return;
    }

    if (focused.name === 'rol') {
      const query = String(focused.value).toLowerCase();
      const choices = Object.entries(comp.roles)
        .filter(([, rol]) => rol.nombre.toLowerCase().includes(query))
        .slice(0, AUTOCOMPLETE_LIMIT)
        .map(([key, rol]) => ({ name: `${rol.emoji} ${rol.nombre}`, value: key }));
      await interaction.respond(choices);
      return;
    }

    if (focused.name === 'roles') {
      await interaction.respond(autocompletarListaRoles(focused.value, comp));
      return;
    }

    if (focused.name === 'party') {
      const query = String(focused.value).toLowerCase();
      const choices = comp.parties
        .map((party, i) => ({ name: `${i + 1}. ${party.nombre}`, value: i + 1 }))
        .filter((c) => c.name.toLowerCase().includes(query))
        .slice(0, AUTOCOMPLETE_LIMIT);
      await interaction.respond(choices);
      return;
    }

    if (focused.name === 'slot') {
      const partyInput = interaction.options.getInteger('party');
      const party = partyInput ? comp.parties[partyInput - 1] : null;
      if (!party) {
        await interaction.respond([]);
        return;
      }
      const choices = party.slots
        .map((rolKey, i) => ({ name: `${i + 1}. ${comp.roles[rolKey]?.nombre ?? rolKey}`, value: i + 1 }))
        .slice(0, AUTOCOMPLETE_LIMIT);
      await interaction.respond(choices);
      return;
    }

    await interaction.respond([]);
  } catch (error) {
    console.error('Error en autocomplete de /comp:', error);
    await interaction.respond([]).catch(() => {});
  }
}
