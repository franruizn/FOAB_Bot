import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKillsEmbed } from './killsEmbed.js';

function build(buckets, totals) {
  return buildKillsEmbed({
    result: { alliance: 'FRIEND', buckets, totals, warnings: [] },
    battlesProcessed: 1,
    battlesRequested: 1,
    guildsDisplay: 'foab',
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
