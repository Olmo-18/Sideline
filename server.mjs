import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual, createHash, randomInt } from 'node:crypto';
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

const fullName = name => /^\p{L}.*\s+.*\p{L}/u.test(name);

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

function fixtureRows(state) {
  if (!state.game) return [];
  return state.players.filter(p => p.status === 'playing' || p.paid).map(p => ({
    id: p.id, name: p.name, profileId: p.profileId, game: state.game.title, kickoff: state.game.kickoff,
    fee: fee(state), paid: p.paid, played: started(state) && (p.attended ?? (p.status === 'playing'))
  }));
}

const playerKey = name => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

function attendanceRows(state) {
  return [...allFixtures(state).flatMap(fixtureRows), ...(state.ledger || [])]
    .filter(row => Date.parse(row.kickoff) <= Date.now())
    .map(({ id, name, game, kickoff, played }) => ({ id, name, game, kickoff, played: played !== false }))
    .sort((a, b) => b.kickoff.localeCompare(a.kickoff) || a.name.localeCompare(b.name));
}

function archive(state) {
  state.ledger ||= [];
  state.ledger.push(...fixtureRows(state));
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

function view(state, organiser, identity, root = state) {
  const waiting = queue(state);
  const confirmed = playing(state);
  const mine = state.players.find(p => p.identity === identity);
  const cutoff = Date.parse(state.game?.kickoff);
  const teams = state.teams && state.teams.map(side => side.map(id => publicName(state.players.find(p => p.id === id))));
  const assigned = new Set(state.teams?.flat());
  const game = state.game;
  return {
    organiser,
    game: game && { title: game.title, venue: game.venue, kickoff: game.kickoff, capacity: game.capacity, weekly: game.weekly },
    confirmed: confirmed.length, reserves: waiting.length,
    offered: state.players.filter(p => p.status === 'offered').length,
    closed: cutoff <= Date.now(),
    mine: mine && { name: mine.name, status: mine.status, until: mine.until, position: waiting.indexOf(mine) + 1 },
    teams: organiser ? state.teams : teams,
    players: organiser ? state.players.map(({ id, name, status }) => ({ id, name, status })) : confirmed.map(publicName),
    ...(organiser && { attendance: attendanceRows(root), fixtureId: state.id || '', nextFixtureId: nextFixture(root).id || '',
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

function add(state, name, identity, organiser) {
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
  state.players.push({ id: player?.id || token(), name, fullName: !organiser, status, paid: player?.paid || false, identity: organiser ? null : identity });
}

function manage(state, action, data, root = state) {
  if (action === 'game') {
    const title = clean(data.title, 80);
    const venue = clean(data.venue, 100);
    const kickoff = Date.parse(data.kickoff);
    const { capacity } = data;
    const weekly = state === root && data.weekly === true;
    const localKickoff = new Date(kickoff);
    if (!title || !venue || !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(data.kickoff) ||
      !Number.isFinite(kickoff) || (!state.game || data.fresh) && kickoff <= Date.now() ||
      !Number.isInteger(capacity) || capacity < 2 || capacity > 60) throw err('Check the fixture details.');
    if (localKickoff.getDay() !== 2 || localKickoff.getHours() !== weeklyKickoffHour ||
        localKickoff.getMinutes() !== 0) throw err('Games kick off on Tuesdays at 7 pm UK time.');
    if (!data.fresh && capacity < playing(state).length + state.players.filter(p => p.status === 'offered').length) {
      throw err('Capacity is below the number of confirmed and offered places.');
    }
    if (allFixtures(root).some(fixture => fixture !== state && fixture.game?.kickoff === new Date(kickoff).toISOString())) {
      throw err('A fixture already exists at that kick-off time.');
    }
    if (data.fresh) archive(state);
    state.game = { ...state.game, title, venue, kickoff: new Date(kickoff).toISOString(), capacity, weekly };
    return;
  }
  if (!state.game) throw err('Create a fixture first.');
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
  const player = state.players.find(p => p.id === data.id);
  if (!player) throw err('Player no longer on the list.');
  if (action === 'confirm' && player.status === 'offered' && !started(state)) player.status = 'playing';
  else if (action === 'remove') player.status = 'out';
  else throw err('Unknown action.', 404);
}

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  if (req.method === 'GET' && path === '/' && url.searchParams.has('game')) {
    res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('This fixture link has been retired. Open the Touchline home page for the next game.');
  }
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
      const legacySession = root.playerSessions?.[playerSession];
      if (!identity && legacySession?.until > Date.now()) {
        identity = legacySession.profileId;
        setCookie(req, res, 'player', identity, 31536000);
      }
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
        } else if (['join', 'out', 'accept'].includes(action)) {
          if (data.kickoff && data.kickoff !== state.game?.kickoff) throw err('The fixture has changed. Refresh and try again.');
          if (!state.game || started(state)) throw err('Sign-ups are closed.');
          const player = state.players.find(p => p.identity === identity);
          if (action === 'join') {
            identity ||= token();
            add(state, clean(data.name, 40), identity, false);
            setCookie(req, res, 'player', identity, 31536000);
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
      result = view(state, organiser, identity, root);
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
