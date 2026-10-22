import { getConfig, LANGUAGES } from './services/guildStore.js';

// Todos los textos que ve un usuario, en un único sitio: una tabla por idioma
// y t(clave, idioma, valores).
//
// Reglas:
// - Una clave por frase COMPLETA, con marcadores {nombre} para los valores.
//   Nunca se monta una frase pegando trozos traducidos: el orden de las
//   palabras cambia entre idiomas.
// - El plural va en claves separadas (.one / .other) y se elige con tn().
// - Lo que no se traduce va como valor: nombres de jugadores, de squads, de
//   gremios y los servidores de Albion (europe, americas, asia).
// - Si falta una clave en un idioma se usa el inglés y queda en el log;
//   nunca se enseña la clave cruda.
//
// Qué idioma usar:
// - Respuesta EFÍMERA (la ve una persona): el de su cliente, userLang().
// - Mensaje PÚBLICO (lo lee el servidor: embeds públicos, anuncios, canal de
//   logs): el del servidor, guildLang(), "idioma" en su config.json.

export const DEFAULT_LANGUAGE = 'en';
// Las dos locales de Discord en español: España y Latinoamérica.
const SPANISH_LOCALES = ['es-ES', 'es-419'];

const en = {
  // --- comunes ---
  'common.textUnavailable': '(text unavailable)',
  'common.confirm': 'Confirm',
  'common.cancel': 'Cancel',
  'common.notConfigured': 'not configured',
  'common.more': '… +{count} more',
  'common.noPermission.title': 'No permission',
  'common.officerOnly': 'This command is only for the officer role.',
  'common.officerRoleGone':
    'The officer role configured on this server no longer exists. An administrator can change it with `/config officer`.',
  'common.missingConfig.title': 'Missing configuration',
  'common.serverOnly.title': 'Servers only',
  'common.serverOnly.body': 'This command only works inside a server, not in direct messages.',
  'common.editedBy': 'Edited by {tag}',
  'common.language.en': 'English',
  'common.language.es': 'Spanish',

  // --- errores comunes (interactionErrorHandler) ---
  'error.invalidLink.title': 'Invalid albionbb link',
  'error.invalidLink.example': 'Valid example: `https://europe.albionbb.com/battles/418186013`',
  'error.battleNotFound.title': 'Battle not found',
  'error.battleNotFound.body': 'That battle was not found in the official API.',
  'error.albionDown.title': 'Albion API unavailable',
  'error.albionDown.body': 'The Albion API is not responding. Try again in a minute.',
  'error.albionbbGuildNotFound.title': 'Guild not found on albionbb',
  'error.albionbbGuildNotFound.body': 'That guild was not found on albionbb.',
  'error.albionbbDown.title': 'albionbb unavailable',
  'error.albionbbDown.body': 'albionbb is not responding right now. Try again later.',
  'error.config.title': 'Configuration error',
  'error.configHidden.title': 'Something went wrong',
  'error.configHidden.body': 'There is a configuration error. Contact an officer.',
  'error.unexpected.title': 'Unexpected error',
  'error.unexpected.body': 'Try again in a few minutes. If it keeps happening, tell an officer.',

  // --- enlaces de albionbb (InvalidLinkError) ---
  'link.notUrl': '"{url}" is not a valid URL.',
  'link.unknownHost': '"{host}" is not a known albionbb host.',
  'link.badPath': 'The path "{path}" is neither /battles/<id> nor /battles/multi?ids=<id>,...',
  'link.multiNoIds': '"{url}" is /battles/multi but has no "ids" parameter.',
  'link.notNumeric': 'The battle id "{id}" is not a number.',

  // --- squads.json roto (ConfigError) ---
  'configFile.notFound': 'Could not access the configuration file "{path}": {detail}',
  'configFile.parse': 'Could not read or parse "{path}": {detail}',
  'configFile.root': 'The configuration file "{path}" must contain a root object.',
  'configFile.rootKeys': '"{path}" must have exactly the key "squads" (found: {keys}).',
  'configFile.squadsNotObject': '"squads" in "{path}" must be an object.',
  'configFile.duplicateSquad': 'The squad "{squad}" in "{path}" is duplicated (case-insensitive).',
  'configFile.squadShape': 'The squad "{squad}" in "{path}" must be an object with exactly "isGuild" and "members".',
  'configFile.isGuildType': '"isGuild" of the squad "{squad}" in "{path}" must be true or false.',
  'configFile.membersType': '"members" of the squad "{squad}" in "{path}" must be an array.',
  'configFile.guildName':
    'The guild squad "{squad}" in "{path}" is not a valid guild name (1 to {max} characters, no leading or trailing spaces).',
  'configFile.member':
    'The squad "{squad}" in "{path}" has an invalid player name: {member} (it must be a string of {min} to {max} characters).',
  'configFile.warning.guildMembers.one':
    'The guild squad "{squad}" has 1 name in "members": it is ignored, its members come from the guild.',
  'configFile.warning.guildMembers.other':
    'The guild squad "{squad}" has {count} names in "members": they are ignored, its members come from the guild.',
  'configFile.warning.playerInSeveral': 'The player "{player}" is in several squads: "{kept}" and "{other}" ("{kept}" is kept).',
  'configFile.migrationConflict':
    'The guild "{guild}" from the old list cannot become a guild squad: there is already a player squad called ' +
    '"{squad}". Rename one of them in squads.json by hand. Nothing was changed.',

  // --- /getkills ---
  'cmd.getkills.name': 'getkills',
  'cmd.getkills.description': 'Kills and deaths of the guild and of each squad in a battle',
  'cmd.getkills.opt.url.name': 'url',
  'cmd.getkills.opt.url.description': 'albionbb battle link, e.g. https://europe.albionbb.com/battles/418186013',
  'kills.title': '💥 Kills/Deaths per Bombsquads',
  'kills.noSquads':
    '⚠️ This server has no squads yet, so everyone counts as MAIN ZERG. An officer can create them with `/squads create`.',
  'kills.battlesProcessed': 'Battles processed: {processed}/{requested}',
  'kills.alliance': 'Friendly alliance (detected): {alliance}',
  'kills.uniqueMain': 'Unique counted players ({guild}): {count}',
  'kills.uniqueFollowed': 'Unique counted players (followed guilds): {count}',
  'kills.uniqueEnemies': 'Unique counted enemies (not in the friendly alliance): {count}',
  'kills.uniqueEnemiesFollowed': 'Unique counted enemies (not in the friendly alliance nor in a followed guild): {count}',
  'kills.total': '**TOTAL {guild}**',
  'kills.kd': 'K-D: {kills} - {deaths}',
  'kills.followedHeader': '**FOLLOWED GUILDS (subtotal)**',
  'kills.combinedHeader': '**COMBINED ({guild} + followed guilds)**',
  'kills.combinedLine': 'K-D: {kills} - {deaths} · Pax: {pax}',
  'kills.footer.main': 'Only players in {guild} are counted. Enemies = players not in the detected friendly alliance.',
  'kills.footer.followed':
    'TOTAL = MAIN ZERG + player squads ({guild} only). Followed guilds are counted separately. ' +
    'Enemies = players not in the detected friendly alliance nor in a followed guild.',
  'kills.followedField.name': '🤝 Followed guilds',
  'kills.followedField.value': 'Not part of the {guild} total. Subtotal K-D: **{kills} - {deaths}** Pax: {pax}',
  'kills.bucket.header': '**{kills}** ({percent}%)\nK-D: **{kills} - {deaths}** Pax: {pax}',
  'kills.bucket.topKillers': 'Top killers',
  'kills.bucket.players': 'Players',

  // --- /attendance ---
  'cmd.attendance.name': 'attendance',
  'cmd.attendance.description': "A player's battle attendance",
  'cmd.attendance.opt.player.name': 'player',
  'cmd.attendance.opt.player.description': 'Player name',
  'cmd.attendance.opt.days.name': 'days',
  'cmd.attendance.opt.days.description': 'How many days back to look (default 30)',
  'cmd.attendance.choice.days7': '7 days',
  'cmd.attendance.choice.days14': '14 days',
  'cmd.attendance.choice.days30': '30 days',
  'cmd.attendance.choice.days90': '90 days',
  'attendance.title': '📊 Attendance — {player}',
  'attendance.titleWithSquad': '📊 Attendance — {player} [{squad}]',
  'attendance.field.attendance': 'Attendance',
  'attendance.value.battles.one': '**{count}** battle\n#{rank} of {total}',
  'attendance.value.battles.other': '**{count}** battles\n#{rank} of {total}',
  'attendance.field.kd': 'K / D',
  'attendance.value.kd': '{kills} / {deaths}\nRatio: **{ratio}**',
  'attendance.field.avgIp': 'Avg IP',
  'attendance.field.damage': 'Damage',
  'attendance.field.healing': 'Healing',
  'attendance.field.killFame': 'Kill fame',
  'attendance.field.lastBattle': 'Last battle',
  'attendance.field.roles': 'Roles',
  'attendance.role.tank': 'Tank',
  'attendance.role.support': 'Support',
  'attendance.role.healer': 'Healer',
  'attendance.role.meleeDps': 'Melee DPS',
  'attendance.role.rangedDps': 'Ranged DPS',
  'attendance.role.mounted': 'Mounted',
  'attendance.noSquad.name': '⚠️ No squad assigned',
  'attendance.noSquad.value': "This player shows up in the guild's attendance but is not in any squad.",
  'attendance.footer': 'albionbb data · range {start} → {end}',
  'attendance.notFound.title': 'Player not found',
  'attendance.notFound.body': "I couldn't find **{player}** in the guild's attendance for this date range.",
  'attendance.notFound.suggestions': "I couldn't find **{player}** in the guild's attendance for this date range.\n\nDid you mean…?\n{suggestions}",

  // --- /raffle ---
  'cmd.raffle.name': 'raffle',
  'cmd.raffle.description': 'Start a raffle in this channel (officers only)',
  'cmd.raffle.opt.minutes.name': 'minutes',
  'cmd.raffle.opt.minutes.description': 'Duration in minutes (1-1440)',
  'cmd.raffle.opt.role.name': 'role',
  'cmd.raffle.opt.role.description': 'Only members of this role can take part (optional)',
  'raffle.error.duration.title': 'Invalid duration',
  'raffle.error.duration.body': 'Minutes must be a whole number between {min} and {max}.',
  'raffle.error.everyone.title': 'Invalid role',
  'raffle.error.everyone.body': "You can't use @everyone as the raffle role: it's the same as not restricting it.",
  'raffle.error.active.title': 'There is already an active raffle',
  'raffle.error.active.body': 'Only one active raffle per channel. Wait for it to finish.',
  'raffle.created': 'Raffle created.',
  'raffle.announce': '{ping}<@{creator}> started a raffle that ends <t:{ends}:R>.\n\nReact with 🎉 to join.',
  'raffle.announce.restricted':
    '{ping}<@{creator}> started a raffle that ends <t:{ends}:R>.\n\nReact with 🎉 to join (members of <@&{role}> only).',
  'raffle.results.title': '🎲 Raffle results 🎲',
  'raffle.results.winner': '🥇 **Winner: <@{user}> with a roll of {roll}!**',
  'raffle.results.single': 'Only participant.',
  'raffle.results.tiebreak': '⚖️ Tie at **{roll}** between {count} participants, settled with a second roll.',
  'raffle.results.delayed': '⏱️ This raffle was resolved late because the bot was down when it ended.',
  'raffle.results.rollsField': 'ROLLS',
  'raffle.footer.rolls': 'Rolls 1–100',
  'raffle.footer.valid': 'Rolls 1–100 · {valid} of {total} valid participants',
  'raffle.footer.count': 'Rolls 1–100 · {count} participants',
  'raffle.none.roleMissing':
    "The role required for this raffle no longer exists, so it wasn't possible to check who met the requirement. Nobody took part.",
  'raffle.none.noValid.one': '1 person reacted, but they did not have the role required to take part.',
  'raffle.none.noValid.other': '{count} people reacted, but none of them had the role required to take part.',
  'raffle.none.nobody': 'Nobody took part.',
  'raffle.winnerLine': "<@{winner}> won <@{creator}>'s raffle",
  'raffle.messageDeleted': '⚠️ A raffle could not be resolved: the original message was deleted.',

  // --- /create-role ---
  'cmd.createRole.name': 'create-role',
  'cmd.createRole.description': 'Create a role and give it to a list of people (officers only)',
  'cmd.createRole.opt.name.name': 'name',
  'cmd.createRole.opt.name.description': 'Name of the role to create',
  'cmd.createRole.opt.list.name': 'list',
  'cmd.createRole.opt.list.description': '@user mentions, separated by spaces or commas',
  'createRole.error.nameEmpty.title': 'Invalid name',
  'createRole.error.nameEmpty.body': "The role name can't be empty.",
  'createRole.error.massMention.title': 'Invalid name',
  'createRole.error.massMention.body': "The role name can't contain @everyone or @here.",
  'createRole.error.exists.title': 'The role already exists',
  'createRole.error.exists.body': 'There is already a role called "{role}" on this server. Pick another name.',
  'createRole.resolving': 'Resolving the list…',
  'createRole.nobody.title': "Couldn't resolve anyone",
  'createRole.nobody.body.one': "The only name on the list doesn't match any member of this server:\n{list}",
  'createRole.nobody.body.other': "None of the {count} names on the list match a member of this server:\n{list}",
  'createRole.preview.title': '/create-role preview',
  'createRole.preview.role': 'Role to create: **{role}**',
  'createRole.preview.resolved.one': '**1** person resolved.',
  'createRole.preview.resolved.other': '**{count}** people resolved.',
  'createRole.preview.unresolved': "\nCouldn't resolve (check the spelling):\n{list}",
  'createRole.expired': 'Confirmation expired. No role was created.',
  'createRole.cancelled': 'Creation cancelled.',
  'createRole.failed.title': "Couldn't create the role",
  'createRole.auditReason': '/create-role by {tag}',
  'createRole.result.title': 'Role created',
  'createRole.result.role': 'Role created: {role}',
  'createRole.result.assigned.one': 'Assigned to **{assigned}** of 1 resolved person.',
  'createRole.result.assigned.other': 'Assigned to **{assigned}** of {count} resolved people.',
  'createRole.result.unresolved': "Couldn't resolve: {list}",
  'createRole.result.failed': "Couldn't give them the role: {list}",
  'rolePrereq.noPermission': 'The bot does not have the "Manage Roles" permission on this server. Grant it before creating a role.',
  'rolePrereq.tooLow':
    "The bot's role is too low in the hierarchy (it must be above position 1, right above @everyone). " +
    "Move the bot's role up in Server Settings -> Roles before creating a role.",
  'rolePrereq.limit': "The server already has {count} roles (Discord's limit is {max}). The role can't be created.",
  'rolePrereq.nearLimit': 'The server has {count} roles, close to the limit of {max}.',

  // --- /health ---
  'cmd.health.name': 'health',
  'cmd.health.description': 'Bot status (officers only)',
  'health.title': '🩺 FOAB Bot — Health',
  'health.field.uptime': 'Uptime',
  'health.field.version': 'Version',
  'health.field.servers': 'Servers',
  'health.servers.value': 'In **{total}**, {complete} with a complete configuration',
  'health.field.latency': 'Albion API latency ({server})',
  'health.latency.value': '{ms}ms',
  'health.latency.none': 'no response',
  'health.field.squads': 'Squads / players loaded',
  'health.squads.playerSquads.one': '1 player squad',
  'health.squads.playerSquads.other': '{count} player squads',
  'health.squads.players.one': '1 player',
  'health.squads.players.other': '{count} players',
  'health.squads.followed.one': '1 followed guild',
  'health.squads.followed.other': '{count} followed guilds',
  'health.squads.loadError': "⚠️ Couldn't load squads.json ({detail})",
  'health.field.lastBackup': 'Last backup',
  'health.noBackups': 'no backups yet',
  'health.unknownVersion': 'unknown',

  // --- /dm ---
  'cmd.dm.name': 'dm',
  'cmd.dm.description': 'Send a private message to several people (DM_OWNER_ID only)',
  'cmd.dm.opt.role.name': 'role',
  'cmd.dm.opt.role.description': 'To every member of this role',
  'cmd.dm.opt.list.name': 'list',
  'cmd.dm.opt.list.description': 'Or to this list: @user mentions, separated by spaces or commas',
  'dm.disabled.title': 'Command disabled',
  'dm.disabled.body': '/dm is disabled: DM_OWNER_ID is not set.',
  'dm.unauthorized.body': 'Only one specific person can use this command. The attempt has been logged.',
  'dm.recipients.title': 'Recipients',
  'dm.recipients.body': 'Give **one** of the two: `role` or `list`.',
  'dm.everyone.title': 'Role not allowed',
  'dm.everyone.body': "@everyone can't be a /dm recipient.",
  'dm.tooMany.title': 'Too many recipients',
  'dm.tooMany.role': 'The role has more than {max} members. /dm is capped at {max}.',
  'dm.tooMany.list': "That's {count} and /dm is capped at {max}. Nothing was sent.",
  'dm.wait.title': 'Wait a moment',
  'dm.block.inProgress': 'A /dm is being sent right now. Wait for it to finish.',
  'dm.block.cooldown.one': 'Only one /dm every 10 minutes. You can send another in 1 minute.',
  'dm.block.cooldown.other': 'Only one /dm every 10 minutes. You can send another in {count} minutes.',
  'dm.withBody': "{description}\n\nYour message, so it isn't lost:\n>>> {body}",
  'dm.modal.title': 'Private message',
  'dm.modal.label': 'Message (it arrives exactly as you write it)',
  'dm.empty.title': 'Empty message',
  'dm.empty.body': "The message can't be empty.",
  'dm.tooLong.title': 'Message too long',
  'dm.tooLong.body': 'At most {max} characters.',
  'dm.nobody.title': 'Nobody to send it to',
  'dm.nobody.role': 'The role has no members (other than bots).',
  'dm.nobody.list.one': "The only name on the list doesn't match any member of this server:\n{list}",
  'dm.nobody.list.other': 'None of the {count} names on the list match a member of this server:\n{list}',
  'dm.send.one': 'Send to 1',
  'dm.send.other': 'Send to {count}',
  'dm.expired': 'Confirmation expired. Nothing was sent.',
  'dm.cancelled': 'Sending cancelled. Nothing was sent.',
  'dm.sending.one': 'Sending to 1 person. Progress and the result are posted in the channel.',
  'dm.sending.other': 'Sending to {count} people, one per second. Progress and the result are posted in the channel.',
  'dm.preview.title': '/dm preview',
  'dm.preview.recipients': 'Recipients: **{count}**.',
  'dm.preview.optedOut.one': '**1** of them has the opt-out role and will be skipped.',
  'dm.preview.optedOut.other': '**{count}** of them have the opt-out role and will be skipped.',
  'dm.preview.bots.one': '**1** bot will be skipped.',
  'dm.preview.bots.other': '**{count}** bots will be skipped.',
  'dm.preview.unresolved': "\nCouldn't resolve (check the spelling):\n{list}",
  'dm.preview.footer': '\nAbove is the **exact** message they will receive. One per second.',
  'dm.progress': '📨 Sending /dm… {processed}/{total}',
  'dm.result.sent': '✅ Received the message: **{count}**.',
  'dm.result.dmClosed': '🔒 DMs closed (**{count}**): {list}',
  'dm.result.failed': '⚠️ Other send failures (**{count}**): {list}',
  'dm.result.optedOut': '🙅 Skipped by the opt-out role (**{count}**): {list}',
  'dm.result.bots': '🤖 Bots skipped: **{count}**.',
  'dm.result.unresolved': "❓ Couldn't resolve (**{count}**): {list}",
  'dm.result.title': '📨 /dm sent',
  'dm.result.sender': 'Sent by {sender}.\n\n{summary}',

  // --- /squads (nombres solo en inglés; descripciones localizadas) ---
  // El nombre es el mismo en los dos idiomas: está aquí para los textos que
  // citan el comando, no para localizarlo.
  'cmd.squads.name': 'squads',
  'cmd.squads.description': 'Manage player squads and guild squads (officers only)',
  'cmd.squads.list.description': 'List every squad with its member count',
  'cmd.squads.show.description': "Show a squad's members",
  'cmd.squads.create.description': 'Create an empty player squad, or one that follows a whole Albion guild',
  'cmd.squads.delete.description': 'Delete a squad (asks for confirmation)',
  'cmd.squads.add.description': 'Add one or more players to a squad',
  'cmd.squads.remove.description': 'Remove a player from a squad',
  'cmd.squads.rename.description': 'Rename a squad, keeping its members',
  'cmd.squads.move.description': 'Move a player to another squad',
  'cmd.squads.find.description': 'Tell which squad a player is in',
  'cmd.squads.opt.squad.description': 'Squad',
  'cmd.squads.opt.currentSquad.description': 'Current squad',
  'cmd.squads.opt.targetSquad.description': 'Target squad',
  'cmd.squads.opt.name.description': 'Squad key; with is-guild, the exact Albion guild name',
  'cmd.squads.opt.isGuild.description': 'Follow the Albion guild with the same name as the squad (default: no)',
  'cmd.squads.opt.players.description': 'Player names separated by commas',
  'cmd.squads.opt.player.description': 'Player',
  'cmd.squads.opt.newName.description': 'New key',
  'squads.error.title': "Couldn't complete the operation",
  'squads.list.title': 'Squads',
  'squads.list.empty': 'No squads yet. Create one with `/squads create`.',
  'squads.list.playersHeader': '__Player squads__',
  'squads.list.guildsHeader': '__Followed guilds__',
  'squads.list.playerLine.one': '👥 **{squad}** — 1 player on the list',
  'squads.list.playerLine.other': '👥 **{squad}** — {count} players on the list',
  'squads.list.guildLine': '🛡️ **{squad}** — Albion guild (automatic members)',
  'squads.show.title': 'Squad {squad}',
  'squads.show.guild':
    '🛡️ Follows the Albion guild **{guild}**.\nIts members are taken from the guild in each battle: there is no list of names.',
  'squads.create.title.players': 'Squad "{squad}" created',
  'squads.create.title.guild': 'Guild squad "{squad}" created',
  'squads.create.body.players': 'No members yet. Use `/squads add` to add players.',
  'squads.create.body.guild':
    'Follows the Albion guild **{guild}**: in /getkills its members come from the guild, in their own section. ' +
    'Careful: renaming the squad changes which guild it follows.',
  'squads.delete.confirm': 'Confirm deletion',
  'squads.delete.ask.guild': 'Are you sure you want to delete the guild squad **{squad}**? It will no longer be followed in /getkills.',
  'squads.delete.ask.players.one': "Are you sure you want to delete the squad **{squad}** (1 member)? This can't be undone.",
  'squads.delete.ask.players.other':
    "Are you sure you want to delete the squad **{squad}** ({count} members)? This can't be undone.",
  'squads.delete.expired': 'Confirmation expired. The squad was not deleted.',
  'squads.delete.cancelled': 'Deletion cancelled.',
  'squads.delete.title': 'Squad "{squad}" deleted',
  'squads.delete.body.guild': 'The Albion guild "{guild}" is no longer followed.',
  'squads.delete.body.players.one': 'It had 1 member.',
  'squads.delete.body.players.other': 'It had {count} members.',
  'squads.updated.title': 'Squad "{squad}" updated',
  'squads.add.added': 'Added: {names}',
  'squads.add.already': 'Already in the squad (ignored): {names}',
  'squads.add.crossSquad': '⚠️ {name} is also in "{other}". If that was a mistake, use `/squads move player:{name} squad:{squad}`.',
  'squads.add.noChanges': 'No changes.',
  'squads.remove.body': 'Removed {name}.',
  'squads.rename.confirm': 'Change guild',
  'squads.rename.ask':
    '⚠️ **{current}** is a guild squad: its name is the Albion guild it follows. If you rename it to **{next}**, ' +
    'it will stop following "{current}" and start following the guild "{next}". Continue?',
  'squads.rename.expired': 'Confirmation expired. The squad was not renamed.',
  'squads.rename.cancelled': 'Rename cancelled.',
  'squads.rename.title': 'Squad renamed',
  'squads.rename.body.guild': 'The guild squad "{old}" is now "{new}": it follows the Albion guild "{new}".',
  'squads.rename.body.players': '"{old}" is now called "{new}".',
  'squads.move.title': 'Player moved',
  'squads.move.body': '{name}: "{from}" → "{to}".',
  'squads.find.found': '**{player}** is in the squad **{squad}**.',
  'squads.find.notFound': "**{player}** isn't in any known squad.",
  'squads.log.title': '📝 /squads changed squads.json',
  'squadsError.keyLength': 'The squad key must be 1 to {max} characters long.',
  'squadsError.keyChars':
    'The squad key "{key}" can only contain lowercase letters (a-z), numbers and dashes. If it is an Albion guild, create it with is-guild:true.',
  'squadsError.guildNameLength': 'The guild name must be 1 to {max} characters long.',
  'squadsError.noSquad': 'Give a squad.',
  'squadsError.playerLength': 'The player name "{name}" must be {min} to {max} characters long.',
  'squadsError.guildSquad.add':
    '"{squad}" is a guild squad: its members come from the Albion guild "{squad}" in each battle, not from a list, ' +
    "so you can't add players to it by hand. To follow specific players, create a player squad.",
  'squadsError.guildSquad.remove':
    '"{squad}" is a guild squad: its members come from the Albion guild "{squad}" in each battle, not from a list, ' +
    "so you can't remove players from it by hand. To follow specific players, create a player squad.",
  'squadsError.guildSquad.move':
    '"{squad}" is a guild squad: its members come from the Albion guild "{squad}" in each battle, not from a list, ' +
    "so you can't move players into it. To follow specific players, create a player squad.",
  'squadsError.mainGuild':
    '"{guild}" is the main guild of this server: it already counts as MAIN ZERG. A guild squad with that name would count everyone twice.',
  'squadsError.exists.players': 'There is already a player squad called "{squad}".',
  'squadsError.exists.guild': 'There is already a guild squad called "{squad}".',
  'squadsError.existsAny': 'There is already a squad called "{squad}".',
  'squadsError.notFound': 'The squad "{squad}" does not exist.',
  'squadsError.notFoundCreate': 'The squad "{squad}" does not exist. Create it first with /squads create.',
  'squadsError.noPlayers': 'Give at least one player name.',
  'squadsError.notInSquad': '"{player}" is not in the squad "{squad}".',
  'squadsError.changed': 'The squad "{squad}" changed in the meantime. Try again.',
  'squadsError.playerNoSquad': '"{player}" is not in any squad. Use /squads add to add them.',
  'squadsError.alreadyIn': '"{player}" is already in "{squad}".',

  // --- /config (nombres solo en inglés; descripciones localizadas) ---
  'cmd.config.description': 'Set up the bot on this server (administrators only)',
  'cmd.config.view.description': 'Show the current configuration and what is missing',
  'cmd.config.officer.description': 'Officer role: can use /squads, /raffle, /create-role and /health',
  'cmd.config.logs.description': 'Channel where the bot records changes and errors',
  'cmd.config.raffleRole.description': 'Role that /raffle mentions when announcing a raffle (optional)',
  'cmd.config.dmOptout.description': 'Role whose members do not receive /dm (optional)',
  'cmd.config.server.description': "The guild's Albion server",
  'cmd.config.guild.description': 'Main Albion guild (just one; the others, with /squads create)',
  'cmd.config.albionbb.description': "The guild's albionbb id, for /attendance",
  'cmd.config.language.description': 'Language of the messages everyone on the server sees',
  'cmd.config.reset.description': 'Put a setting back to its default value',
  'cmd.config.opt.role.officer': 'Officer role',
  'cmd.config.opt.role.raffle': 'Role to mention',
  'cmd.config.opt.role.dmOptout': 'Opt-out role',
  'cmd.config.opt.channel.description': 'Text channel',
  'cmd.config.opt.name.description': 'Exact name of the guild in Albion',
  'cmd.config.opt.value.server': 'Albion server',
  'cmd.config.opt.value.albionbb': "The guild's id (or the URL of its albionbb page)",
  'cmd.config.opt.value.language': 'Language',
  'cmd.config.opt.field.description': 'Setting to reset',
  'config.noAdmin': 'This command is only for members with the Administrator permission on this server.',
  'config.rejected.title': 'Nothing was changed',
  'config.unchanged.title': 'Nothing changed',
  'config.unchanged.body': '{label}: it was already {value}.',
  'config.view.title': "⚙️ This server's configuration",
  'config.view.fieldName': '{label} · /config {sub}',
  'config.view.missingRequired': '❌ **not configured**',
  'config.view.missingOptional': '➖ not configured (optional)',
  'config.view.brokenRole': '⚠️ The configured role (`{id}`) no longer exists',
  'config.view.brokenChannel': '⚠️ The configured channel (`{id}`) no longer exists',
  'config.view.gapsTitle': "What doesn't work yet",
  'config.view.statusTitle': 'Status',
  'config.view.allSet': '✅ Everything is configured: every command works.',
  'config.view.lastChange': 'Last change {when} by {who}.',
  'config.view.lastChangeNoActor': 'Last change {when}.',
  'config.view.neverConfigured': 'Nobody has configured this server yet. Start with `/config officer` and `/config guild`.',
  'config.change.before': '**Before:** {value}',
  'config.change.after': '**Now:** {value}',
  'config.change.pending': 'Still missing: {subs}. See `/config view`.',
  'config.change.complete': '✅ Nothing required is missing anymore.',
  'config.field.officerRoleId.label': 'Officer role',
  'config.field.officerRoleId.missing':
    'This server has no officer role configured. An administrator can set it with `/config officer`.',
  'config.field.officerRoleId.gap': "🚫 {commands} don't work: the officer role is missing → `/config officer`",
  'config.field.logChannelId.label': 'Log channel',
  'config.field.logChannelId.missing':
    'This server has no log channel configured. An administrator can set it with `/config logs`.',
  'config.field.logChannelId.gap':
    '⚠️ Changes (/squads, /config, /create-role, /dm) and errors are not recorded anywhere → `/config logs`',
  'config.field.raffleRoleId.label': 'Role to mention in raffles',
  'config.field.raffleRoleId.missing':
    'This server has no raffle role configured. An administrator can set it with `/config raffle-role`.',
  'config.field.raffleRoleId.gap': "ℹ️ /raffle works, but doesn't mention any role when announcing → `/config raffle-role`",
  'config.field.dmOptoutRoleId.label': "Role that doesn't receive /dm",
  'config.field.dmOptoutRoleId.missing':
    'This server has no /dm opt-out role configured. An administrator can set it with `/config dm-optout`.',
  'config.field.dmOptoutRoleId.gap': 'ℹ️ /dm works, but nobody can opt out of receiving them → `/config dm-optout`',
  'config.field.albionServer.label': 'Albion server',
  'config.field.albionServer.missing':
    'This server has no Albion server configured. An administrator can set it with `/config server`.',
  'config.field.albionServer.gap': '🚫 /getkills and /attendance need an Albion server → `/config server`',
  'config.field.albionGuild.label': 'Albion guild',
  'config.field.albionGuild.missing':
    'This server has no Albion guild configured. An administrator can set it with `/config guild`.',
  'config.field.albionGuild.gap': "🚫 {commands} doesn't work: the Albion guild is missing → `/config guild`",
  'config.field.albionbbGuildId.label': "Guild's albionbb id",
  'config.field.albionbbGuildId.missing':
    "This server has no albionbb guild id configured. An administrator can set it with `/config albionbb`.",
  'config.field.albionbbGuildId.gap': "🚫 {commands} doesn't work: the albionbb id is missing → `/config albionbb`",
  'config.field.idioma.label': 'Language',
  'config.field.idioma.missing': 'This server has no language configured. An administrator can set it with `/config language`.',
  'config.field.idioma.gap': 'ℹ️ Public messages are in English until a language is set → `/config language`',
  'config.error.everyone.officer': "@everyone can't be the officer role: pick a specific role.",
  'config.error.everyone.raffle': "@everyone can't be the raffle role: pick a specific role.",
  'config.error.everyone.dmOptout': "@everyone can't be the /dm opt-out role: pick a specific role.",
  'config.error.managedRole':
    "{role} is managed by an integration (a bot or a subscription): it can't be given to anyone by hand. Pick another role.",
  'config.error.logChannelType': 'The log channel must be a text (or announcement) channel on this server.',
  'config.error.logChannelPerms': "I can't write in <#{channel}>: I'm missing {permissions} in that channel. Grant them and try again.",
  'config.perm.viewChannel': '**View Channel**',
  'config.perm.sendMessages': '**Send Messages**',
  'config.perm.embedLinks': '**Embed Links**',
  'config.perm.attachFiles': '**Attach Files**',
  'config.error.server': 'The Albion server must be one of: {servers}.',
  'config.note.serverAlbionbb': 'The albionbb id belongs to a specific server: if the guild is not on this one, change it with `/config albionbb`.',
  'config.error.guildComma':
    '`/config guild` takes a single guild: the main one. The others are followed as guild squads, one by one, ' +
    'with `/squads create name:<guild> is-guild:true`.',
  'config.error.guildLength': 'The guild name must be 1 to {max} characters long.',
  'config.error.guildClash':
    'There is already a guild squad following **{guild}**. As the main guild it would count everyone twice: delete it first with `/squads delete`.',
  'config.note.guildExact': 'It must match the guild name in Albion exactly, capitals and spaces included.',
  'config.error.albionbbFormat':
    "That doesn't look like an albionbb id. It's in the URL of the guild's page: " +
    '`https://europe.albionbb.com/guilds/<id>/...`. You can also paste the whole URL.',
  'config.error.albionbbNotFound':
    'albionbb has no guild with id `{id}` on the **{server}** server. Check the id or, if the guild is on another server, ' +
    'change it first with `/config server`.',
  'config.note.albionbbUnreachable': "⚠️ albionbb isn't responding right now: I couldn't check the id, it was saved anyway.",
  'config.error.language': 'The language must be one of: {languages}.',
  'config.log.title': '⚙️ /config changed the configuration',

  // --- canal de logs ---
  'log.field.officer': 'Officer',
  'log.field.subcommand': 'Subcommand',
  'log.field.role': 'Role',
  'log.field.command': 'Command',
  'log.field.user': 'User',
  'log.field.message': 'Message',
  'log.field.sender': 'Sender',
  'log.field.recipients': 'Recipients',
  'log.field.id': 'ID',
  'log.field.setting': 'Setting',
  'log.field.admin': 'Administrator',
  'log.field.before': 'Before',
  'log.field.after': 'Now',
  'log.roleCreated.title': '🆕 /create-role created a role',
  'log.error.title': '💥 Unhandled error',
  'log.dmUnauthorized.title': '🚫 /dm attempt without permission',
  'log.dmUnauthorized.body': '<@{user}> tried to use /dm and is not DM_OWNER_ID. Nothing was sent.',
  'log.dmStarted.title': '📨 /dm: sending started',
  'log.dmStarted.attached': "The text doesn't fit in an embed: it is attached as a file.",
  'log.dmFinished.title': '📨 /dm: sending finished',
  'log.dmInterrupted.title': '⚠️ /dm interrupted by a restart',
  'log.dmInterrupted.body':
    "A /dm by **{actor}** started <t:{started}:f> was cut off halfway: **{sent}** of {total} had been sent. **It hasn't been resumed.** " +
    'Decide by hand whether the rest need it.',

  // --- entrar en un servidor ---
  'welcome.new':
    "👋 Hi! I'm not set up on this server yet.\n" +
    'An administrator needs to run `/config view`: it shows what is missing and which command sets it.\n' +
    'Until then, every command that needs something unconfigured will say what it is missing.',
  'welcome.back':
    "👋 I'm back with this server's previous configuration and squads.\nAn administrator can review them with `/config view`.",
};

const es = {
  'common.textUnavailable': '(texto no disponible)',
  'common.confirm': 'Confirmar',
  'common.cancel': 'Cancelar',
  'common.notConfigured': 'sin configurar',
  'common.more': '… +{count} más',
  'common.noPermission.title': 'Sin permiso',
  'common.officerOnly': 'Este comando es solo para el rol de oficiales.',
  'common.officerRoleGone':
    'El rol de oficiales configurado en este servidor ya no existe. Un administrador puede cambiarlo con `/config officer`.',
  'common.missingConfig.title': 'Falta configuración',
  'common.serverOnly.title': 'Solo en servidores',
  'common.serverOnly.body': 'Este comando solo funciona dentro de un servidor, no por mensaje directo.',
  'common.editedBy': 'Editado por {tag}',
  'common.language.en': 'Inglés',
  'common.language.es': 'Español',

  'error.invalidLink.title': 'Enlace de albionbb no válido',
  'error.invalidLink.example': 'Ejemplo válido: `https://europe.albionbb.com/battles/418186013`',
  'error.battleNotFound.title': 'Batalla no encontrada',
  'error.battleNotFound.body': 'No se encontró esa batalla en la API oficial.',
  'error.albionDown.title': 'API de Albion no disponible',
  'error.albionDown.body': 'La API de Albion no responde, inténtalo en un minuto.',
  'error.albionbbGuildNotFound.title': 'Gremio no encontrado en albionbb',
  'error.albionbbGuildNotFound.body': 'No se encontró ese gremio en albionbb.',
  'error.albionbbDown.title': 'albionbb no disponible',
  'error.albionbbDown.body': 'albionbb no responde ahora mismo, inténtalo más tarde.',
  'error.config.title': 'Error de configuración',
  'error.configHidden.title': 'Ha ocurrido un error',
  'error.configHidden.body': 'Ha ocurrido un error de configuración. Contacta a un oficial.',
  'error.unexpected.title': 'Ha ocurrido un error inesperado',
  'error.unexpected.body': 'Inténtalo de nuevo en unos minutos. Si el problema persiste, avisa a un oficial.',

  'link.notUrl': '"{url}" no es una URL válida.',
  'link.unknownHost': '"{host}" no es un host de albionbb reconocido.',
  'link.badPath': 'La ruta "{path}" no tiene el formato /battles/<id> ni /battles/multi?ids=<id>,...',
  'link.multiNoIds': '"{url}" es /battles/multi pero le falta el parámetro "ids".',
  'link.notNumeric': 'El id de batalla "{id}" no es numérico.',

  'configFile.notFound': 'No se pudo acceder al archivo de configuración en "{path}": {detail}',
  'configFile.parse': 'No se pudo leer o parsear "{path}": {detail}',
  'configFile.root': 'El archivo de configuración "{path}" debe contener un objeto raíz.',
  'configFile.rootKeys': 'El archivo "{path}" debe tener exactamente la clave "squads" (encontradas: {keys}).',
  'configFile.squadsNotObject': '"squads" en "{path}" debe ser un objeto.',
  'configFile.duplicateSquad': 'El squad "{squad}" en "{path}" está duplicado (sin distinguir mayúsculas).',
  'configFile.squadShape': 'El squad "{squad}" en "{path}" debe ser un objeto con exactamente "isGuild" y "members".',
  'configFile.isGuildType': '"isGuild" del squad "{squad}" en "{path}" debe ser true o false.',
  'configFile.membersType': '"members" del squad "{squad}" en "{path}" debe ser un array.',
  'configFile.guildName':
    'El squad de gremio "{squad}" en "{path}" no es un nombre de gremio válido (1 a {max} caracteres, sin espacios al principio ni al final).',
  'configFile.member':
    'El squad "{squad}" en "{path}" contiene un nombre de jugador inválido: {member} (debe ser un texto de {min} a {max} caracteres).',
  'configFile.warning.guildMembers.one':
    'El squad de gremio "{squad}" tiene 1 nombre en "members": se ignora, sus miembros salen del gremio.',
  'configFile.warning.guildMembers.other':
    'El squad de gremio "{squad}" tiene {count} nombres en "members": se ignoran, sus miembros salen del gremio.',
  'configFile.warning.playerInSeveral': 'El jugador "{player}" está en varios squads: "{kept}" y "{other}" (se mantiene "{kept}").',
  'configFile.migrationConflict':
    'No se puede convertir el gremio "{guild}" de la lista vieja en squad de gremio: ya hay un squad de jugadores ' +
    'llamado "{squad}". Renombra uno de los dos en squads.json a mano. No se ha cambiado nada.',

  'cmd.getkills.name': 'getkills',
  'cmd.getkills.description': 'Muestra las kills y muertes del gremio y de cada squad en una batalla',
  'cmd.getkills.opt.url.name': 'url',
  'cmd.getkills.opt.url.description': 'Enlace de albionbb a la batalla, ej. https://europe.albionbb.com/battles/418186013',
  'kills.title': '💥 Kills/Muertes por Bombsquads',
  'kills.noSquads':
    '⚠️ Este servidor todavía no tiene squads, así que todos cuentan como MAIN ZERG. Un oficial puede crearlos con `/squads create`.',
  'kills.battlesProcessed': 'Batallas procesadas: {processed}/{requested}',
  'kills.alliance': 'Alianza amiga (detectada): {alliance}',
  'kills.uniqueMain': 'Jugadores únicos contados ({guild}): {count}',
  'kills.uniqueFollowed': 'Jugadores únicos contados (gremios seguidos): {count}',
  'kills.uniqueEnemies': 'Enemigos únicos contados (fuera de la alianza amiga): {count}',
  'kills.uniqueEnemiesFollowed': 'Enemigos únicos contados (fuera de la alianza amiga y de los gremios seguidos): {count}',
  'kills.total': '**TOTAL {guild}**',
  'kills.kd': 'K-D: {kills} - {deaths}',
  'kills.followedHeader': '**GREMIOS SEGUIDOS (subtotal)**',
  'kills.combinedHeader': '**CONJUNTO ({guild} + gremios seguidos)**',
  'kills.combinedLine': 'K-D: {kills} - {deaths} · Pax: {pax}',
  'kills.footer.main': 'Solo cuentan los jugadores de {guild}. Enemigos = jugadores fuera de la alianza amiga detectada.',
  'kills.footer.followed':
    'TOTAL = MAIN ZERG + squads de jugadores (solo {guild}). Los gremios seguidos se cuentan aparte. ' +
    'Enemigos = jugadores fuera de la alianza amiga detectada y de los gremios seguidos.',
  'kills.followedField.name': '🤝 Gremios seguidos',
  'kills.followedField.value': 'No entran en el total de {guild}. Subtotal K-D: **{kills} - {deaths}** Pax: {pax}',
  'kills.bucket.header': '**{kills}** ({percent}%)\nK-D: **{kills} - {deaths}** Pax: {pax}',
  'kills.bucket.topKillers': 'Top killers',
  'kills.bucket.players': 'Jugadores',

  'cmd.attendance.name': 'asistencia',
  'cmd.attendance.description': 'Consulta la asistencia a batallas de un jugador',
  'cmd.attendance.opt.player.name': 'jugador',
  'cmd.attendance.opt.player.description': 'Nombre del jugador',
  'cmd.attendance.opt.days.name': 'dias',
  'cmd.attendance.opt.days.description': 'Ventana de días a consultar (por defecto 30)',
  'cmd.attendance.choice.days7': '7 días',
  'cmd.attendance.choice.days14': '14 días',
  'cmd.attendance.choice.days30': '30 días',
  'cmd.attendance.choice.days90': '90 días',
  'attendance.title': '📊 Asistencia — {player}',
  'attendance.titleWithSquad': '📊 Asistencia — {player} [{squad}]',
  'attendance.field.attendance': 'Asistencia',
  'attendance.value.battles.one': '**{count}** batalla\n#{rank} de {total}',
  'attendance.value.battles.other': '**{count}** batallas\n#{rank} de {total}',
  'attendance.field.kd': 'K / D',
  'attendance.value.kd': '{kills} / {deaths}\nRatio: **{ratio}**',
  'attendance.field.avgIp': 'IP media',
  'attendance.field.damage': 'Daño',
  'attendance.field.healing': 'Curación',
  'attendance.field.killFame': 'Fama de kills',
  'attendance.field.lastBattle': 'Última batalla',
  'attendance.field.roles': 'Roles',
  'attendance.role.tank': 'Tanque',
  'attendance.role.support': 'Support',
  'attendance.role.healer': 'Healer',
  'attendance.role.meleeDps': 'DPS melee',
  'attendance.role.rangedDps': 'DPS a distancia',
  'attendance.role.mounted': 'Montado',
  'attendance.noSquad.name': '⚠️ Sin squad asignado',
  'attendance.noSquad.value': 'Este jugador aparece en la asistencia del gremio pero no está en ningún squad.',
  'attendance.footer': 'Datos de albionbb · rango {start} → {end}',
  'attendance.notFound.title': 'Jugador no encontrado',
  'attendance.notFound.body': 'No encontré a **{player}** en la asistencia del gremio para este rango de fechas.',
  'attendance.notFound.suggestions':
    'No encontré a **{player}** en la asistencia del gremio para este rango de fechas.\n\n¿Quisiste decir…?\n{suggestions}',

  'cmd.raffle.name': 'sorteo',
  'cmd.raffle.description': 'Lanza un sorteo en este canal (solo oficiales)',
  'cmd.raffle.opt.minutes.name': 'minutos',
  'cmd.raffle.opt.minutes.description': 'Duración en minutos (1-1440)',
  'cmd.raffle.opt.role.name': 'rol',
  'cmd.raffle.opt.role.description': 'Restringe la participación a los miembros de este rol (opcional)',
  'raffle.error.duration.title': 'Duración inválida',
  'raffle.error.duration.body': 'Los minutos deben ser un entero entre {min} y {max}.',
  'raffle.error.everyone.title': 'Rol inválido',
  'raffle.error.everyone.body': 'No puedes usar @everyone como rol del sorteo: equivale a no restringir la participación.',
  'raffle.error.active.title': 'Ya hay un sorteo activo',
  'raffle.error.active.body': 'Solo puede haber un sorteo activo por canal. Espera a que termine.',
  'raffle.created': 'Sorteo creado.',
  'raffle.announce': '{ping}<@{creator}> ha comenzado un sorteo que terminará <t:{ends}:R>.\n\nReacciona con 🎉 para participar.',
  'raffle.announce.restricted':
    '{ping}<@{creator}> ha comenzado un sorteo que terminará <t:{ends}:R>.\n\nReacciona con 🎉 para participar (solo miembros de <@&{role}>).',
  'raffle.results.title': '🎲 Resultados del sorteo 🎲',
  'raffle.results.winner': '🥇 **Ganador: <@{user}> con una tirada de {roll}!**',
  'raffle.results.single': 'Único participante.',
  'raffle.results.tiebreak': '⚖️ Empate a **{roll}** entre {count} participantes, resuelto con una segunda tirada.',
  'raffle.results.delayed': '⏱️ Este sorteo se resolvió con retraso porque el bot estuvo caído al cumplirse el plazo.',
  'raffle.results.rollsField': 'ROLLS',
  'raffle.footer.rolls': 'Tiradas 1–100',
  'raffle.footer.valid': 'Tiradas 1–100 · {valid} de {total} participantes válidos',
  'raffle.footer.count': 'Tiradas 1–100 · {count} participantes',
  'raffle.none.roleMissing':
    'El rol requerido para este sorteo ya no existe, así que no se pudo comprobar quién cumplía el requisito. Nadie participó.',
  'raffle.none.noValid.one': '1 persona reaccionó, pero no tenía el rol requerido para participar.',
  'raffle.none.noValid.other': '{count} personas reaccionaron, pero ninguna tenía el rol requerido para participar.',
  'raffle.none.nobody': 'Nadie participó.',
  'raffle.winnerLine': '<@{winner}> ha ganado el sorteo de <@{creator}>',
  'raffle.messageDeleted': '⚠️ No se pudo resolver un sorteo: el mensaje original fue borrado.',

  'cmd.createRole.name': 'crear-rol',
  'cmd.createRole.description': 'Crea un rol y se lo asigna a una lista de personas (solo oficiales)',
  'cmd.createRole.opt.name.name': 'nombre',
  'cmd.createRole.opt.name.description': 'Nombre del rol a crear',
  'cmd.createRole.opt.list.name': 'lista',
  'cmd.createRole.opt.list.description': '@usuario o menciones, separados por espacios o comas',
  'createRole.error.nameEmpty.title': 'Nombre inválido',
  'createRole.error.nameEmpty.body': 'El nombre del rol no puede estar vacío.',
  'createRole.error.massMention.title': 'Nombre inválido',
  'createRole.error.massMention.body': 'El nombre del rol no puede contener @everyone ni @here.',
  'createRole.error.exists.title': 'El rol ya existe',
  'createRole.error.exists.body': 'Ya hay un rol llamado "{role}" en este servidor. Elige otro nombre.',
  'createRole.resolving': 'Resolviendo la lista…',
  'createRole.nobody.title': 'No se ha podido resolver a nadie',
  'createRole.nobody.body.one': 'El único nombre de la lista no coincide con ningún miembro de este servidor:\n{list}',
  'createRole.nobody.body.other': 'Ninguno de los {count} nombres de la lista coincide con un miembro de este servidor:\n{list}',
  'createRole.preview.title': 'Previsualización de /crear-rol',
  'createRole.preview.role': 'Rol a crear: **{role}**',
  'createRole.preview.resolved.one': 'Se ha resuelto **1** persona.',
  'createRole.preview.resolved.other': 'Se han resuelto **{count}** personas.',
  'createRole.preview.unresolved': '\nNo se han podido resolver (revisa la ortografía):\n{list}',
  'createRole.expired': 'Confirmación expirada. No se creó ningún rol.',
  'createRole.cancelled': 'Creación cancelada.',
  'createRole.failed.title': 'No se pudo crear el rol',
  'createRole.auditReason': '/crear-rol por {tag}',
  'createRole.result.title': 'Rol creado',
  'createRole.result.role': 'Rol creado: {role}',
  'createRole.result.assigned.one': 'Asignado a **{assigned}** de 1 persona resuelta.',
  'createRole.result.assigned.other': 'Asignado a **{assigned}** de {count} personas resueltas.',
  'createRole.result.unresolved': 'No se pudieron resolver: {list}',
  'createRole.result.failed': 'No se les pudo asignar el rol: {list}',
  'rolePrereq.noPermission': 'El bot no tiene el permiso "Gestionar roles" en este servidor. Actívaselo antes de crear un rol.',
  'rolePrereq.tooLow':
    'El rol del bot está demasiado abajo en la jerarquía (tiene que estar por encima de la posición 1, justo ' +
    'encima de @everyone). Sube el rol del bot en Ajustes del servidor -> Roles antes de crear un rol.',
  'rolePrereq.limit': 'El servidor ya tiene {count} roles (el máximo de Discord es {max}). No se puede crear el rol.',
  'rolePrereq.nearLimit': 'El servidor tiene {count} roles, cerca del máximo de {max}.',

  'cmd.health.name': 'estado',
  'cmd.health.description': 'Estado del bot (solo oficiales)',
  'health.title': '🩺 FOAB Bot — Estado',
  'health.field.uptime': 'Tiempo activo',
  'health.field.version': 'Versión',
  'health.field.servers': 'Servidores',
  'health.servers.value': 'En **{total}**, {complete} con la configuración completa',
  'health.field.latency': 'Latencia API Albion ({server})',
  'health.latency.value': '{ms}ms',
  'health.latency.none': 'sin respuesta',
  'health.field.squads': 'Squads / jugadores cargados',
  'health.squads.playerSquads.one': '1 squad de jugadores',
  'health.squads.playerSquads.other': '{count} squads de jugadores',
  'health.squads.players.one': '1 jugador',
  'health.squads.players.other': '{count} jugadores',
  'health.squads.followed.one': '1 gremio seguido',
  'health.squads.followed.other': '{count} gremios seguidos',
  'health.squads.loadError': '⚠️ No se pudo cargar squads.json ({detail})',
  'health.field.lastBackup': 'Último backup',
  'health.noBackups': 'sin backups todavía',
  'health.unknownVersion': 'desconocida',

  'cmd.dm.name': 'dm',
  'cmd.dm.description': 'Envía un mensaje privado a varias personas (solo DM_OWNER_ID)',
  'cmd.dm.opt.role.name': 'rol',
  'cmd.dm.opt.role.description': 'A todos los miembros de este rol',
  'cmd.dm.opt.list.name': 'lista',
  'cmd.dm.opt.list.description': 'O a esta lista: @usuario o menciones, separados por espacios o comas',
  'dm.disabled.title': 'Comando desactivado',
  'dm.disabled.body': '/dm está desactivado: falta configurar DM_OWNER_ID.',
  'dm.unauthorized.body': 'Este comando solo lo puede usar una persona concreta. El intento queda registrado.',
  'dm.recipients.title': 'Destinatarios',
  'dm.recipients.body': 'Indica **uno** de los dos: `rol` o `lista`.',
  'dm.everyone.title': 'Rol no permitido',
  'dm.everyone.body': 'No se puede usar @everyone como destinatario de /dm.',
  'dm.tooMany.title': 'Demasiados destinatarios',
  'dm.tooMany.role': 'El rol tiene más de {max} miembros. /dm tiene un tope de {max}.',
  'dm.tooMany.list': 'Son {count} y el tope de /dm es {max}. No se ha enviado nada.',
  'dm.wait.title': 'Espera un poco',
  'dm.block.inProgress': 'Ya hay un /dm enviándose ahora mismo. Espera a que termine.',
  'dm.block.cooldown.one': 'Solo se permite un /dm cada 10 minutos. Podrás enviar otro en 1 minuto.',
  'dm.block.cooldown.other': 'Solo se permite un /dm cada 10 minutos. Podrás enviar otro en {count} minutos.',
  'dm.withBody': '{description}\n\nTu mensaje, para que no se pierda:\n>>> {body}',
  'dm.modal.title': 'Mensaje privado',
  'dm.modal.label': 'Mensaje (llega tal cual lo escribas)',
  'dm.empty.title': 'Mensaje vacío',
  'dm.empty.body': 'El mensaje no puede estar vacío.',
  'dm.tooLong.title': 'Mensaje demasiado largo',
  'dm.tooLong.body': 'Máximo {max} caracteres.',
  'dm.nobody.title': 'Nadie a quien enviar',
  'dm.nobody.role': 'El rol no tiene ningún miembro (que no sea un bot).',
  'dm.nobody.list.one': 'El único nombre de la lista no coincide con ningún miembro de este servidor:\n{list}',
  'dm.nobody.list.other': 'Ninguno de los {count} nombres de la lista coincide con un miembro de este servidor:\n{list}',
  'dm.send.one': 'Enviar a 1',
  'dm.send.other': 'Enviar a {count}',
  'dm.expired': 'Confirmación expirada. No se envió nada.',
  'dm.cancelled': 'Envío cancelado. No se envió nada.',
  'dm.sending.one': 'Enviando a 1 persona. El progreso y el resultado se publican en el canal.',
  'dm.sending.other': 'Enviando a {count} personas, una por segundo. El progreso y el resultado se publican en el canal.',
  'dm.preview.title': 'Previsualización de /dm',
  'dm.preview.recipients': 'Destinatarios: **{count}**.',
  'dm.preview.optedOut.one': 'De ellos, **1** tiene el rol de exclusión y se saltará.',
  'dm.preview.optedOut.other': 'De ellos, **{count}** tienen el rol de exclusión y se saltarán.',
  'dm.preview.bots.one': 'Se saltará **1** bot.',
  'dm.preview.bots.other': 'Se saltarán **{count}** bots.',
  'dm.preview.unresolved': '\nNo se han podido resolver (revisa la ortografía):\n{list}',
  'dm.preview.footer': '\nArriba está el mensaje **exacto** que recibirán. Envío: uno por segundo.',
  'dm.progress': '📨 Enviando /dm… {processed}/{total}',
  'dm.result.sent': '✅ Recibieron el mensaje: **{count}**.',
  'dm.result.dmClosed': '🔒 DMs cerrados (**{count}**): {list}',
  'dm.result.failed': '⚠️ Otros fallos de envío (**{count}**): {list}',
  'dm.result.optedOut': '🙅 Saltados por el rol de exclusión (**{count}**): {list}',
  'dm.result.bots': '🤖 Bots saltados: **{count}**.',
  'dm.result.unresolved': '❓ No se pudieron resolver (**{count}**): {list}',
  'dm.result.title': '📨 /dm enviado',
  'dm.result.sender': 'Enviado por {sender}.\n\n{summary}',

  'cmd.squads.name': 'squads',
  'cmd.squads.description': 'Administra los squads de jugadores y de gremio (solo oficiales)',
  'cmd.squads.list.description': 'Lista todos los squads con su número de miembros',
  'cmd.squads.show.description': 'Muestra los miembros de un squad',
  'cmd.squads.create.description': 'Crea un squad de jugadores vacío, o uno que sigue a un gremio de Albion entero',
  'cmd.squads.delete.description': 'Borra un squad (pide confirmación)',
  'cmd.squads.add.description': 'Añade uno o varios jugadores a un squad',
  'cmd.squads.remove.description': 'Quita un jugador de un squad',
  'cmd.squads.rename.description': 'Renombra un squad conservando sus miembros',
  'cmd.squads.move.description': 'Mueve a un jugador a otro squad',
  'cmd.squads.find.description': 'Dice en qué squad está un jugador',
  'cmd.squads.opt.squad.description': 'Squad',
  'cmd.squads.opt.currentSquad.description': 'Squad actual',
  'cmd.squads.opt.targetSquad.description': 'Squad destino',
  'cmd.squads.opt.name.description': 'Clave del squad; con is-guild, el nombre exacto del gremio de Albion',
  'cmd.squads.opt.isGuild.description': 'Sigue al gremio de Albion que se llama como el squad (por defecto: no)',
  'cmd.squads.opt.players.description': 'Nombres de jugador separados por coma',
  'cmd.squads.opt.player.description': 'Jugador',
  'cmd.squads.opt.newName.description': 'Nueva clave',
  'squads.error.title': 'No se pudo completar la operación',
  'squads.list.title': 'Squads',
  'squads.list.empty': 'Todavía no hay squads. Crea uno con `/squads create`.',
  'squads.list.playersHeader': '__Squads de jugadores__',
  'squads.list.guildsHeader': '__Gremios seguidos__',
  'squads.list.playerLine.one': '👥 **{squad}** — 1 jugador en la lista',
  'squads.list.playerLine.other': '👥 **{squad}** — {count} jugadores en la lista',
  'squads.list.guildLine': '🛡️ **{squad}** — gremio de Albion (miembros automáticos)',
  'squads.show.title': 'Squad {squad}',
  'squads.show.guild':
    '🛡️ Sigue al gremio de Albion **{guild}**.\nSus miembros se toman del gremio en cada batalla: no hay lista de nombres.',
  'squads.create.title.players': 'Squad "{squad}" creado',
  'squads.create.title.guild': 'Squad de gremio "{squad}" creado',
  'squads.create.body.players': 'Sin miembros todavía. Usa `/squads add` para añadir jugadores.',
  'squads.create.body.guild':
    'Sigue al gremio de Albion **{guild}**: en /getkills sus miembros salen del gremio, en su propia sección. ' +
    'Ojo: renombrar el squad cambia a qué gremio sigue.',
  'squads.delete.confirm': 'Confirmar borrado',
  'squads.delete.ask.guild': '¿Seguro que quieres borrar el squad de gremio **{squad}**? Dejará de seguirse en /getkills.',
  'squads.delete.ask.players.one': '¿Seguro que quieres borrar el squad **{squad}** (1 miembro)? Esta acción no se puede deshacer.',
  'squads.delete.ask.players.other':
    '¿Seguro que quieres borrar el squad **{squad}** ({count} miembros)? Esta acción no se puede deshacer.',
  'squads.delete.expired': 'Confirmación expirada. El squad no se borró.',
  'squads.delete.cancelled': 'Borrado cancelado.',
  'squads.delete.title': 'Squad "{squad}" borrado',
  'squads.delete.body.guild': 'Ya no se sigue al gremio de Albion "{guild}".',
  'squads.delete.body.players.one': 'Tenía 1 miembro.',
  'squads.delete.body.players.other': 'Tenía {count} miembros.',
  'squads.updated.title': 'Squad "{squad}" actualizado',
  'squads.add.added': 'Añadidos: {names}',
  'squads.add.already': 'Ya estaban en el squad (ignorados): {names}',
  'squads.add.crossSquad': '⚠️ {name} también está en "{other}". Si fue un error, usa `/squads move player:{name} squad:{squad}`.',
  'squads.add.noChanges': 'Sin cambios.',
  'squads.remove.body': 'Se quitó a {name}.',
  'squads.rename.confirm': 'Cambiar de gremio',
  'squads.rename.ask':
    '⚠️ **{current}** es un squad de gremio: su nombre es el gremio de Albion al que sigue. Si lo renombras a **{next}**, ' +
    'dejará de seguir a "{current}" y pasará a seguir al gremio "{next}". ¿Continuar?',
  'squads.rename.expired': 'Confirmación expirada. El squad no se renombró.',
  'squads.rename.cancelled': 'Renombrado cancelado.',
  'squads.rename.title': 'Squad renombrado',
  'squads.rename.body.guild': 'El squad de gremio "{old}" ahora es "{new}": sigue al gremio de Albion "{new}".',
  'squads.rename.body.players': '"{old}" ahora se llama "{new}".',
  'squads.move.title': 'Jugador movido',
  'squads.move.body': '{name}: "{from}" → "{to}".',
  'squads.find.found': '**{player}** está en el squad **{squad}**.',
  'squads.find.notFound': '**{player}** no está en ningún squad conocido.',
  'squads.log.title': '📝 /squads modificó squads.json',
  'squadsError.keyLength': 'La clave del squad debe tener entre 1 y {max} caracteres.',
  'squadsError.keyChars':
    'La clave del squad "{key}" solo puede contener minúsculas (a-z), números y guiones. Si es un gremio de Albion, créalo con is-guild:true.',
  'squadsError.guildNameLength': 'El nombre del gremio debe tener entre 1 y {max} caracteres.',
  'squadsError.noSquad': 'Indica un squad.',
  'squadsError.playerLength': 'El nombre de jugador "{name}" debe tener entre {min} y {max} caracteres.',
  'squadsError.guildSquad.add':
    '"{squad}" es un squad de gremio: sus miembros salen del gremio de Albion "{squad}" en cada batalla, no de una lista, ' +
    'así que no se le pueden añadir jugadores a mano. Para seguir a jugadores concretos, crea un squad de jugadores.',
  'squadsError.guildSquad.remove':
    '"{squad}" es un squad de gremio: sus miembros salen del gremio de Albion "{squad}" en cada batalla, no de una lista, ' +
    'así que no se le pueden quitar jugadores a mano. Para seguir a jugadores concretos, crea un squad de jugadores.',
  'squadsError.guildSquad.move':
    '"{squad}" es un squad de gremio: sus miembros salen del gremio de Albion "{squad}" en cada batalla, no de una lista, ' +
    'así que no se pueden mover jugadores a él. Para seguir a jugadores concretos, crea un squad de jugadores.',
  'squadsError.mainGuild':
    '"{guild}" es el gremio principal de este servidor: ya cuenta como MAIN ZERG. Un squad de gremio con ese nombre duplicaría a todo el mundo.',
  'squadsError.exists.players': 'Ya existe un squad de jugadores llamado "{squad}".',
  'squadsError.exists.guild': 'Ya existe un squad de gremio llamado "{squad}".',
  'squadsError.existsAny': 'Ya existe un squad llamado "{squad}".',
  'squadsError.notFound': 'El squad "{squad}" no existe.',
  'squadsError.notFoundCreate': 'El squad "{squad}" no existe. Créalo antes con /squads create.',
  'squadsError.noPlayers': 'Debes indicar al menos un nombre de jugador.',
  'squadsError.notInSquad': '"{player}" no está en el squad "{squad}".',
  'squadsError.changed': 'El squad "{squad}" cambió mientras tanto. Vuelve a intentarlo.',
  'squadsError.playerNoSquad': '"{player}" no está en ningún squad. Usa /squads add para añadirlo.',
  'squadsError.alreadyIn': '"{player}" ya está en "{squad}".',

  'cmd.config.description': 'Configura el bot en este servidor (solo administradores)',
  'cmd.config.view.description': 'Muestra la configuración actual y lo que falta',
  'cmd.config.officer.description': 'Rol de oficiales: puede usar /squads, /sorteo, /crear-rol y /estado',
  'cmd.config.logs.description': 'Canal donde el bot deja constancia de cambios y errores',
  'cmd.config.raffleRole.description': 'Rol al que /sorteo menciona al anunciar un sorteo (opcional)',
  'cmd.config.dmOptout.description': 'Rol cuyos miembros no reciben /dm (opcional)',
  'cmd.config.server.description': 'Servidor de Albion del gremio',
  'cmd.config.guild.description': 'Gremio principal de Albion (uno solo; los demás, con /squads create)',
  'cmd.config.albionbb.description': 'Id del gremio en albionbb, para /asistencia',
  'cmd.config.language.description': 'Idioma de los mensajes que ve todo el servidor',
  'cmd.config.reset.description': 'Vuelve un ajuste a su valor por defecto',
  'cmd.config.opt.role.officer': 'Rol de oficiales',
  'cmd.config.opt.role.raffle': 'Rol a mencionar',
  'cmd.config.opt.role.dmOptout': 'Rol de exclusión',
  'cmd.config.opt.channel.description': 'Canal de texto',
  'cmd.config.opt.name.description': 'Nombre exacto del gremio en Albion',
  'cmd.config.opt.value.server': 'Servidor de Albion',
  'cmd.config.opt.value.albionbb': 'Id del gremio (o la URL de su página en albionbb)',
  'cmd.config.opt.value.language': 'Idioma',
  'cmd.config.opt.field.description': 'Ajuste a resetear',
  'config.noAdmin': 'Este comando es solo para quien tiene el permiso de Administrador en este servidor.',
  'config.rejected.title': 'No se ha cambiado nada',
  'config.unchanged.title': 'No ha cambiado nada',
  'config.unchanged.body': '{label}: ya era {value}.',
  'config.view.title': '⚙️ Configuración de este servidor',
  'config.view.fieldName': '{label} · /config {sub}',
  'config.view.missingRequired': '❌ **sin configurar**',
  'config.view.missingOptional': '➖ sin configurar (opcional)',
  'config.view.brokenRole': '⚠️ El rol configurado (`{id}`) ya no existe',
  'config.view.brokenChannel': '⚠️ El canal configurado (`{id}`) ya no existe',
  'config.view.gapsTitle': 'Qué no funciona todavía',
  'config.view.statusTitle': 'Estado',
  'config.view.allSet': '✅ Todo configurado: todos los comandos funcionan.',
  'config.view.lastChange': 'Último cambio {when} por {who}.',
  'config.view.lastChangeNoActor': 'Último cambio {when}.',
  'config.view.neverConfigured': 'Nadie ha configurado este servidor todavía. Empieza por `/config officer` y `/config guild`.',
  'config.change.before': '**Antes:** {value}',
  'config.change.after': '**Ahora:** {value}',
  'config.change.pending': 'Todavía falta: {subs}. Mira `/config view`.',
  'config.change.complete': '✅ Ya no falta nada obligatorio.',
  'config.field.officerRoleId.label': 'Rol de oficiales',
  'config.field.officerRoleId.missing':
    'Este servidor no tiene rol de oficiales configurado. Un administrador puede ponerlo con `/config officer`.',
  'config.field.officerRoleId.gap': '🚫 {commands} no funcionan: falta el rol de oficiales → `/config officer`',
  'config.field.logChannelId.label': 'Canal de logs',
  'config.field.logChannelId.missing':
    'Este servidor no tiene canal de logs configurado. Un administrador puede ponerlo con `/config logs`.',
  'config.field.logChannelId.gap':
    '⚠️ Los cambios (/squads, /config, /crear-rol, /dm) y los errores no quedan registrados en ningún sitio → `/config logs`',
  'config.field.raffleRoleId.label': 'Rol a avisar en sorteos',
  'config.field.raffleRoleId.missing':
    'Este servidor no tiene rol de sorteos configurado. Un administrador puede ponerlo con `/config raffle-role`.',
  'config.field.raffleRoleId.gap': 'ℹ️ /sorteo funciona, pero no menciona a ningún rol al anunciarse → `/config raffle-role`',
  'config.field.dmOptoutRoleId.label': 'Rol que no recibe /dm',
  'config.field.dmOptoutRoleId.missing':
    'Este servidor no tiene rol de exclusión de /dm configurado. Un administrador puede ponerlo con `/config dm-optout`.',
  'config.field.dmOptoutRoleId.gap': 'ℹ️ /dm funciona, pero nadie puede excluirse de recibirlos → `/config dm-optout`',
  'config.field.albionServer.label': 'Servidor de Albion',
  'config.field.albionServer.missing':
    'Este servidor no tiene servidor de Albion configurado. Un administrador puede ponerlo con `/config server`.',
  'config.field.albionServer.gap': '🚫 /getkills y /asistencia necesitan un servidor de Albion → `/config server`',
  'config.field.albionGuild.label': 'Gremio de Albion',
  'config.field.albionGuild.missing':
    'Este servidor no tiene gremio de Albion configurado. Un administrador puede ponerlo con `/config guild`.',
  'config.field.albionGuild.gap': '🚫 {commands} no funciona: falta el gremio de Albion → `/config guild`',
  'config.field.albionbbGuildId.label': 'Id del gremio en albionbb',
  'config.field.albionbbGuildId.missing':
    'Este servidor no tiene configurado el id de su gremio en albionbb. Un administrador puede ponerlo con `/config albionbb`.',
  'config.field.albionbbGuildId.gap': '🚫 {commands} no funciona: falta el id de albionbb → `/config albionbb`',
  'config.field.idioma.label': 'Idioma',
  'config.field.idioma.missing':
    'Este servidor no tiene idioma configurado. Un administrador puede ponerlo con `/config language`.',
  'config.field.idioma.gap': 'ℹ️ Los mensajes públicos salen en inglés hasta que se elija un idioma → `/config language`',
  'config.error.everyone.officer': '@everyone no puede ser el rol de oficiales: elige un rol concreto.',
  'config.error.everyone.raffle': '@everyone no puede ser el rol de sorteos: elige un rol concreto.',
  'config.error.everyone.dmOptout': '@everyone no puede ser el rol de exclusión de /dm: elige un rol concreto.',
  'config.error.managedRole':
    '{role} lo gestiona una integración (un bot o una suscripción): no se le puede dar a nadie a mano. Elige otro rol.',
  'config.error.logChannelType': 'El canal de logs tiene que ser un canal de texto (o de anuncios) de este servidor.',
  'config.error.logChannelPerms':
    'No puedo escribir en <#{channel}>: me falta {permissions} en ese canal. Dame esos permisos y vuelve a intentarlo.',
  'config.perm.viewChannel': '**Ver canal**',
  'config.perm.sendMessages': '**Enviar mensajes**',
  'config.perm.embedLinks': '**Insertar enlaces**',
  'config.perm.attachFiles': '**Adjuntar archivos**',
  'config.error.server': 'El servidor de Albion tiene que ser uno de: {servers}.',
  'config.note.serverAlbionbb':
    'El id de albionbb es de un servidor concreto: si el gremio no está en este, cámbialo con `/config albionbb`.',
  'config.error.guildComma':
    '`/config guild` acepta un solo gremio: el principal. Los demás se siguen como squads de gremio, uno a uno, ' +
    'con `/squads create name:<gremio> is-guild:true`.',
  'config.error.guildLength': 'El nombre del gremio tiene que tener entre 1 y {max} caracteres.',
  'config.error.guildClash':
    'Ya hay un squad de gremio que sigue a **{guild}**. Como gremio principal contaría a todos dos veces: bórralo antes con `/squads delete`.',
  'config.note.guildExact': 'Tiene que coincidir exactamente con el nombre del gremio en Albion, mayúsculas y espacios incluidos.',
  'config.error.albionbbFormat':
    'Eso no parece un id de albionbb. Sale en la URL de la página del gremio: ' +
    '`https://europe.albionbb.com/guilds/<id>/...`. También puedes pegar la URL entera.',
  'config.error.albionbbNotFound':
    'albionbb no tiene ningún gremio con id `{id}` en el servidor **{server}**. Revisa el id o, si el gremio es de otro ' +
    'servidor, cámbialo antes con `/config server`.',
  'config.note.albionbbUnreachable': '⚠️ albionbb no responde ahora mismo: no he podido comprobar el id, se guarda igualmente.',
  'config.error.language': 'El idioma tiene que ser uno de: {languages}.',
  'config.log.title': '⚙️ /config cambió la configuración',

  'log.field.officer': 'Oficial',
  'log.field.subcommand': 'Subcomando',
  'log.field.role': 'Rol',
  'log.field.command': 'Comando',
  'log.field.user': 'Usuario',
  'log.field.message': 'Mensaje',
  'log.field.sender': 'Remitente',
  'log.field.recipients': 'Destinatarios',
  'log.field.id': 'ID',
  'log.field.setting': 'Ajuste',
  'log.field.admin': 'Administrador',
  'log.field.before': 'Antes',
  'log.field.after': 'Ahora',
  'log.roleCreated.title': '🆕 /crear-rol creó un rol',
  'log.error.title': '💥 Error no controlado',
  'log.dmUnauthorized.title': '🚫 Intento de /dm sin permiso',
  'log.dmUnauthorized.body': '<@{user}> intentó usar /dm y no es DM_OWNER_ID. No se envió nada.',
  'log.dmStarted.title': '📨 /dm: envío iniciado',
  'log.dmStarted.attached': 'El texto no cabe en un embed: va adjunto como fichero.',
  'log.dmFinished.title': '📨 /dm: envío terminado',
  'log.dmInterrupted.title': '⚠️ /dm interrumpido por un reinicio',
  'log.dmInterrupted.body':
    'Un /dm de **{actor}** iniciado <t:{started}:f> se cortó a mitad: se habían enviado **{sent}** de {total}. ' +
    '**No se ha reanudado.** Decide a mano si hace falta mandarlo al resto.',

  'welcome.new':
    '👋 ¡Hola! Todavía no estoy configurado en este servidor.\n' +
    'Un administrador tiene que ejecutar `/config view`: enseña qué falta y con qué comando se pone.\n' +
    'Hasta entonces, cada comando que necesite algo sin configurar dirá qué le falta.',
  'welcome.back':
    '👋 He vuelto con la configuración y los squads que tenía este servidor.\nUn administrador puede revisarlos con `/config view`.',
};

export const TABLES = { en, es };

const warned = new Set();
function warnOnce(message) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

/**
 * El texto de `key` en `lang`, con los {marcadores} sustituidos por `values`.
 * Si falta en ese idioma, cae al inglés (y lo deja en el log). Si tampoco
 * existe en inglés, devuelve un texto genérico: la clave cruda nunca llega
 * al usuario.
 * @param {string} key
 * @param {string} [lang]
 * @param {Record<string, string | number>} [values]
 */
export function t(key, lang = DEFAULT_LANGUAGE, values = {}) {
  let template = TABLES[lang]?.[key];
  if (template === undefined) {
    if (lang !== DEFAULT_LANGUAGE) warnOnce(`[i18n] Falta la clave "${key}" en "${lang}": se usa el inglés.`);
    template = en[key];
  }
  if (template === undefined) {
    warnOnce(`[i18n] La clave "${key}" no existe en ningún idioma.`);
    return en['common.textUnavailable'];
  }
  return template.replace(/\{(\w+)\}/g, (marker, name) => {
    if (name in values) return String(values[name]);
    warnOnce(`[i18n] Falta el valor {${name}} para la clave "${key}".`);
    return marker;
  });
}

/**
 * Plural: usa `key.one` si count es 1 y `key.other` si no. `count` llega
 * también como valor {count}.
 * @param {string} key
 * @param {number} count
 * @param {string} [lang]
 * @param {Record<string, string | number>} [values]
 */
export function tn(key, count, lang = DEFAULT_LANGUAGE, values = {}) {
  return t(`${key}.${count === 1 ? 'one' : 'other'}`, lang, { count, ...values });
}

/**
 * Locale de Discord ("es-ES", "es-419", "en-US"...) -> idioma del bot.
 * @param {string | null | undefined} locale
 */
export function langFromLocale(locale) {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('es') ? 'es' : DEFAULT_LANGUAGE;
}

/**
 * Idioma para una respuesta EFÍMERA: el del cliente de quien la provocó.
 * @param {{ locale?: string }} interaction
 */
export function userLang(interaction) {
  return langFromLocale(interaction?.locale);
}

/**
 * Idioma para un mensaje PÚBLICO: el del servidor ("idioma" en su
 * config.json). Sin servidor o sin idioma configurado, inglés.
 * @param {string | null | undefined} guildId
 */
export async function guildLang(guildId) {
  if (!guildId) return DEFAULT_LANGUAGE;
  const { idioma } = await getConfig(guildId);
  return LANGUAGES.has(idioma) ? idioma : DEFAULT_LANGUAGE;
}

/**
 * Idioma de una respuesta que ya puede ser pública o efímera: si la
 * interacción se difirió o respondió de forma PÚBLICA, la ve el servidor;
 * si no, solo quien la provocó.
 * @param {import('discord.js').Interaction} interaction
 */
export async function replyLang(interaction) {
  const isPublic = (interaction.deferred || interaction.replied) && interaction.ephemeral === false;
  return isPublic ? guildLang(interaction.guildId) : userLang(interaction);
}

// --- localización de comandos (setNameLocalizations / setDescriptionLocalizations) ---

/**
 * { 'es-ES': ..., 'es-419': ... } con el texto en español de `key`.
 * @param {string} key
 */
export function localizations(key) {
  return Object.fromEntries(SPANISH_LOCALES.map((locale) => [locale, t(key, 'es')]));
}

/**
 * Nombre en inglés + su nombre en español para los clientes en español.
 * Solo para los comandos de uso general: /squads y /config tienen un único
 * nombre (en inglés) y no pasan por aquí.
 * @template B
 * @param {B} builder - cualquier builder con setName / setNameLocalizations
 * @param {string} key - "cmd.raffle.name" -> "raffle" / "sorteo"
 * @returns {B}
 */
export function localizedName(builder, key) {
  return builder.setName(t(key, 'en')).setNameLocalizations(localizations(key));
}

/**
 * Descripción en inglés + su traducción. Se usa en TODOS los comandos,
 * también en /squads y /config: la descripción no cambia lo que se teclea.
 * @template B
 * @param {B} builder
 * @param {string} key
 * @returns {B}
 */
export function localizedDescription(builder, key) {
  return builder.setDescription(t(key, 'en')).setDescriptionLocalizations(localizations(key));
}

/**
 * Choice con el nombre visible localizado. El VALOR no se toca nunca: es lo
 * que recibe el código.
 * @param {string} key
 * @param {string | number} value
 */
export function localizedChoice(key, value) {
  return { name: t(key, 'en'), name_localizations: localizations(key), value };
}

/**
 * "/raffle" o "/sorteo": el nombre de un comando tal y como lo teclea quien
 * lee en `lang`.
 * @param {string} commandKey - "raffle", "createRole"...
 * @param {string} lang
 */
export function commandName(commandKey, lang) {
  return `/${t(`cmd.${commandKey}.name`, lang)}`;
}

/**
 * Error con un texto para el usuario que se traduce al idioma de quien lo
 * vaya a leer. `message` lleva la versión inglesa, para el log.
 */
export class LocalizedError extends Error {
  /**
   * @param {string} key
   * @param {Record<string, string | number>} [values]
   */
  constructor(key, values = {}) {
    super(t(key, DEFAULT_LANGUAGE, values));
    this.key = key;
    this.values = values;
  }

  /** @param {string} lang */
  localized(lang) {
    return t(this.key, lang, this.values);
  }
}
