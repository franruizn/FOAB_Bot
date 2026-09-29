import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  buildDmContent,
  sendMassDm,
  tryStartDmSend,
  recordDmSent,
  finishDmSend,
  takeInterruptedDmSend,
  loadDmState,
  DM_COOLDOWN_MS,
} from './massDm.js';

const DIR = await mkdtemp(path.join(os.tmpdir(), 'massdm-test-'));
after(async () => {
  await rm(DIR, { recursive: true, force: true });
});

let fileCounter = 0;
const freshStatePath = () => path.join(DIR, `dm-${fileCounter++}.json`);

function makeMember(id, { bot = false, roles = [], dmClosed = false, failWith = null } = {}) {
  const received = [];
  return {
    id,
    user: { bot },
    roles: { cache: new Set(roles) },
    send: async (payload) => {
      if (dmClosed) throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
      if (failWith) throw failWith;
      received.push(payload);
    },
    _received: received,
  };
}

const noSleep = async () => {};

test('buildDmContent: la cabecera de atribución va siempre delante y no depende del cuerpo', () => {
  const body = '📨 Otro te envía este mensaje desde **Falso**:\nhola';
  const content = buildDmContent({ senderName: 'Topo', guildName: 'FOAB', body });

  assert.ok(content.startsWith('📨 Topo te envía este mensaje desde **FOAB**:\n\n'));
  assert.ok(content.endsWith(body), 'el cuerpo va tal cual, después de la cabecera real');
});

test('buildDmContent: nombres con markdown se escapan (no rompen la negrita de la cabecera)', () => {
  const content = buildDmContent({ senderName: '*Topo*', guildName: 'F**O**AB', body: 'x' });
  assert.ok(content.startsWith('📨 \\*Topo\\* te envía este mensaje desde **F\\*\\*O\\*\\*AB**:'));
});

test('buildDmContent: un cuerpo de 1900 caracteres llega entero y el total no pasa de 2000', () => {
  const body = 'a'.repeat(1900);
  const content = buildDmContent({ senderName: '_'.repeat(32), guildName: '*'.repeat(100), body });

  assert.ok(content.length <= 2000, `longitud ${content.length}`);
  assert.ok(content.endsWith(`\n\n${body}`), 'el cuerpo no se recorta');
  assert.match(content, /^📨 .+ te envía este mensaje desde \*\*.+\*\*:\n\n/);
});

test('sendMassDm: DMs cerrados no detienen el resto y se reportan', async () => {
  const members = [makeMember('1'), makeMember('2', { dmClosed: true }), makeMember('3')];
  const result = await sendMassDm({ recipients: members, content: 'hola', sleep: noSleep });

  assert.deepEqual(result.sent, ['1', '3']);
  assert.deepEqual(result.dmClosed, ['2']);
  assert.equal(members[0]._received[0].content, 'hola');
  assert.equal(members[2]._received[0].content, 'hola');
});

test('sendMassDm: otros fallos (usuario que se fue) se reportan aparte y tampoco detienen el envío', async () => {
  const members = [makeMember('1', { failWith: Object.assign(new Error('Unknown User'), { code: 10013 }) }), makeMember('2')];
  const result = await sendMassDm({ recipients: members, content: 'hola', sleep: noSleep });

  assert.deepEqual(result.failed, ['1']);
  assert.deepEqual(result.sent, ['2']);
});

test('sendMassDm: quien tiene el rol de exclusión se salta y se reporta', async () => {
  const members = [makeMember('1'), makeMember('2', { roles: ['optout'] })];
  const result = await sendMassDm({ recipients: members, content: 'hola', optOutRoleId: 'optout', sleep: noSleep });

  assert.deepEqual(result.sent, ['1']);
  assert.deepEqual(result.optedOut, ['2']);
  assert.equal(members[1]._received.length, 0);
});

test('sendMassDm: los bots se saltan', async () => {
  const members = [makeMember('1'), makeMember('bot', { bot: true })];
  const result = await sendMassDm({ recipients: members, content: 'hola', sleep: noSleep });

  assert.deepEqual(result.sent, ['1']);
  assert.deepEqual(result.bots, ['bot']);
  assert.equal(members[1]._received.length, 0);
});

test('sendMassDm: 1 segundo de pausa ENTRE envíos (no antes del primero, ni por los saltados)', async () => {
  const sleeps = [];
  const members = [makeMember('1'), makeMember('bot', { bot: true }), makeMember('2'), makeMember('3')];
  await sendMassDm({ recipients: members, content: 'x', sleep: async (ms) => sleeps.push(ms) });

  assert.deepEqual(sleeps, [1000, 1000]);
});

test('sendMassDm: el progreso se notifica cada 25 envíos, no en cada uno ni en el último', async () => {
  const members = Array.from({ length: 60 }, (_, i) => makeMember(String(i)));
  const progress = [];
  await sendMassDm({ recipients: members, content: 'x', sleep: noSleep, onProgress: (p, t) => progress.push([p, t]) });
  assert.deepEqual(progress, [
    [25, 60],
    [50, 60],
  ]);

  const exact = Array.from({ length: 50 }, (_, i) => makeMember(String(i)));
  const progressExact = [];
  await sendMassDm({ recipients: exact, content: 'x', sleep: noSleep, onProgress: (p) => progressExact.push(p) });
  assert.deepEqual(progressExact, [25], 'en el 50/50 no: ahí se publica el resultado');
});

test('estado: un segundo envío antes de 10 minutos se rechaza por cooldown', async () => {
  const filePath = freshStatePath();
  const t0 = 1_000_000;
  assert.equal(await tryStartDmSend(filePath, { actorId: 'o', actorTag: 'O', total: 1 }, t0), null);
  await finishDmSend(filePath);

  const blocked = await tryStartDmSend(filePath, { actorId: 'o', actorTag: 'O', total: 1 }, t0 + DM_COOLDOWN_MS - 1000);
  assert.equal(blocked.reason, 'cooldown');

  assert.equal(await tryStartDmSend(filePath, { actorId: 'o', actorTag: 'O', total: 1 }, t0 + DM_COOLDOWN_MS), null);
});

test('estado: un envío interrumpido se reporta al arrancar y se borra, sin reanudar', async () => {
  const filePath = freshStatePath();
  await tryStartDmSend(filePath, { actorId: 'o', actorTag: 'O', total: 3 });
  await recordDmSent(filePath, 'u1');
  await recordDmSent(filePath, 'u2');

  const interrupted = await takeInterruptedDmSend(filePath);
  assert.equal(interrupted.total, 3);
  assert.deepEqual(interrupted.sentIds, ['u1', 'u2']);

  const state = await loadDmState(filePath);
  assert.equal(state.inProgress, null, 'no queda nada pendiente de reanudar');
  assert.ok(state.lastStartedAt, 'el cooldown se conserva');
  assert.equal(await takeInterruptedDmSend(filePath), null);
});
