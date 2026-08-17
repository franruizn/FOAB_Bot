/**
 * Agrega los eventos de una batalla en buckets (MAIN ZERG + squads), detecta
 * la alianza amiga y cuenta enemigos únicos.
 *
 * @param {object} params
 * @param {object[]} params.events - eventos de kill devueltos por albionApi.getBattleEvents
 * @param {import('./config.js').ConfigData} params.config - config cargada por config.loadConfig
 * @param {boolean} [params.countAssists=false] - ver nota junto al bucle principal
 * @returns {{
 *   alliance: string,
 *   buckets: Array<{ key: string, display: string, kills: number, deaths: number, players: Array<{name: string, kills: number, deaths: number}> }>,
 *   totals: { kills: number, deaths: number, uniquePlayers: number, uniqueEnemies: number },
 *   warnings: string[],
 * }}
 */
export function aggregateBattle({ events, config, countAssists = false }) {
  const { guilds, squadOrder, squads, playerToSquad, warnings = [] } = config;

  const isTrackedGuild = (guildName) => Boolean(guildName) && guilds.has(guildName.toLowerCase());

  // Registro de todo jugador visto en la batalla (Killer + Victim + Participants
  // de cada evento), usado para detectar la alianza amiga y contar enemigos
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

  // Jugadores de nuestro gremio con kills/deaths acreditados. Solo estos
  // entran en los buckets: un jugador que solo aparece como Participant sin
  // recibir nunca un kill/death no aporta nada a un reporte de kills/deaths.
  const playerRecords = new Map(); // nameLower -> { name, kills, deaths, squadKey }

  const getOrCreateRecord = (player) => {
    const key = player.Name.toLowerCase();
    let record = playerRecords.get(key);
    if (!record) {
      // playerToSquad ya resuelve "primer squad según squadOrder" cuando un
      // jugador está duplicado entre squads (ver config.loadConfig); aquí
      // solo consumimos esa decisión.
      record = {
        name: player.Name,
        kills: 0,
        deaths: 0,
        squadKey: playerToSquad.get(key) ?? 'main',
      };
      playerRecords.set(key, record);
    }
    return record;
  };

  for (const event of events) {
    const killer = event.Killer;
    const victim = event.Victim;
    const participants = event.Participants ?? [];

    registerPlayer(killer);
    registerPlayer(victim);
    for (const participant of participants) registerPlayer(participant);

    // Un evento = una muerte: el Victim siempre acredita 1 death si es de
    // nuestro gremio.
    if (isTrackedGuild(victim?.GuildName)) {
      getOrCreateRecord(victim).deaths += 1;
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
        if (isTrackedGuild(participant.GuildName)) {
          getOrCreateRecord(participant).kills += 1;
        }
      }
    } else if (isTrackedGuild(killer?.GuildName)) {
      // countAssists=false (default, decisión de diseño): solo el Killer se
      // lleva el kill, igual que la fama "oficial" del evento. Acreditar
      // también a los Participants inflaría las kills por encima de las
      // muertes realmente causadas y rompería el invariante
      // kills(MAIN ZERG) + suma(kills de squads) = kills totales del gremio.
      getOrCreateRecord(killer).kills += 1;
    }
  }

  // Alianza amiga = la más frecuente entre los jugadores de nuestro gremio
  // vistos en la batalla. No se hardcodea. En caso de empate gana la primera
  // alianza encontrada en orden de aparición (determinista, no arbitrario).
  const allianceTally = new Map(); // allianceLower -> { display, count }
  for (const info of allPlayers.values()) {
    if (!isTrackedGuild(info.guildName)) continue;
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

  // uniqueEnemies: cualquier jugador visto en la batalla cuya alianza no
  // coincide con la alianza amiga detectada (comparación exacta, case-insensitive).
  const friendlyAllianceKey = alliance.toLowerCase();
  let uniqueEnemies = 0;
  for (const info of allPlayers.values()) {
    if (info.allianceName.toLowerCase() !== friendlyAllianceKey) {
      uniqueEnemies += 1;
    }
  }

  // Buckets: MAIN ZERG primero, luego cada squad en el orden del fichero.
  // Se incluyen TODOS los squads de squadOrder aunque no tengan jugadores
  // acreditados en esta batalla (kills/deaths en 0, players vacío).
  const bucketMap = new Map();
  bucketMap.set('main', { key: 'main', display: 'MAIN ZERG', kills: 0, deaths: 0, players: [] });
  for (const squadKey of squadOrder) {
    const squad = squads.get(squadKey);
    bucketMap.set(squadKey, { key: squadKey, display: squad.display, kills: 0, deaths: 0, players: [] });
  }

  for (const record of playerRecords.values()) {
    const bucket = bucketMap.get(record.squadKey) ?? bucketMap.get('main');
    bucket.kills += record.kills;
    bucket.deaths += record.deaths;
    bucket.players.push({ name: record.name, kills: record.kills, deaths: record.deaths });
  }

  const buckets = ['main', ...squadOrder].map((key) => bucketMap.get(key));

  const totals = buckets.reduce(
    (acc, bucket) => {
      acc.kills += bucket.kills;
      acc.deaths += bucket.deaths;
      return acc;
    },
    { kills: 0, deaths: 0, uniquePlayers: playerRecords.size, uniqueEnemies },
  );

  return { alliance, buckets, totals, warnings: [...warnings] };
}
