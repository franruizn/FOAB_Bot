/**
 * Agrega los eventos de una batalla en buckets, detecta la alianza amiga y
 * cuenta enemigos únicos.
 *
 * Dos secciones que NO se mezclan:
 *   - Gremio principal (albionGuild del servidor): MAIN ZERG + squads de
 *     JUGADORES. Invariante:
 *       kills(MAIN ZERG) + suma(squads de jugadores) == totals.kills
 *     (y lo mismo con deaths).
 *   - Gremios seguidos (squads con isGuild): cada uno sobre su propio gremio,
 *     con su propio subtotal en followedTotals. NO entran en totals: esos
 *     jugadores no son del gremio principal y lo inflarían.
 * combinedTotals es la suma de las dos, para quien quiera el conjunto.
 *
 * Dos fuentes con papeles distintos: los resúmenes (`battles`) dicen QUIÉN
 * estuvo presente; los eventos (`events`) dicen cuántas kills/deaths tiene
 * cada uno. Un healer con 0 kills y 0 deaths no sale en ningún evento, pero sí
 * en el resumen.
 *
 * @param {object} params
 * @param {object[]} params.events - eventos de kill devueltos por albionApi.getBattleEvents
 * @param {object[]} [params.battles=[]] - resúmenes devueltos por albionApi.getBattle,
 *   uno por batalla. Un jugador presente en varias cuenta una sola vez.
 * @param {import('./config.js').ConfigData} params.config - config cargada por config.loadConfig
 * @param {string} params.mainGuild - gremio principal del servidor (albionGuild)
 * @param {boolean} [params.countAssists=false] - ver nota junto al bucle principal
 * @returns {{
 *   alliance: string,
 *   buckets: Array<Bucket>,
 *   guildBuckets: Array<Bucket>,
 *   totals: { kills: number, deaths: number, uniquePlayers: number, uniqueEnemies: number },
 *   followedTotals: { kills: number, deaths: number, uniquePlayers: number },
 *   combinedTotals: { kills: number, deaths: number, uniquePlayers: number },
 *   warnings: string[],
 * }}
 * @typedef {{ key: string, display: string, isGuild: boolean, kills: number, deaths: number, players: Array<{name: string, kills: number, deaths: number}> }} Bucket
 */
export function aggregateBattle({ events, battles = [], config, mainGuild, countAssists = false }) {
  const { squadOrder, squads, playerToSquad, guildToSquad, warnings: configWarnings = [] } = config;
  const warnings = [...configWarnings];
  const mainKey = (mainGuild ?? '').toLowerCase();

  // Un squad de gremio que apunte al gremio principal duplicaría a todo el
  // mundo (ya es MAIN ZERG): se ignora y se avisa. /squads create ya lo
  // impide; esto cubre un squads.json editado a mano o un albionGuild
  // cambiado después.
  const followedSquadKeys = squadOrder.filter((key) => squads.get(key).isGuild && key !== mainKey);
  if (mainKey && guildToSquad.has(mainKey)) {
    warnings.push(`El squad de gremio "${squads.get(mainKey).display}" es el gremio principal: se ignora (ya es MAIN ZERG).`);
  }
  const followedGuildKeys = new Set(followedSquadKeys.map((key) => squads.get(key).guildName.toLowerCase()));

  const isMainGuild = (guildName) => Boolean(mainKey) && (guildName ?? '').toLowerCase() === mainKey;
  // Igualdad exacta en minúsculas, nunca includes(): "Dementia" no debe
  // recoger a "Dementia Two".
  const followedSquadOf = (guildName) => {
    const guildKey = (guildName ?? '').toLowerCase();
    return guildKey && followedGuildKeys.has(guildKey) ? guildToSquad.get(guildKey) : null;
  };

  const warnedConflicts = new Set();

  /**
   * Bucket al que va un jugador, o null si no se cuenta (ni del gremio
   * principal ni de uno seguido).
   */
  const resolveSquadKey = (player) => {
    const nameKey = player.Name.toLowerCase();
    const playerSquad = playerToSquad.get(nameKey);
    if (isMainGuild(player.GuildName)) return playerSquad ?? 'main';

    const followedSquad = followedSquadOf(player.GuildName);
    if (!followedSquad) return null;
    if (playerSquad) {
      // Gana el squad de jugadores: alguien lo puso ahí a propósito.
      if (!warnedConflicts.has(nameKey)) {
        warnedConflicts.add(nameKey);
        warnings.push(
          `"${player.Name}" está en el squad de jugadores "${squads.get(playerSquad).display}" y es del gremio ` +
            `seguido "${squads.get(followedSquad).display}": cuenta en "${squads.get(playerSquad).display}".`,
        );
      }
      return playerSquad;
    }
    return followedSquad;
  };

  // Registro de todo jugador visto en la batalla (participantes del resumen +
  // Killer + Victim + Participants de cada evento), usado para detectar la alianza amiga y contar enemigos
  // únicos. GroupMembers queda fuera a propósito: son compañeros de party que
  // pueden no haber participado realmente en ningún combate de esta batalla.
  const allPlayers = new Map(); // nameLower -> { name, guildName, allianceName }

  const registerPlayer = (player) => {
    if (!player) return;
    const key = player.Name.toLowerCase();
    if (!allPlayers.has(key)) {
      allPlayers.set(key, {
        name: player.Name,
        guildName: player.GuildName ?? '',
        allianceName: player.AllianceName ?? '',
      });
    }
  };

  // Jugadores contados (de cualquiera de las dos secciones) presentes en la
  // batalla: los que figuran en el resumen (aunque tengan 0 kills y 0
  // deaths) más los que tienen un kill/death acreditado en los eventos.
  const playerRecords = new Map(); // nameLower -> { name, kills, deaths, squadKey }

  /** Record del jugador, o null si no se cuenta. El bucket se decide la primera vez que se le ve. */
  const getOrCreateRecord = (player) => {
    const key = player.Name.toLowerCase();
    let record = playerRecords.get(key);
    if (!record) {
      const squadKey = resolveSquadKey(player);
      if (!squadKey) return null;
      record = { name: player.Name, kills: 0, deaths: 0, squadKey };
      playerRecords.set(key, record);
    }
    return record;
  };

  // Presencia: el resumen lista a todos los participantes. Solo crea el
  // record (en 0/0); las kills/deaths del resumen se ignoran a propósito para
  // que las cifras sigan saliendo de una única fuente, los eventos.
  for (const battle of battles) {
    for (const participant of Object.values(battle?.players ?? {})) {
      if (!participant?.name) continue;
      const player = { Name: participant.name, GuildName: participant.guildName, AllianceName: participant.allianceName };
      // Todos, amigos y enemigos, cuentan como vistos: un enemigo con 0 kills
      // y 0 deaths también es un enemigo único.
      registerPlayer(player);
      getOrCreateRecord(player);
    }
  }

  for (const event of events) {
    const killer = event.Killer;
    const victim = event.Victim;
    const participants = event.Participants ?? [];

    registerPlayer(killer);
    registerPlayer(victim);
    for (const participant of participants) registerPlayer(participant);

    // Un evento = una muerte: el Victim siempre acredita 1 death si se cuenta.
    if (victim) {
      const record = getOrCreateRecord(victim);
      if (record) record.deaths += 1;
    }

    if (countAssists) {
      // countAssists=true: cada Participant de este kill recibe 1 kill de
      // asistencia, no solo el Killer. La API incluye al propio Killer dentro
      // de Participants (confirmado contra /events/battle/418186013), así que
      // no hace falta acreditarlo por separado.
      const creditedThisEvent = new Set();
      for (const participant of participants) {
        const key = participant.Name.toLowerCase();
        if (creditedThisEvent.has(key)) continue;
        creditedThisEvent.add(key);
        const record = getOrCreateRecord(participant);
        if (record) record.kills += 1;
      }
    } else if (killer) {
      // countAssists=false (default, decisión de diseño): solo el Killer se
      // lleva el kill, igual que la fama "oficial" del evento. Acreditar
      // también a los Participants inflaría las kills por encima de las
      // muertes realmente causadas y rompería el invariante de arriba.
      const record = getOrCreateRecord(killer);
      if (record) record.kills += 1;
    }
  }

  // Alianza amiga = la más frecuente entre los jugadores del gremio
  // principal vistos en la batalla. No se hardcodea. En caso de empate gana
  // la primera alianza encontrada en orden de aparición (determinista, no
  // arbitrario).
  const allianceTally = new Map(); // allianceLower -> { display, count }
  for (const info of allPlayers.values()) {
    if (!isMainGuild(info.guildName)) continue;
    const key = info.allianceName.toLowerCase();
    const entry = allianceTally.get(key) ?? { display: info.allianceName, count: 0 };
    entry.count += 1;
    allianceTally.set(key, entry);
  }

  let alliance = '';
  let bestCount = -1;
  for (const entry of allianceTally.values()) {
    if (entry.count > bestCount) {
      bestCount = entry.count;
      alliance = entry.display;
    }
  }

  // uniqueEnemies: jugador visto cuya alianza no es la amiga detectada
  // (comparación exacta, case-insensitive) Y que tampoco es de un gremio
  // seguido: los aliados que sigues no son rivales.
  const friendlyAllianceKey = alliance.toLowerCase();
  let uniqueEnemies = 0;
  for (const info of allPlayers.values()) {
    if (info.allianceName.toLowerCase() === friendlyAllianceKey) continue;
    if (followedSquadOf(info.guildName)) continue;
    uniqueEnemies += 1;
  }

  // Buckets en el orden del fichero. Se incluyen TODOS los squads aunque no
  // tengan a nadie presente en esta batalla (kills/deaths en 0, players
  // vacío). Un squad de jugadores sin miembros es eso, un squad vacío: nunca
  // recoge a nadie por gremio.
  const makeBucket = (key, display, isGuild) => ({ key, display, isGuild, kills: 0, deaths: 0, players: [] });
  const bucketMap = new Map([['main', makeBucket('main', 'MAIN ZERG', false)]]);
  const playerSquadKeys = squadOrder.filter((key) => !squads.get(key).isGuild);
  for (const key of playerSquadKeys) bucketMap.set(key, makeBucket(key, squads.get(key).display, false));
  for (const key of followedSquadKeys) bucketMap.set(key, makeBucket(key, squads.get(key).display, true));

  for (const record of playerRecords.values()) {
    const bucket = bucketMap.get(record.squadKey);
    bucket.kills += record.kills;
    bucket.deaths += record.deaths;
    bucket.players.push({ name: record.name, kills: record.kills, deaths: record.deaths });
  }

  const buckets = ['main', ...playerSquadKeys].map((key) => bucketMap.get(key));
  const guildBuckets = followedSquadKeys.map((key) => bucketMap.get(key));

  const sumBuckets = (list) =>
    list.reduce(
      (acc, bucket) => {
        acc.kills += bucket.kills;
        acc.deaths += bucket.deaths;
        acc.uniquePlayers += bucket.players.length;
        return acc;
      },
      { kills: 0, deaths: 0, uniquePlayers: 0 },
    );

  const mainTotals = sumBuckets(buckets);
  const followedTotals = sumBuckets(guildBuckets);
  const combinedTotals = {
    kills: mainTotals.kills + followedTotals.kills,
    deaths: mainTotals.deaths + followedTotals.deaths,
    uniquePlayers: mainTotals.uniquePlayers + followedTotals.uniquePlayers,
  };

  return {
    alliance,
    buckets,
    guildBuckets,
    totals: { ...mainTotals, uniqueEnemies },
    followedTotals,
    combinedTotals,
    warnings,
  };
}
