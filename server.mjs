import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual, createHash, randomInt, scryptSync } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

process.env.TZ = 'Europe/London';
const password = process.env.ORGANISER_PASSWORD;
if (!password || password.length < 12) throw Error('Set ORGANISER_PASSWORD to at least 12 characters.');
const dataDir = resolve(process.env.DATA_DIR || 'data');
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(resolve(dataDir, 'touchline.sqlite'));
db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, json TEXT NOT NULL);');
db.prepare('INSERT OR IGNORE INTO state VALUES (1, ?)').run(JSON.stringify({ game: null, players: [], teams: null, sessions: {} }));
const read = db.prepare('SELECT json FROM state WHERE id=1');
const write = db.prepare('UPDATE state SET json=? WHERE id=1');
const token = () => randomBytes(24).toString('hex');
const hash = value => createHash('sha256').update(value).digest();
const assets = new Map(Object.entries({ '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] })
  .map(([url, [file, type]]) => [url, [readFileSync(new URL('./public/' + file, import.meta.url)), type]]));
const err = (message, status = 400) => Object.assign(Error(message), { status });
const clean = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const cookie = (req, name) => req.headers.cookie?.match(new RegExp('(?:^|; )' + name + '=([a-f0-9]{48})(?:;|$)'))?.[1];
const setCookie = (req, res, name, value, age) => res.appendHeader('Set-Cookie',
  name + '=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + age +
  (req.socket.encrypted || process.env.NODE_ENV === 'production' ? '; Secure' : ''));
const playing = state => state.players.filter(p => p.status === 'playing');
const queue = state => state.players.filter(p => p.status === 'reserve');
const started = state => Date.parse(state.game?.kickoff) <= Date.now();

const attempts = new Map();
const ukMobile = value => {
  const number = clean(value, 32).replace(/[\s()-]/g, '').replace(/^0044/, '+44').replace(/^0/, '+44');
  return /^\+447\d{9}$/.test(number) ? number : '';
};
const fullName = name => /^\p{L}.*\s+.*\p{L}/u.test(name);

function playerSignIn(state, data, register) {
  const phone = ukMobile(data.phone);
  if (!phone || typeof data.password !== 'string' || data.password.length < 12 || data.password.length > 128) {
    throw err('Enter a UK mobile number and a password of 12 to 128 characters.');
  }
  const now = Date.now();
  for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key);
  const limit = attempts.get(phone) || { count: 0, until: now + 900000 };
  if (limit.count >= 10 || !attempts.has(phone) && attempts.size >= 500) throw err('Too many attempts. Try again in 15 minutes.', 429);
  limit.count++;
  attempts.set(phone, limit);
  state.profiles ||= {};
  let profile = Object.values(state.profiles).find(entry => entry.phone === phone);
  if (register) {
    const name = clean(data.name, 40);
    if (!fullName(name)) throw err('Enter your first and last name.');
    if (profile) throw err('This phone number already has an account. Sign in with your password.', 409);
    if (Object.keys(state.profiles).length >= 1000) throw err('Please ask the organiser to help you register.');
    const id = token();
    const salt = randomBytes(16).toString('hex');
    profile = { id, name, phone, salt, linkCode: randomBytes(6).toString('hex'), passwordHash: scryptSync(data.password, salt, 32).toString('hex') };
    state.profiles[id] = profile;
  } else {
    const candidate = scryptSync(data.password, profile?.salt || 'touchline-invalid', 32);
    if (!profile || !timingSafeEqual(candidate, Buffer.from(profile.passwordHash, 'hex'))) {
      throw err('Phone number or password is incorrect.', 401);
    }
  }
  attempts.delete(phone);
  return profile;
}

const defaultFee = 600;
const extraFixtures = state => Object.values(state.fixtures || {});
const allFixtures = state => [state, ...extraFixtures(state)];
const nextFixture = state => allFixtures(state).filter(fixture =>
  fixture.game && Date.parse(fixture.game.kickoff) + 7200000 > Date.now())
  .sort((a, b) => a.game.kickoff.localeCompare(b.game.kickoff))[0] || state;
const fee = state => state.game.fee ?? defaultFee;
const publicName = player => {
  if (!player.fullName) return player.name;
  const parts = player.name.split(/\s+/);
  return parts[0] + ' ' + Array.from(parts.at(-1))[0] + '.';
};

function paymentRows(state) {
  if (!state.game) return [];
  return state.players.filter(p => p.status === 'playing' || p.paid).map(p => ({
    id: p.id, name: p.name, profileId: p.profileId, game: state.game.title, kickoff: state.game.kickoff,
    fee: fee(state), paid: p.paid, played: started(state) && (p.attended ?? (p.status === 'playing'))
  }));
}

const playerKey = name => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

function allPaymentRows(state) {
  return [...allFixtures(state).flatMap(paymentRows), ...(state.ledger || []).slice().reverse()];
}

function playerAccounts(state) {
  const accounts = new Map();
  const accountFor = (name, profileId) => {
    const key = profileId ? 'player:' + profileId : playerKey(name);
    const profile = state.profiles?.[profileId];
    if (!accounts.has(key)) accounts.set(key, { key, name: profile?.name || name, phoneEnd: profile?.phone.slice(-4),
      games: 0, charged: 0, paid: 0, payments: [] });
    return accounts.get(key);
  };
  for (const profile of Object.values(state.profiles || {})) accountFor(profile.name, profile.id);
  for (const fixture of allFixtures(state)) {
    for (const player of fixture.players) accountFor(player.name, player.profileId);
  }
  for (const row of allPaymentRows(state)) {
    const account = accountFor(row.name, row.profileId);
    if (row.played !== false) {
      account.games++;
      account.charged += row.fee;
    }
    if (row.paid) {
      account.paid += row.fee;
      account.payments.push({ amount: row.fee, date: null, fixtureDate: row.kickoff });
    }
  }
  for (const payment of state.payments || []) {
    const account = accountFor(payment.name, payment.profileId);
    account.payments.push(payment);
    account.paid += payment.amount;
  }
  return [...accounts.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function archive(state) {
  state.ledger ||= [];
  state.ledger.push(...paymentRows(state));
  state.players = [];
  state.teams = null;
}

const weeklyKickoffHour = 19;

function rollFixture(state) {
  if (!state.game?.weekly) return;
  const next = new Date(state.game.kickoff);
  const now = Date.now();
  if (now < next.getTime()) {
    next.setHours(weeklyKickoffHour, 0, 0, 0);
  } else {
    if (now < next.getTime() + 7200000) return;
    archive(state);
    next.setHours(weeklyKickoffHour, 0, 0, 0);
    do { next.setDate(next.getDate() + 7); }
    while (next.getTime() + 7200000 <= now);
  }
  const kickoff = next.toISOString();
  if (now >= Date.parse(state.game.kickoff) + 7200000) {
    const planned = extraFixtures(state).find(fixture => fixture.game.kickoff === kickoff);
    if (planned) {
      state.game = { ...planned.game, weekly: true };
      state.players = planned.players;
      state.teams = planned.teams;
      delete state.fixtures[planned.id];
      return;
    }
  }
  state.game.kickoff = kickoff;
}

function maintain(state, recurring = true) {
  if (!state.game) return;
  if (state.game.title === 'Tuesday football') state.game.title = 'Tuesday Football';
  if (recurring) rollFixture(state);
  if (state.teams) {
    const eligible = new Set(playing(state).map(p => p.id));
    state.teams = state.teams.map(side => side.filter(id => eligible.has(id)));
  }
  if (started(state)) return;
  for (const player of state.players) {
    if (player.status === 'offered' && player.until <= Date.now()) player.status = 'expired';
  }
  const slots = state.game.capacity - playing(state).length - state.players.filter(p => p.status === 'offered').length;
  for (const player of queue(state).slice(0, Math.max(0, slots))) {
    player.status = 'offered';
    player.until = Math.min(Date.now() + 86400000, Date.parse(state.game.kickoff));
  }
}

function view(state, organiser, identity, root = state, profile) {
  const waiting = queue(state);
  const confirmed = playing(state);
  const mine = state.players.find(p => p.identity === identity);
  const cutoff = Date.parse(state.game?.kickoff);
  const teams = state.teams && state.teams.map(side => side.map(id => publicName(state.players.find(p => p.id === id))));
  const assigned = new Set(state.teams?.flat());
  const accounts = organiser || profile ? playerAccounts(root) : [];
  const own = profile && accounts.find(account => account.key === 'player:' + profile.id);
  return {
    organiser, ...(own && { myAccount: {
      name: own.name, linkCode: profile.linkCode, games: own.games, paid: own.paid, charged: own.charged,
      payments: own.payments.map(({ amount, date, fixtureDate }) => ({ amount, date, fixtureDate }))
    } }), game: state.game, confirmed: confirmed.length, reserves: waiting.length,
    offered: state.players.filter(p => p.status === 'offered').length,
    due: state.game ? fee(state) : 0,
    closed: cutoff <= Date.now(),
    mine: mine && { name: mine.name, status: mine.status, until: mine.until, paid: mine.paid, position: waiting.indexOf(mine) + 1 },
    teams: organiser ? state.teams : teams,
    players: organiser ? state.players.map(({ id, name, status, paid }) => ({ id, name, status, paid })) : confirmed.map(publicName),
    ...(organiser && { ledger: allPaymentRows(root), accounts, fixtureId: state.id || '', nextFixtureId: nextFixture(root).id || '',
      fixtures: allFixtures(root).filter(fixture => fixture.game).map(fixture => ({
        id: fixture.id || '', title: fixture.game.title, kickoff: fixture.game.kickoff,
        confirmed: playing(fixture).length
      })).sort((a, b) => a.kickoff.localeCompare(b.kickoff)) }),
    unassigned: confirmed.filter(p => !assigned.has(p.id)).length
  };
}

async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw err('Use JSON.');
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 16384) throw err('Request too large.', 413);
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw Error();
    return parsed;
  } catch { throw err('Invalid request.'); }
}

function add(state, name, identity, organiser, profileId) {
  if (!name) throw err('Enter a name.');
  if (!organiser && !fullName(name)) throw err('Enter your first and last name.');
  const existing = state.players.find(p => playerKey(p.name) === playerKey(name) && (!identity || p.identity !== identity));
  if (existing) throw err('That name is already on the list. Ask the organiser if that entry is yours.');
  let player = identity && state.players.find(p => p.identity === identity);
  if (player && ['playing', 'reserve', 'offered'].includes(player.status)) return;
  if (player) state.players.splice(state.players.indexOf(player), 1);
  if (state.players.length >= 150) throw err('The sign-up list is full.');
  const active = playing(state).length + state.players.filter(p => p.status === 'offered').length;
  const status = active < state.game.capacity ? 'playing' : 'reserve';
  state.players.push({ id: player?.id || token(), name, profileId, fullName: !organiser, status, paid: player?.paid || false, identity: organiser ? null : identity });
}

function manage(state, action, data, root = state) {
  if (action === 'game') {
    const title = clean(data.title, 80);
    const venue = clean(data.venue, 100);
    const kickoff = Date.parse(data.kickoff);
    const { capacity, cost } = data;
    const fixedFee = data.fee ?? defaultFee;
    const weekly = state === root && data.weekly === true;
    const localKickoff = new Date(kickoff);
    if (!title || !venue || !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(data.kickoff) ||
      !Number.isFinite(kickoff) || (!state.game || data.fresh) && kickoff <= Date.now() ||
      !Number.isInteger(capacity) || capacity < 2 || capacity > 60 ||
      !Number.isInteger(cost) || cost < 0 || cost > 1000000 ||
      !Number.isInteger(fixedFee) || fixedFee < 0 || fixedFee > 100000) throw err('Check the fixture details.');
    if (localKickoff.getDay() !== 2 || localKickoff.getHours() !== weeklyKickoffHour ||
        localKickoff.getMinutes() !== 0) throw err('Games kick off on Tuesdays at 7 pm UK time.');
    if (!data.fresh && capacity < playing(state).length + state.players.filter(p => p.status === 'offered').length) {
      throw err('Capacity is below the number of confirmed and offered places.');
    }
    if (allFixtures(root).some(fixture => fixture !== state && fixture.game?.kickoff === new Date(kickoff).toISOString())) {
      throw err('A fixture already exists at that kick-off time.');
    }
    if (data.fresh) archive(state);
    state.game = { title, venue, kickoff: new Date(kickoff).toISOString(), capacity, cost, fee: fixedFee, weekly, payment: clean(data.payment, 300) };
    return;
  }
  if (!state.game) throw err('Create a fixture first.');
  if (action === 'record-payment') {
    const account = playerAccounts(root).find(entry => entry.key === data.key);
    if (!account || !Number.isInteger(data.amount) || data.amount < 1 || data.amount > 1000000 ||
        typeof data.id !== 'string' || !/^[a-f0-9-]{36}$/.test(data.id)) throw err('Choose a player and enter a valid payment amount.');
    root.payments ||= [];
    if (!root.payments.some(payment => payment.id === data.id)) {
      root.payments.push({ id: data.id, name: account.name, profileId: account.key.startsWith('player:') ? account.key.slice(7) : undefined, amount: data.amount, date: new Date().toISOString() });
    }
    return;
  }
  if (action === 'link-player') {
    const profileId = typeof data.target === 'string' ? data.target.slice(7) : '';
    const profile = Object.hasOwn(root.profiles || {}, profileId) && root.profiles[profileId];
    const old = playerAccounts(root).find(account => account.key === data.key && !account.phoneEnd);
    if (!profile || !old || data.target !== 'player:' + profile.id) throw err('Choose an existing record and a player account.');
    if (clean(data.linkCode, 20).toLowerCase() !== profile.linkCode) throw err('Enter the linking code the player gave you.');
    const matches = row => !row.profileId && playerKey(row.name) === old.key;
    const fixtures = allFixtures(root);
    if (fixtures.some(fixture => fixture.players.some(matches) && fixture.players.some(player => player.profileId === profile.id))) {
      throw err('Both records appear in the same fixture. Remove the duplicate before linking.', 409);
    }
    for (const fixture of fixtures) {
      for (const player of fixture.players.filter(matches)) {
        player.profileId = profile.id;
        player.identity = profile.id;
        player.fullName = true;
      }
    }
    for (const row of [...(root.ledger || []), ...(root.payments || [])].filter(matches)) row.profileId = profile.id;
    return;
  }
  if (action === 'undo-payment') {
    root.payments = (root.payments || []).filter(payment => payment.id !== data.id);
    return;
  }
  if (action === 'attendance') {
    const row = root.ledger?.find(entry => entry.id === data.id && entry.kickoff === data.kickoff);
    if (typeof data.played !== 'boolean') throw err('Choose an attendance status.');
    if (row && Date.parse(row.kickoff) <= Date.now()) {
      row.played = data.played;
      return;
    }
    const fixture = allFixtures(root).find(entry => entry.game?.kickoff === data.kickoff);
    const player = fixture?.players.find(entry => entry.id === data.id);
    if (!player || !started(fixture)) throw err('This game has not started.');
    player.attended = data.played;
    return;
  }
  if (action === 'add') return add(state, clean(data.name, 40), null, true);
  if (action === 'shuffle') {
    const ids = playing(state).map(p => p.id);
    if (ids.length < 2) throw err('At least two confirmed players are needed.');
    for (let i = ids.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const split = Math.ceil(ids.length / 2);
    state.teams = [ids.slice(0, split), ids.slice(split)];
    return;
  }
  if (action === 'swap') {
    const a = state.teams?.[0].indexOf(data.a);
    const b = state.teams?.[1].indexOf(data.b);
    if (!(a >= 0 && b >= 0)) throw err('Choose a player from each team.');
    [state.teams[0][a], state.teams[1][b]] = [state.teams[1][b], state.teams[0][a]];
    return;
  }
  if (action === 'ledger-paid' && data.kickoff !== state.game.kickoff) {
    const historical = root.ledger?.find(row => row.id === data.id && row.kickoff === data.kickoff);
    if (!historical) throw err('Payment record no longer exists.');
    historical.paid = !historical.paid;
    return;
  }
  const player = state.players.find(p => p.id === data.id);
  if (!player) throw err('Player no longer on the list.');
  if (action === 'paid' || action === 'ledger-paid') player.paid = !player.paid;
  else if (action === 'confirm' && player.status === 'offered' && !started(state)) player.status = 'playing';
  else if (action === 'remove') player.status = 'out';
  else throw err('Unknown action.', 404);
}

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  if (req.method === 'GET' && assets.has(path)) {
    const [asset, type] = assets.get(path);
    res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(asset);
  }
  const json = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  try {
    if (req.method === 'GET' && path !== '/api/state' || req.method === 'POST' && path !== '/api/action' ||
        !['GET', 'POST'].includes(req.method)) throw err('Not found.', 404);
    const data = req.method === 'POST' ? await body(req) : {};
    const playerSession = cookie(req, 'player_session');
    let identity = cookie(req, 'player');
    let session = cookie(req, 'organiser');
    db.exec('BEGIN IMMEDIATE');
    let result;
    try {
      const original = read.get().json;
      const root = JSON.parse(original);
      const login = root.playerSessions?.[playerSession];
      let profile = login && login.until > Date.now() ? root.profiles?.[login.profileId] : undefined;
      if (profile) identity = profile.id;
      let organiser = Boolean(session && root.sessions[session] > Date.now());
      maintain(root);
      let state = organiser ? root : nextFixture(root);
      const selectedId = url.searchParams.get('fixture');
      if (selectedId && organiser) {
        if (!Object.hasOwn(root.fixtures || {}, selectedId) && req.method === 'POST' && data.action !== 'logout') {
          throw err('That fixture moved to the main game. Reopen it from the fixture picker.', 409);
        }
        state = Object.hasOwn(root.fixtures || {}, selectedId) ? root.fixtures[selectedId] : root;
      }
      if (state !== root) maintain(state, false);
      const action = data.action;
      if (req.method === 'POST') {
        if (action === 'login') {
          if (typeof data.password !== 'string' || !timingSafeEqual(hash(data.password), hash(password))) throw err('Incorrect organiser password.', 401);
          root.sessions = Object.fromEntries(Object.entries(root.sessions).filter(([, until]) => until > Date.now()).slice(-30));
          session = token();
          root.sessions[session] = Date.now() + 86400000;
          setCookie(req, res, 'organiser', session, 86400);
          organiser = true;
          state = root;
        } else if (action === 'logout') {
          delete root.sessions[session];
          setCookie(req, res, 'organiser', '', 0);
          organiser = false;
          state = nextFixture(root);
        } else if (action === 'player-register' || action === 'player-login') {
          profile = playerSignIn(root, data, action === 'player-register');
          const fresh = token();
          root.playerSessions = Object.fromEntries(Object.entries(root.playerSessions || {}).filter(([, value]) => value.until > Date.now()).slice(-3000));
          root.playerSessions[fresh] = { profileId: profile.id, until: Date.now() + 2592000000 };
          setCookie(req, res, 'player_session', fresh, 2592000);
          if (identity && !login) {
            for (const fixture of allFixtures(root)) {
              const player = fixture.players.find(entry => entry.identity === identity && !entry.profileId && playerKey(entry.name) === playerKey(profile.name));
              if (player && !fixture.players.some(entry => entry.profileId === profile.id)) {
                player.identity = profile.id;
                player.profileId = profile.id;
              }
            }
          }
          identity = profile.id;
        } else if (action === 'player-logout') {
          if (playerSession && root.playerSessions) delete root.playerSessions[playerSession];
          setCookie(req, res, 'player_session', '', 0);
          setCookie(req, res, 'player', '', 0);
          profile = undefined;
          identity = undefined;
        } else if (['join', 'out', 'accept'].includes(action)) {
          if (data.kickoff && data.kickoff !== state.game?.kickoff) throw err('The fixture has changed. Refresh and try again.');
          if (!state.game || started(state)) throw err('Sign-ups are closed.');
          const player = state.players.find(p => p.identity === identity);
          if (action === 'join') {
            if (!profile) throw err('Sign in with your mobile number to join.', 401);
            add(state, profile.name, identity, false, profile.id);
          }
          if (action === 'out') {
            if (!player) throw err('You have no active sign-up on this phone.');
            player.status = 'out';
          }
          if (action === 'accept') {
            if (player?.status !== 'offered') throw err('This offer is no longer available.');
            player.status = 'playing';
          }

        } else {
          if (!organiser) throw err('Sign in as organiser.', 401);
          if (action === 'create-fixture') {
            if (!root.game) throw err('Set up the main fixture first.');
            const fixture = { id: token(), game: null, players: [], teams: null };
            manage(fixture, 'game', { ...data, fresh: false }, root);
            root.fixtures ||= {};
            root.fixtures[fixture.id] = fixture;
            state = fixture;
          } else {
            manage(state, action, data, root);
          }
        }
        maintain(state, state === root);
      }
      result = view(state, organiser, identity, root, profile);
      const updated = JSON.stringify(root);
      if (updated !== original) write.run(updated);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    json(200, result);
  } catch (error) {
    if (!error.status) console.error(error);
    json(error.status || 500, { error: error.status ? error.message : 'Something went wrong. Try again.' });
  }
});
server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => {
  console.log('Touchline is listening on port ' + server.address().port);
});
