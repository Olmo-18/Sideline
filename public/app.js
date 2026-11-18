const content = document.querySelector('#content');
const notice = document.querySelector('#notice');
const modal = document.querySelector('#modal');
const organiserButton = document.querySelector('#organiser');
const attendancePage = location.pathname === '/attendance';
if (attendancePage) document.title = 'Attendance sheet | Touchline';
const date = iso => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const button = (text, action, css = '', id = '') => '<button type="button" class="' + css + '" data-action="' + action + '" data-id="' + id + '">' + text + '</button>';
const statusLabel = { playing: 'Playing', reserve: 'Reserve', offered: 'Place offered', out: 'Can’t play', expired: 'Offer expired' };
let state;
let fixtureId = '';
let busy = false;

function announce(message, error = false) {
  notice.hidden = !message;
  notice.textContent = message;
  notice.className = error ? 'error' : '';
}

async function update(data, refresh = false, selected = fixtureId) {
  if (busy) return false;
  busy = true;
  try {
    const response = await fetch((data ? '/api/action' : '/api/state') + (selected ? '?fixture=' + encodeURIComponent(selected) : ''), data && {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    const next = await response.json();
    if (!response.ok) throw Error(next.error);
    fixtureId = next.fixtureId || '';
    if (!refresh || JSON.stringify(next) !== JSON.stringify(state)) {
      state = next;
      render();
    }
    if (data) announce('');
    return true;
  } catch (error) {
    if (!refresh || !state) {
      if (modal.open) modal.querySelector('.dialog-status').textContent = error.message;
      else announce(error.message, true);
    }
    return false;
  } finally { busy = false; }
}

function render() {
  const { game, organiser, confirmed, reserves, offered, mine, closed } = state;
  organiserButton.textContent = organiser ? 'Sign out' : 'Organiser';
  organiserButton.dataset.action = organiser ? 'logout' : 'login-form';
  if (attendancePage) return renderAttendance();
  if (!game) {
    content.innerHTML = '<section class="hero"><div class="pitch" aria-hidden="true"></div><p class="eyebrow">Weekly football</p><h1>No game scheduled</h1><p class="venue">The next fixture will appear here.</p>' +
      (organiser ? button('Set up a game', 'edit') : '') + '</section>';
    return;
  }
  const active = ['playing', 'reserve', 'offered'].includes(mine?.status);
  const remaining = Math.max(0, game.capacity - confirmed - offered);
  const full = remaining === 0;
  const availability = mine?.status === 'reserve' ? 'Reserve · ' + (mine.position === 1 ? 'first in line' : 'position ' + mine.position) :
    mine?.status === 'offered' ? 'You have a place on offer until ' + date(mine.until) + '.' : statusLabel[mine?.status];
  const controls = closed ? '<p>Sign-ups closed</p>' :
    '<div class="actions">' +
    (mine?.status === 'offered' ? button('Accept place', 'accept') : !active ? button(full ? 'Join reserve list' : 'I’m in', 'join-form') : '') +
    (active ? button(mine.status === 'offered' ? 'Decline place' : 'Can’t play', 'out', 'outline') : '') +
    (active && mine.smsOptedIn ? button('Turn off texts', 'sms-opt-out', 'outline small') : '') + '</div>';
  content.innerHTML = (organiser ? fixturePicker() : '') + '<section class="hero"><div class="pitch" aria-hidden="true"></div><p class="eyebrow">' + (organiser && fixtureId !== state.nextFixtureId ? 'Fixture' : 'Next game') + ' · ' + esc(date(game.kickoff)) + (game.weekly ? ' · Weekly' : '') + '</p><h1>' +
    esc(game.title) + '</h1><p class="venue">' + esc(game.venue) + '</p><progress aria-label="Places filled" value="' + confirmed + '" max="' + game.capacity +
    '"></progress><div class="summary"><strong>' + confirmed + ' of ' + game.capacity + ' places filled</strong></div>' +
    (availability ? '<p>' + esc((mine?.name ? mine.name + ' · ' : '') + availability) + '</p>' : '') +
    controls + '</section>' +
    '<section class="panel"><div class="section-head"><h2>Players</h2>' +
    (organiser ? '<div class="actions">' + button('Edit fixture', 'edit', 'soft small') + button('Add player', 'add-form', 'small') + '</div>' : '') +
    '</div>' + (closed ? '' : '<p class="muted" aria-live="polite">' +
      availabilityStatus(remaining, reserves, confirmed >= game.capacity) + '</p>') + players() + '</section>' + teams();
}

function availabilityStatus(remaining, reserves, filled) {
  if (remaining) return remaining + (remaining === 1 ? ' space remaining' : ' spaces remaining');
  const parts = [filled ? 'Game full' : 'All remaining spaces held for reserves'];
  parts.push(reserves ? reserves + ' on the waiting list' : 'Waiting list open');
  return parts.join(' · ');
}

function fixturePicker() {
  const index = state.fixtures.findIndex(fixture => fixture.id === fixtureId);
  const previous = state.fixtures[index - 1];
  const next = state.fixtures[index + 1];
  return '<section class="panel"><div class="section-head"><h2>Fixtures</h2>' +
    '<div class="actions">' + '<a class="attendance-link" href="/attendance">Attendance sheet</a>' +
    button('Add fixture', 'new-fixture', 'small') + '</div></div><div class="fixture-navigation">' +
    '<button type="button" class="soft small" data-action="step-fixture" data-id="' + esc(previous?.id) +
    '" aria-label="Previous game"' + (previous ? '' : ' disabled') + '>←</button>' +
    '<label>View fixture<select id="fixture-select">' +
    state.fixtures.map(fixture => '<option value="' + esc(fixture.id) + '"' +
      (fixtureId === fixture.id ? ' selected' : '') + '>' + esc(date(fixture.kickoff) + ' · ' + fixture.title +
      ' · ' + fixture.confirmed + ' confirmed') + '</option>').join('') + '</select></label>' +
    '<button type="button" class="soft small" data-action="step-fixture" data-id="' + esc(next?.id) +
    '" aria-label="Next game"' + (next ? '' : ' disabled') + '>→</button></div></section>';
}

document.addEventListener('change', async event => {
  if (event.target.id !== 'fixture-select') return;
  if (!await update(undefined, false, event.target.value)) event.target.value = fixtureId;
});

function players() {
  if (!state.players.length) return '<p class="muted">No players have joined yet.</p>';
  let reserve = 0;
  return '<ul class="list">' + state.players.map(p => {
    if (!state.organiser) return '<li class="row"><span class="name">' + esc(p) + '</span></li>';
    const status = p.status === 'reserve' ? 'Reserve · ' + (++reserve === 1 ? 'first in line' : reserve) : statusLabel[p.status];
    return '<li class="row"><div><div class="name">' + esc(p.name) + '</div><span class="pill ' + (p.status === 'offered' ? 'offer' : '') + '">' + status +
      '</span></div><div class="actions">' +
      (p.status === 'offered' && !state.closed ? button('Confirm', 'confirm', 'small', p.id) : '') +
      (['playing', 'offered', 'reserve'].includes(p.status) ? button('Remove', 'remove-form', 'quiet small', p.id) : '') +
      '</div></li>';
  }).join('') + '</ul>';
}

const nameFor = id => state.players.find(p => p.id === id)?.name;
const sides = () => state.organiser ? state.teams?.map(side => side.map(nameFor)) : state.teams;

function teams() {
  const lineups = sides();
  return '<section class="panel"><div class="section-head"><h2>Teams</h2></div>' +
    (lineups ? '<div class="sides">' + lineups.map((side, i) => '<section class="side"><h3>Team ' + ['A', 'B'][i] +
      '</h3><ul class="list">' + side.map(name => '<li>' + esc(name) + '</li>').join('') + '</ul></section>').join('') + '</div>' +
      (state.unassigned ? '<p class="muted">' + state.unassigned + ' confirmed players still need a team.</p>' : '') :
      '<p class="muted">Teams will appear here once the organiser picks them.</p>') +
    '<div class="actions">' + (state.organiser && state.confirmed >= 2 ? button(lineups ? 'Shuffle teams' : 'Generate teams', 'shuffle') : '') +
    (state.organiser && state.teams?.every(side => side.length) ? button('Swap players', 'swap-form', 'soft') : '') +
    (lineups ? button('Copy for WhatsApp', 'copy-teams', 'soft') : '') + '</div></section>';
}

function form(title, fields, submit, run) {
  modal.innerHTML = '<form><h2 id="dialog-title">' + title + '</h2>' + fields +
    '<p class="dialog-status warning" role="alert"></p><div class="actions"><button>' + submit +
    '</button><button type="button" class="soft" data-cancel>Cancel</button></div></form>';
  const element = modal.querySelector('form');
  element.querySelector('[data-cancel]').onclick = () => modal.close();
  element.onsubmit = async event => {
    event.preventDefault();
    const submitButton = element.querySelector('button');
    submitButton.disabled = true;
    try { if (await run(Object.fromEntries(new FormData(element)))) modal.close(); }
    finally { submitButton.disabled = false; }
  };
  modal.showModal();
}

function fixture(create) {
  const game = state.game;
  const ukDate = iso => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/London', dateStyle: 'short' }).format(new Date(iso));
  form(create ? 'Add fixture' : 'Fixture details',
    '<label>Game name<input name="title" required maxlength="80" value="' + esc(game?.title || 'Tuesday Football') +
    '"></label><label>Pitch<input name="venue" required maxlength="100" value="' + esc(game?.venue) +
    '"></label><label>Kick-off date · Tuesday at 7 pm UK time<input type="date" name="gameDate" min="1970-01-06" step="7" required value="' +
    (game && !create ? ukDate(game.kickoff) : '') +
    '"></label>' + (!create && !fixtureId ? '<label class="check"><input type="checkbox" name="weekly" ' + (game?.weekly ? 'checked' : '') + '> Repeat every Tuesday at 7 pm</label>' : '') + '<label>Places<input name="capacity" type="number" min="2" max="60" required value="' + (game?.capacity ?? 14) +
    '"></label>', 'Save fixture', values => update({ ...values, action: create ? 'create-fixture' : 'game',
      kickoff: values.gameDate + 'T19:00', weekly: Boolean(values.weekly), capacity: Number(values.capacity) }));
}

async function copy(text, message) {
  try { await navigator.clipboard.writeText(text); announce(message); }
  catch { form('Copy text', '<label>Copy this text<textarea rows="9" readonly>' + esc(text) + '</textarea></label>', 'Done', () => true); }
}

document.addEventListener('click', async event => {
  const control = event.target.closest('[data-action]');
  if (!control) return;
  const { action, id } = control.dataset;
  if (action === 'login-form') return form('Organiser sign-in', '<label>Password<input type="password" name="password" autocomplete="current-password" required></label>', 'Sign in', values => update({ ...values, action: 'login' }));
  if (action === 'step-fixture') return update(undefined, false, id);
  if (action === 'edit' || action === 'new-fixture') return fixture(action === 'new-fixture');
  if (action === 'join-form') return form('Join the game',
    '<label>Full name<input name="name" autocomplete="name" maxlength="40" required value="' + esc(state.mine?.name) + '"></label>' +
    (state.smsEnabled ? '<label>UK mobile number (optional)<input type="tel" name="phone" autocomplete="tel" maxlength="32"></label>' +
      '<label class="check"><input type="checkbox" name="smsConsent"> Text me about my place or waiting-list status for this game</label>' : ''),
    'Confirm', values => update({ action: 'join', name: values.name, phone: values.phone,
      smsConsent: Boolean(values.smsConsent), kickoff: state.game.kickoff }));
  if (action === 'add-form') return form('Add player', '<label>Player name<input name="name" autocomplete="name" maxlength="40" required></label>',
    'Add player', values => update({ ...values, action: 'add', kickoff: state.game.kickoff }));
  if (action === 'swap-form') return form('Swap players', state.teams.map((side, i) => '<label>Team ' + ['A', 'B'][i] +
    '<select name="' + ['a', 'b'][i] + '">' + side.map(player => '<option value="' + player + '">' + esc(nameFor(player)) + '</option>').join('') +
    '</select></label>').join(''), 'Swap players', values => update({ ...values, action: 'swap' }));
  if (action === 'remove-form') return form('Remove ' + esc(nameFor(id)) + '?', '', 'Remove player', () => update({ action: 'remove', id }));
  if (action === 'copy-teams') return copy('*' + state.game.title + '*\n' + date(state.game.kickoff) + ' · ' + state.game.venue + '\n\n' +
    sides().map((names, i) => '*Team ' + ['A', 'B'][i] + '*\n' + names.join('\n')).join('\n\n'), 'Teams copied for WhatsApp.');
  if (action === 'attendance') {
    await update({ action, id, kickoff: control.dataset.kickoff, played: control.dataset.played === 'true' });
    return;
  }
  await update({ action, id, kickoff: state?.game?.kickoff });
});

update();
setInterval(() => { if (!document.hidden && !modal.open) update(undefined, true); }, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !modal.open) update(undefined, true); });

function renderAttendance() {
  const heading = '<section class="panel"><div class="section-head"><h1 class="attendance-title">Attendance sheet</h1>' +
    '<a href="/">Back to fixtures</a></div>';
  if (!state.organiser) {
    content.innerHTML = heading + '<p>Sign in as organiser to view weekly attendance.</p>' +
      button('Organiser sign-in', 'login-form') + '</section>';
    return;
  }
  const fixtures = new Map();
  for (const row of state.attendance) {
    if (!fixtures.has(row.kickoff)) fixtures.set(row.kickoff, []);
    fixtures.get(row.kickoff).push(row);
  }
  const fullDate = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeZone: 'Europe/London' });
  content.innerHTML = heading + (fixtures.size ? [...fixtures].map(([kickoff, rows]) => {
    const upcoming = rows[0].upcoming;
    const count = rows.filter(row => row.played).length;
    return '<table class="attendance-table"><caption><strong>' + esc(fullDate.format(new Date(kickoff))) +
      '</strong><span>' + esc(rows[0].game) + ' · ' + count + (upcoming ? ' confirmed' : ' played') + '</span></caption>' +
      '<thead><tr><th scope="col">Player</th><th scope="col">Status</th>' +
      (upcoming ? '' : '<th scope="col">Update</th>') + '</tr></thead><tbody>' +
      rows.map(row => '<tr><td>' + esc(row.name) + '</td><td>' + (upcoming ? 'Confirmed' : row.played ? 'Played' : 'Absent') +
        '</td>' + (upcoming ? '' : '<td><button type="button" class="soft small" data-action="attendance" data-id="' +
        esc(row.id) + '" data-kickoff="' + esc(kickoff) + '" data-played="' + !row.played +
        '" aria-label="' + (row.played ? 'Mark absent: ' : 'Mark played: ') + esc(row.name) + '">' +
        (row.played ? 'Mark absent' : 'Mark played') + '</button></td>') + '</tr>').join('') + '</tbody></table>';
  }).join('') : '<p class="muted">Confirmed players appear here as soon as they sign up.</p>') + '</section>';
}
