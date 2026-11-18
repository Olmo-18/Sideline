const content = document.querySelector('#content');
const notice = document.querySelector('#notice');
const modal = document.querySelector('#modal');
const organiserButton = document.querySelector('#organiser');
const money = pence => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(pence / 100);
const date = iso => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const button = (text, action, css = '', id = '') => '<button type="button" class="' + css + '" data-action="' + action + '" data-id="' + id + '">' + text + '</button>';
const statusLabel = { playing: 'Playing', reserve: 'Reserve', offered: 'Place offered', out: 'Can’t play', expired: 'Offer expired' };
let state;
let busy = false;

function announce(message, error = false) {
  notice.hidden = !message;
  notice.textContent = message;
  notice.className = error ? 'error' : '';
}

async function update(data, refresh = false) {
  if (busy) return false;
  busy = true;
  try {
    const response = await fetch(data ? '/api/action' : '/api/state', data && {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    const next = await response.json();
    if (!response.ok) throw Error(next.error);
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
  if (!game) {
    content.innerHTML = '<section class="hero"><div class="pitch" aria-hidden="true"></div><p class="eyebrow">Weekly football</p><h1>No game scheduled</h1><p class="venue">The next fixture will appear here.</p>' +
      (organiser ? button('Set up a game', 'edit') : '') + '</section>';
    return;
  }
  const active = ['playing', 'reserve', 'offered'].includes(mine?.status);
  const full = confirmed + offered >= game.capacity;
  const availability = mine?.status === 'reserve' ? 'Reserve · ' + (mine.position === 1 ? 'first in line' : 'position ' + mine.position) :
    mine?.status === 'offered' ? 'You have a place on offer until ' + date(mine.until) + '.' : statusLabel[mine?.status];
  const controls = closed ? '<p>Sign-ups closed</p>' :
    '<div class="actions">' +
    (mine?.status === 'offered' ? button('Accept place', 'accept') : !active ? button(full ? 'Join reserve list' : 'I’m in', 'join-form') : '') +
    (active ? button(mine.status === 'offered' ? 'Decline place' : 'Can’t play', 'out', 'outline') : '') + '</div>';
  content.innerHTML = '<section class="hero"><div class="pitch" aria-hidden="true"></div><p class="eyebrow">Next game · ' + esc(date(game.kickoff)) + (game.weekly ? ' · Weekly' : '') + '</p><h1>' +
    esc(game.title) + '</h1><p class="venue">' + esc(game.venue) + '</p><progress aria-label="Places filled" value="' + confirmed + '" max="' + game.capacity +
    '"></progress><div class="summary"><strong>' + confirmed + ' of ' + game.capacity + ' places filled</strong><span class="fee">' + money(state.due) + ' each</span></div>' +
    (availability ? '<p>' + esc((mine?.name ? mine.name + ' · ' : '') + availability) + '</p>' : '') +
    controls + '</section>' +
    '<section class="panel"><div class="section-head"><h2>Players</h2>' +
    (organiser ? '<div class="actions">' + button('Edit fixture', 'edit', 'soft small') + button('Add player', 'add-form', 'small') + '</div>' : '') +
    '</div><p class="muted">' + reserves + ' waiting · ' + offered + ' places on offer</p>' + players() + '</section>' + teams() + payment() +
    '<div class="footer actions">' + button('Copy game link', 'copy-link', 'soft small') +
    (organiser ? button('Payment sheet', 'ledger', 'soft small') + button('Set up next game', 'fresh', 'soft small') : '') + '</div>';
}

function players() {
  if (!state.players.length) return '<p class="muted">No players have joined yet.</p>';
  let reserve = 0;
  return '<ul class="list">' + state.players.map(p => {
    if (!state.organiser) return '<li class="row"><span class="name">' + esc(p) + '</span></li>';
    const status = p.status === 'reserve' ? 'Reserve · ' + (++reserve === 1 ? 'first in line' : reserve) : statusLabel[p.status];
    return '<li class="row"><div><div class="name">' + esc(p.name) + '</div><span class="pill ' + (p.status === 'offered' ? 'offer' : '') + '">' + status +
      '</span></div><div class="actions">' +
      (p.status === 'playing' || p.paid ? button(p.paid ? 'Paid ✓' : 'Outstanding', 'paid', 'soft small', p.id) : '') +
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

function payment() {
  const { game, organiser, mine } = state;
  const outstanding = organiser ? state.players.filter(p => p.status === 'playing' && !p.paid) : [];
  let link;
  try { const url = new URL(game.payment); if (url.protocol === 'https:') link = url.href; } catch {}
  return '<section class="panel"><div class="section-head"><h2>Payments</h2><strong>' + money(state.due) + ' each</strong></div>' +
    (organiser ? '<p class="muted">Pitch cost ' + money(game.cost) + ' · ' + outstanding.length + ' outstanding</p>' +
      (outstanding.length ? '<p>' + outstanding.map(p => esc(p.name)).join(', ') + '</p>' : '') : '') +
    (mine?.status === 'playing' ? '<p>Your payment · ' + (mine.paid ? 'Paid' : 'Outstanding') + '</p>' : '') +
    (link ? '<a class="link soft" href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">Open payment link</a>' :
      game.payment ? '<p class="payment">' + esc(game.payment) + '</p>' : '<p class="muted">Payment details haven’t been added yet.</p>') + '</section>';
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

function fixture(fresh) {
  const game = state.game;
  const parts = iso => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/London', dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso)).replace(' ', 'T');
  form(fresh ? 'Set up next game' : 'Fixture details',
    (fresh ? '<p class="warning">Saving starts a new fixture and archives the current payment records.</p>' : '') +
    '<label>Game name<input name="title" required maxlength="80" value="' + esc(game?.title || 'Tuesday football') +
    '"></label><label>Pitch<input name="venue" required maxlength="100" value="' + esc(game?.venue) +
    '"></label><label>Kick-off (UK time)<input type="datetime-local" name="kickoff" required value="' +
    (game ? parts(fresh ? Date.parse(game.kickoff) + 7 * 86400000 : game.kickoff) : '') +
    '"></label><label class="check"><input type="checkbox" name="weekly" ' + (game?.weekly ? 'checked' : '') + '> Repeat every Tuesday at 2 pm</label><div class="form-columns"><label>Places<input name="capacity" type="number" min="2" max="60" required value="' + (game?.capacity ?? 14) +
    '"></label><label>Pitch cost (£)<input name="cost" type="number" min="0" max="10000" step="0.01" required value="' + (game ? game.cost / 100 : 112) +
    '"></label></div><label>Fixed fee per player (£)<input name="fee" type="number" min="0" max="1000" step="0.01" required value="' + ((state.game ? state.due : 600) / 100) + '"></label><label>Payment link or details <textarea name="payment" maxlength="300">' + esc(game?.payment) +
    '</textarea></label>', 'Save fixture', values => update({ ...values, action: 'game', fresh, weekly: Boolean(values.weekly),
      capacity: Number(values.capacity), cost: Math.round(Number(values.cost) * 100),
      fee: values.fee === '' ? null : Math.round(Number(values.fee) * 100) }));
  const repeat = modal.querySelector('[name=weekly]');
  const kickoff = modal.querySelector('[name=kickoff]');
  repeat.onchange = () => {
    if (!repeat.checked) return;
    const now = parts(new Date());
    const chosen = new Date((kickoff.value.slice(0, 10) || now.slice(0, 10)) + 'T14:00:00Z');
    chosen.setUTCDate(chosen.getUTCDate() + (2 - chosen.getUTCDay() + 7) % 7);
    if (chosen.toISOString().slice(0, 16) <= now) chosen.setUTCDate(chosen.getUTCDate() + 7);
    kickoff.value = chosen.toISOString().slice(0, 16);
  };
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
  if (action === 'edit' || action === 'fresh') return fixture(action === 'fresh');
  if (action === 'join-form' || action === 'add-form') return form(action === 'add-form' ? 'Add player' : 'Join the game',
    '<label>' + (action === 'join-form' ? 'Full name' : 'Player name') + '<input name="name" autocomplete="name" maxlength="40" required value="' + esc(action === 'join-form' ? state.mine?.name : '') + '"></label>',
    action === 'add-form' ? 'Add player' : 'Confirm', values => update({ ...values, action: action === 'add-form' ? 'add' : 'join', kickoff: state.game.kickoff }));
  if (action === 'swap-form') return form('Swap players', state.teams.map((side, i) => '<label>Team ' + ['A', 'B'][i] +
    '<select name="' + ['a', 'b'][i] + '">' + side.map(player => '<option value="' + player + '">' + esc(nameFor(player)) + '</option>').join('') +
    '</select></label>').join(''), 'Swap players', values => update({ ...values, action: 'swap' }));
  if (action === 'remove-form') return form('Remove ' + esc(nameFor(id)) + '?', '', 'Remove player', () => update({ action: 'remove', id }));
  if (action === 'copy-link') return copy(location.origin, 'Game link copied.');
  if (action === 'copy-teams') return copy('*' + state.game.title + '*\n' + date(state.game.kickoff) + ' · ' + state.game.venue + '\n\n' +
    sides().map((names, i) => '*Team ' + ['A', 'B'][i] + '*\n' + names.join('\n')).join('\n\n'), 'Teams copied for WhatsApp.');
  if (action === 'ledger') return showLedger();
  if (action === 'ledger-paid') {
    const ok = await update({ action, id, kickoff: control.dataset.kickoff });
    if (ok) showLedger();
    return;
  }
  if (action === 'ledger-csv') return downloadLedger();
  await update({ action, id, kickoff: state?.game?.kickoff });
});

update();
setInterval(() => { if (!document.hidden && !modal.open) update(undefined, true); }, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !modal.open) update(undefined, true); });

function showLedger() {
  const rows = state.ledger || [];
  const outstanding = rows.reduce((sum, row) => sum + (row.paid ? 0 : row.fee), 0);
  modal.innerHTML = '<h2 id="dialog-title">Payment sheet</h2><p><strong>' + money(outstanding) +
    ' outstanding</strong></p>' + (rows.length ? '<div class="sheet"><table><thead><tr><th>Player</th><th>Fixture</th><th>Owes</th><th>Payment</th></tr></thead><tbody>' +
    rows.map(row => '<tr><td>' + esc(row.name) + '</td><td>' + esc(date(row.kickoff)) + '</td><td>' +
      money(row.paid ? 0 : row.fee) + '</td><td><button type="button" class="soft small" data-action="ledger-paid" data-id="' + esc(row.id) +
      '" data-kickoff="' + esc(row.kickoff) + '">' + (row.paid ? 'Paid ✓' : 'Mark paid') + '</button></td></tr>').join('') + '</tbody></table></div>' :
    '<p class="muted">Payment records appear when players are confirmed.</p>') +
    '<p class="dialog-status warning" role="alert"></p><div class="actions">' +
    (rows.length ? button('Download CSV', 'ledger-csv') : '') +
    '<button type="button" class="soft" data-close-sheet>Close</button></div>';
  modal.querySelector('[data-close-sheet]').onclick = () => modal.close();
  if (!modal.open) modal.showModal();
}

function downloadLedger() {
  const field = value => {
    let text = String(value);
    if (/^\s*[=+@-]/.test(text) || /^[\r\n\t]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const csv = [['Full name','Game','Kick-off (UK time)','Fee GBP','Paid','Outstanding GBP'],
    ...state.ledger.map(row => [row.name, row.game, date(row.kickoff), (row.fee / 100).toFixed(2),
      row.paid ? 'Yes' : 'No', (row.paid ? 0 : row.fee / 100).toFixed(2)])]
    .map(row => row.map(field).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'touchline-payment-sheet.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
