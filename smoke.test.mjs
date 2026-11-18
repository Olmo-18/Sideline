import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('organiser, shared roster, FIFO offers, teams and durable payments', async t => {
  const data = mkdtempSync(join(tmpdir(), 'touchline-'));
  const password = 'test-password-only';
  let server;
  t.after(async () => {
    if (server && server.exitCode === null) {
      server.kill();
      await once(server, 'exit');
    }
    rmSync(data, { recursive: true, force: true });
  });
  async function start() {
    server = spawn(process.execPath, ['server.mjs'], {
      env: { ...process.env, NODE_ENV: 'test', PORT: '0', DATA_DIR: data, ORGANISER_PASSWORD: password }
    });
    const port = await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.once('exit', code => reject(Error('Server exited: ' + code)));
      server.stdout.on('data', chunk => {
        const match = /listening on port (\d+)/.exec(String(chunk));
        if (match) resolve(match[1]);
      });
    });
    return 'http://127.0.0.1:' + port;
  }
  let base = await start();
  function client() {
    let cookie = '';
    return async (action, values = {}, expected = 200) => {
      const response = await fetch(base + (action ? '/api/action' : '/api/state'), {
        ...(action && { method: 'POST', body: JSON.stringify({ action, ...values }) }),
        headers: { cookie, 'Content-Type': 'application/json' }
      });
      assert.equal(response.status, expected);
      cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie;
      return response.json();
    };
  }
  const admin = client(), olly = client(), robin = client(), tom = client(), ed = client();
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await olly()).game, null);
  await olly('add', { name: 'Unauthorized' }, 401);
  await admin('login', { password: 'wrong' }, 401);
  await admin('login', { password });
  const kickoff = (new Date().getUTCFullYear() + 1) + '-11-23T19:00';
  await admin('game', { title: 'Tuesday football', venue: 'Main pitch', kickoff, capacity: 2, cost: 1600 });
  assert.equal((await olly()).game.title, 'Tuesday Football');
  const firstSignup = await olly('join', { name: 'Olly Jones' });
  assert.equal(firstSignup.mine.status, 'playing');
  assert.equal(firstSignup.due, 600);
  assert.equal((await admin()).ledger[0].fee, 600);
  assert.equal((await admin('add', { name: 'Alec +1' })).confirmed, 2);
  await admin('add', { name: 'Alec +1' }, 400);
  assert.equal((await robin('join', { name: 'Robin Green' })).mine.position, 1);
  assert.equal((await tom('join', { name: 'Tom L' })).mine.position, 2);
  const shuffled = await admin('shuffle');
  const [[a], [b]] = shuffled.teams;
  assert.deepEqual((await admin('swap', { a, b })).teams, [[b], [a]]);
  const ollyId = shuffled.players.find(p => p.name === 'Olly Jones').id;
  await admin('paid', { id: ollyId });
  assert.equal((await olly()).mine.paid, true);
  assert.equal((await robin()).players.includes('Olly J.'), true);
  assert.equal((await robin()).players.every(p => typeof p === 'string'), true);
  await olly('out');
  assert.equal((await robin()).mine.status, 'offered');
  assert.equal((await tom()).mine.position, 1);
  assert.equal((await ed('join', { name: 'Ed Smith' })).mine.status, 'reserve');
  await robin('out');
  assert.equal((await tom('accept')).mine.status, 'playing');
  assert.equal((await ed()).mine.position, 1);
  const newest = await admin('shuffle');
  assert.equal(newest.unassigned, 0);
  const guestId = newest.players.find(p => p.name === 'Alec +1').id;
  await admin('paid', { id: guestId });
  server.kill();
  await once(server, 'exit');
  base = await start();
  const persisted = await admin();
  assert.equal(persisted.players.find(p => p.id === guestId).paid, true);
  assert.deepEqual(persisted.teams, newest.teams);
  assert.equal((await tom()).mine.status, 'playing');
  await ed('join', { name: 'Ed' }, 400);
  assert.equal((await ed()).ledger, undefined);
  const previousTuesday = new Date();
  previousTuesday.setUTCDate(previousTuesday.getUTCDate() - ((previousTuesday.getUTCDay() + 5) % 7 || 7));
  const previousKickoff = previousTuesday.toISOString().slice(0, 10) + 'T14:00';
  const rolled = await admin('game', {
    title: 'Tuesday football', venue: 'Main pitch', kickoff: previousKickoff, capacity: 2,
    cost: 1600, weekly: true, fee: 600
  });
  assert.equal(rolled.game.weekly, true);
  assert.notEqual(rolled.game.kickoff.slice(0, 10), previousKickoff.slice(0, 10));
  const ukTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit' });
  assert.match(ukTime.format(new Date(rolled.game.kickoff)), /^Tue.*14:00$/);
  assert.equal(rolled.confirmed, 0);
  assert.equal(rolled.due, 600);
  const oldTom = rolled.ledger.find(row => row.name === 'Tom L');
  assert.equal(oldTom.paid, false);
  assert.equal(oldTom.fee, 600);
  const marked = await admin('ledger-paid', { id: oldTom.id, kickoff: oldTom.kickoff });
  assert.equal(marked.ledger.find(row => row.id === oldTom.id).paid, true);
  assert.equal((await tom()).ledger, undefined);
});
