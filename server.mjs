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

const fee = state => state.game.fee ?? Math.ceil(state.game.cost / (playing(state).length || state.game.capacity));
const publicName = player => {
  if (!player.fullName) return player.name;
  const parts = player.name.split(/\s+/);
  return parts[0] + ' ' + Array.from(parts.at(-1))[0] + '.';
};

function paymentRows(state) {
  if (!state.game) return [];
  return state.players.filter(p => p.status === 'playing' || p.paid).map(p => ({
    id: p.id, name: p.name, game: state.game.title, kickoff: state.game.kickoff,
    fee: fee(state), paid: p.paid
  }));
}

function archive(state) {
  state.ledger ||= [];
  state.ledger.push(...paymentRows(state));
  state.players = [];
  state.teams = null;
}

function rollFixture(state) {
  if (!state.game?.weekly || Date.now() < Date.parse(state.game.kickoff) + 7200000) return;
  archive(state);
  const next = new Date(state.game.kickoff);
  do { next.setDate(next.getDate() + 7); }
  while (next.getTime() + 7200000 <= Date.now());
  state.game.kickoff = next.toISOString();
}

function maintain(state) {
  if (!state.game) return;
  rollFixture(state);
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

function view(state, organiser, identity) {
  const waiting = queue(state);
  const confirmed = playing(state);
  const mine = state.players.find(p => p.identity === identity);
  const cutoff = Date.parse(state.game?.kickoff);
  const teams = state.teams && state.teams.map(side => side.map(id => publicName(state.players.find(p => p.id === id))));
  const assigned = new Set(state.teams?.flat());
  return {
    organiser, game: state.game, confirmed: confirmed.length, reserves: waiting.length,
    offered: state.players.filter(p => p.status === 'offered').length,
    due: state.game ? fee(state) : 0,
    closed: cutoff <= Date.now(),
    mine: mine && { name: mine.name, status: mine.status, until: mine.until, paid: mine.paid, position: waiting.indexOf(mine) + 1 },
    teams: organiser ? state.teams : teams,
    players: organiser ? state.players.map(({ id, name, status, paid }) => ({ id, name, status, paid })) : confirmed.map(publicName),
    ...(organiser && { ledger: [...paymentRows(state), ...(state.ledger || []).slice().reverse()] }),
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
  if (!organiser && !/^\p{L}.*\s+.*\p{L}/u.test(name)) throw err('Enter your first and last name.');
  const existing = state.players.find(p => p.name.toLowerCase() === name.toLowerCase() && (!identity || p.identity !== identity));
  if (existing) throw err('That name is already on the list. Ask the organiser if that entry is yours.');
  let player = identity && state.players.find(p => p.identity === identity);
  if (player && ['playing', 'reserve', 'offered'].includes(player.status)) return;
  if (player) state.players.splice(state.players.indexOf(player), 1);
  if (state.players.length >= 150) throw err('The sign-up list is full.');
  const active = playing(state).length + state.players.filter(p => p.status === 'offered').length;
  const status = active < state.game.capacity ? 'playing' : 'reserve';
  state.players.push({ id: player?.id || token(), name, fullName: !organiser, status, paid: player?.paid || false, identity: organiser ? null : identity });
}

function manage(state, action, data) {
  if (action === 'game') {
    const title = clean(data.title, 80);
    const venue = clean(data.venue, 100);
    const kickoff = Date.parse(data.kickoff);
    const { capacity, cost } = data;
    const fixedFee = data.fee ?? null;
    const weekly = data.weekly === true;
    const localKickoff = new Date(kickoff);
    if (!title || !venue || !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(data.kickoff) ||
      !Number.isFinite(kickoff) || (!state.game || data.fresh) && kickoff <= Date.now() ||
      !Number.isInteger(capacity) || capacity < 2 || capacity > 60 ||
      !Number.isInteger(cost) || cost < 0 || cost > 1000000 ||
      (fixedFee !== null && (!Number.isInteger(fixedFee) || fixedFee < 0 || fixedFee > 100000)) ||
      (weekly && (localKickoff.getDay() !== 2 || localKickoff.getHours() !== 14 || localKickoff.getMinutes() !== 0))) throw err('Check the fixture details.');
    if (!data.fresh && capacity < playing(state).length + state.players.filter(p => p.status === 'offered').length) {
      throw err('Capacity is below the number of confirmed and offered places.');
    }
    if (data.fresh) archive(state);
    state.game = { title, venue, kickoff: new Date(kickoff).toISOString(), capacity, cost, fee: fixedFee, weekly, payment: clean(data.payment, 300) };
    return;
  }
  if (!state.game) throw err('Create a fixture first.');
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
    const historical = state.ledger?.find(row => row.id === data.id && row.kickoff === data.kickoff);
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
  const path = new URL(req.url, 'http://localhost').pathname;
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
    let identity = cookie(req, 'player');
    let session = cookie(req, 'organiser');
    db.exec('BEGIN IMMEDIATE');
    let result;
    try {
      const original = read.get().json;
      const state = JSON.parse(original);
      let organiser = Boolean(session && state.sessions[session] > Date.now());
      maintain(state);
      const action = data.action;
      if (req.method === 'POST') {
        if (action === 'login') {
          if (typeof data.password !== 'string' || !timingSafeEqual(hash(data.password), hash(password))) throw err('Incorrect organiser password.', 401);
          state.sessions = Object.fromEntries(Object.entries(state.sessions).filter(([, until]) => until > Date.now()).slice(-30));
          session = token();
          state.sessions[session] = Date.now() + 86400000;
          setCookie(req, res, 'organiser', session, 86400);
          organiser = true;
        } else if (action === 'logout') {
          delete state.sessions[session];
          setCookie(req, res, 'organiser', '', 0);
          organiser = false;
        } else if (['join', 'out', 'accept'].includes(action)) {
          if (data.kickoff && data.kickoff !== state.game?.kickoff) throw err('The fixture has changed. Refresh and try again.');
          if (!state.game || started(state)) throw err('Sign-ups are closed.');
          identity ||= token();
          const player = state.players.find(p => p.identity === identity);
          if (action === 'join') add(state, clean(data.name, 40), identity, false);
          if (action === 'out') {
            if (!player) throw err('You have no active sign-up on this phone.');
            player.status = 'out';
          }
          if (action === 'accept') {
            if (player?.status !== 'offered') throw err('This offer is no longer available.');
            player.status = 'playing';
          }
          setCookie(req, res, 'player', identity, 31536000);
        } else {
          if (!organiser) throw err('Sign in as organiser.', 401);
          manage(state, action, data);
        }
        maintain(state);
      }
      result = view(state, organiser, identity);
      const updated = JSON.stringify(state);
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
