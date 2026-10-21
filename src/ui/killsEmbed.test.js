import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKillsEmbed } from './killsEmbed.js';

function build(buckets, totals) {
  return buildKillsEmbed({
    result: { alliance: 'FRIEND', buckets, totals, warnings: [] },
    battlesProcessed: 1,
    battlesRequested: 1,
    mainGuildDisplay: 'foab',
    originalUrl: 'https://europe.albionbb.com/battles/1',
    battleDate: new Date(0),
  });
}

function fieldValue(embeds, name) {
  return embeds.flatMap((embed) => embed.data.fields ?? []).find((field) => field.name === name)?.value;
}

test('un squad lista también a los presentes con 0 kills, ordenados al final', () => {
  const embeds = build(
    [
      { key: 'main', display: 'MAIN ZERG', kills: 0, deaths: 0, players: [] },
      {
        key: 'raf',
        display: 'RAF',
        kills: 3,
        deaths: 1,
        players: [
          { name: 'Aaa', kills: 0, deaths: 0 },
          { name: 'Killer', kills: 3, deaths: 0 },
          { name: 'Zzz', kills: 0, deaths: 1 },
        ],
      },
    ],
    { kills: 3, deaths: 1, uniquePlayers: 3, uniqueEnemies: 5 },
  );

  const value = fieldValue(embeds, 'RAF');
  assert.match(value, /Pax: 3/);
  assert.ok(value.endsWith('Killer (3)\nAaa (0)\nZzz (0)'), value);
});

test('un squad cuyos presentes no tienen ni kills ni deaths aparece con su roster', () => {
  const embeds = build(
    [
      { key: 'main', display: 'MAIN ZERG', kills: 2, deaths: 0, players: [{ name: 'Main', kills: 2, deaths: 0 }] },
      { key: 'heal', display: 'HEAL', kills: 0, deaths: 0, players: [{ name: 'Healer', kills: 0, deaths: 0 }] },
    ],
    { kills: 2, deaths: 0, uniquePlayers: 2, uniqueEnemies: 5 },
  );

  const value = fieldValue(embeds, 'HEAL');
  assert.match(value, /K-D: \*\*0 - 0\*\* Pax: 1/);
  assert.match(value, /Healer \(0\)/);
  assert.match(embeds[0].data.description, /Unique counted players \(foab\): 2/);
});

test('gremios seguidos: sección propia con subtotal, fuera del TOTAL, y el conjunto en una línea aparte', () => {
  const embeds = buildKillsEmbed({
    result: {
      alliance: 'FRIEND',
      buckets: [{ key: 'main', display: 'MAIN ZERG', isGuild: false, kills: 4, deaths: 1, players: [{ name: 'Main', kills: 4, deaths: 1 }] }],
      guildBuckets: [
        {
          key: 'los bombas',
          display: 'Los Bombas',
          isGuild: true,
          kills: 6,
          deaths: 2,
          players: [
            { name: 'B1', kills: 6, deaths: 0 },
            { name: 'B2', kills: 0, deaths: 2 },
          ],
        },
      ],
      totals: { kills: 4, deaths: 1, uniquePlayers: 1, uniqueEnemies: 7 },
      followedTotals: { kills: 6, deaths: 2, uniquePlayers: 2 },
      combinedTotals: { kills: 10, deaths: 3, uniquePlayers: 3 },
      warnings: [],
    },
    battlesProcessed: 1,
    battlesRequested: 1,
    mainGuildDisplay: 'FOAB',
    originalUrl: 'https://europe.albionbb.com/battles/1',
    battleDate: new Date(0),
  });

  const description = embeds[0].data.description;
  assert.match(description, /\*\*TOTAL FOAB\*\*\nK-D: 4 - 1/, 'el TOTAL es solo del gremio principal');
  assert.match(description, /Unique counted players \(FOAB\): 1/);
  assert.match(description, /Unique counted players \(followed guilds\): 2/);
  assert.match(description, /\*\*FOLLOWED GUILDS \(subtotal\)\*\*\nK-D: 6 - 2/);
  assert.match(description, /\*\*COMBINED \(FOAB \+ followed guilds\)\*\*\nK-D: 10 - 3/);

  const names = embeds.flatMap((embed) => embed.data.fields ?? []).map((field) => field.name);
  assert.deepEqual(names, ['MAIN ZERG', '🤝 Followed guilds', '🛡️ Los Bombas'], 'el gremio seguido va después, en su sección');
  // Porcentaje sobre el subtotal de SU sección (6 de 6), no sobre el TOTAL del principal.
  assert.match(fieldValue(embeds, '🛡️ Los Bombas'), /^\*\*6\*\* \(100\.0%\)/);
});

test('sin gremios seguidos, el embed no muestra la sección ni la línea conjunta', () => {
  const embeds = build(
    [{ key: 'main', display: 'MAIN ZERG', kills: 1, deaths: 0, players: [{ name: 'Main', kills: 1, deaths: 0 }] }],
    { kills: 1, deaths: 0, uniquePlayers: 1, uniqueEnemies: 2 },
  );
  assert.doesNotMatch(embeds[0].data.description, /FOLLOWED|COMBINED/);
  assert.ok(!(embeds[0].data.fields ?? []).some((field) => /Followed/.test(field.name)));
});
