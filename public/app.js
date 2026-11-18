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
let fixtureId = '';
let sharedGame = new URLSearchParams(location.search).get('game');
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
    const query = new URLSearchParams();
    if (selected) query.set('fixture', selected);
    if (sharedGame) query.set('game', sharedGame);
    const response = await fetch((data ? '/api/action' : '/api/state') + (query.size ? '?' + query : ''), data && {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    const next = await response.json();
    if (response.status === 404 && sharedGame) {
      content.innerHTML = '<section class="panel"><h1>Game link unavailable</h1><p><a href="/">See the next game</a></p></section>';
    }
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
  const { game, organiser, confirmed, reserves, offered, mine, closed, myAccount } = state;
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
    (mine?.status === 'offered' ? button('Accept place', 'accept') : !active ? button(full ? 'Join reserve list' : 'I’m in', myAccount ? 'join' : 'join-form') : '') +
    (active ? button(mine.status === 'offered' ? 'Decline place' : 'Can’t play', 'out', 'outline') : '') + '</div>';
  content.innerHTML = (organiser ? fixturePicker() : '') + '<section class="hero"><div class="pitch" aria-hidden="true"></div><p class="eyebrow">' + (organiser && fixtureId !== state.nextFixtureId ? 'Fixture' : 'Next game') + ' · ' + esc(date(game.kickoff)) + (game.weekly ? ' · Weekly' : '') + '</p><h1>' +
    esc(game.title) + '</h1><p class="venue">' + esc(game.venue) + '</p><a class="map-link" href="https://w3w.co/' + esc(game.meetingPoint) +
    '" target="_blank" rel="noopener noreferrer">Open map · ///' + esc(game.meetingPoint) + '</a><progress aria-label="Places filled" value="' + confirmed + '" max="' + game.capacity +
    '"></progress><div class="summary"><strong>' + confirmed + ' of ' + game.capacity + ' places filled</strong><span class="fee">' + money(state.due) + ' each</span></div>' +
    (availability ? '<p>' + esc((mine?.name ? mine.name + ' · ' : '') + availability) + '</p>' : '') +
    controls + '</section>' + '<section class="panel"><div class="section-head"><h2>My payments</h2></div>' +
    (myAccount ? accountDetails(myAccount) + '<details><summary>Link older records</summary><p>Give this code to the organiser privately: <code>' +
      esc(myAccount.linkCode) + '</code></p></details>' + button('Sign out of player account', 'player-logout', 'quiet small') :
      '<div class="actions">' + button('Player sign-in', 'player-login', 'soft small') + button('Create player account', 'player-register', 'quiet small') + '</div>') +
    '</section>' +
    '<section class="panel"><div class="section-head"><h2>Players</h2>' +
    (organiser ? '<div class="actions">' + button('Edit fixture', 'edit', 'soft small') + button('Add player', 'add-form', 'small') + '</div>' : '') +
    '</div><p class="muted">' + reserves + ' waiting · ' + offered + ' places on offer</p>' + players() + '</section>' + teams() + payment() +
    '<div class="footer actions">' + (organiser ? '' : button('Copy game link', 'copy-link', 'soft small')) +
    (organiser ? button('Payment sheet', 'ledger', 'soft small') : '') + '</div>';
}

function accountDetails(account) {
  const balance = account.charged - account.paid;
  const payments = account.payments.slice().sort((a, b) => (b.date || b.fixtureDate).localeCompare(a.date || a.fixtureDate));
  return '<p>' + esc(account.name) + ' · ' + account.games + ' games played · ' + money(account.paid) +
    ' paid · <strong>' + (balance > 0 ? money(balance) + ' owed' : balance < 0 ? money(-balance) + ' credit' : 'Settled') +
    '</strong></p>' + (payments.length ? '<details><summary>Payment history</summary><ul class="list">' +
    payments.map(payment => '<li class="row">' + money(payment.amount) + ' · ' +
      (payment.date ? esc(date(payment.date)) : 'Marked paid for ' + esc(date(payment.fixtureDate)) + ' · payment date unavailable') +
      '</li>').join('') + '</ul></details>' : '');
}

function playerForm(register, joining) {
  form(register ? 'Create player account' : 'Player sign-in',
    (register ? '<label>Full name<input name="name" autocomplete="name" maxlength="40" required></label>' : '') +
    '<label>UK mobile number<input type="tel" name="phone" autocomplete="tel" maxlength="32" required></label>' +
    '<label>Password<input type="password" name="password" minlength="12" maxlength="128" autocomplete="' +
    (register ? 'new-password' : 'current-password') + '" required></label>' +
    '<button type="button" class="quiet small" data-action="' +
    (register ? 'player-login' : 'player-register') + (joining ? '-join' : '') + '">' +
    (register ? 'Already registered? Sign in' : 'Create a player account') + '</button>',
    register ? 'Create account' : 'Sign in', async values => {
      const ok = await update({ ...values, action: register ? 'player-register' : 'player-login' });
      if (!ok || !joining) return ok;
      return Boolean(state.mine && ['playing', 'reserve', 'offered'].includes(state.mine.status)) ||
        await update({ action: 'join', kickoff: state.game?.kickoff });
    });
}

function fixturePicker() {
  const index = state.fixtures.findIndex(fixture => fixture.id === fixtureId);
  const previous = state.fixtures[index - 1];
  const next = state.fixtures[index + 1];
  return '<section class="panel"><div class="section-head"><h2>Fixtures</h2>' +
    '<div class="actions">' + button('Copy game link', 'copy-link', 'soft small') +
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
  if (!await browseFixture(event.target.value)) event.target.value = fixtureId;
});

async function browseFixture(selected) {
  const oldLink = sharedGame;
  sharedGame = null;
  const ok = await update(undefined, false, selected);
  if (ok && oldLink) history.replaceState(null, '', '/');
  if (!ok) sharedGame = oldLink;
  return ok;
}

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

function payment() {
  const { game } = state;
  let link;
  try { const url = new URL(game.payment); if (url.protocol === 'https:') link = url.href; } catch {}
  return '<section class="panel"><div class="section-head"><h2>Payments</h2><strong>' + money(state.due) + ' each</strong></div>' +
    (state.organiser ? '<p class="muted">Pitch cost ' + money(game.cost) + '</p>' : '') +
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

function fixture(create) {
  const game = state.game;
  const ukDate = iso => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/London', dateStyle: 'short' }).format(new Date(iso));
  form(create ? 'Add fixture' : 'Fixture details',
    '<label>Game name<input name="title" required maxlength="80" value="' + esc(game?.title || 'Tuesday Football') +
    '"></label><label>Pitch<input name="venue" required maxlength="100" value="' + esc(game?.venue) +
    '"></label><label>Kick-off date · Tuesday at 7 pm UK time<input type="date" name="gameDate" min="1970-01-06" step="7" required value="' +
    (game && !create ? ukDate(game.kickoff) : '') +
    '"></label>' + (!create && !fixtureId ? '<label class="check"><input type="checkbox" name="weekly" ' + (game?.weekly ? 'checked' : '') + '> Repeat every Tuesday at 7 pm</label>' : '') + '<div class="form-columns"><label>Places<input name="capacity" type="number" min="2" max="60" required value="' + (game?.capacity ?? 14) +
    '"></label><label>Pitch cost (£)<input name="cost" type="number" min="0" max="10000" step="0.01" required value="' + (game ? game.cost / 100 : 112) +
    '"></label></div><label>Fixed fee per player (£)<input name="fee" type="number" min="0" max="1000" step="0.01" required value="' + ((state.game ? state.due : 600) / 100) + '"></label><label>Payment link or details <textarea name="payment" maxlength="300">' + esc(game?.payment) +
    '</textarea></label>', 'Save fixture', values => update({ ...values, action: create ? 'create-fixture' : 'game', kickoff: values.gameDate + 'T19:00', weekly: Boolean(values.weekly),
      capacity: Number(values.capacity), cost: Math.round(Number(values.cost) * 100),
      fee: values.fee === '' ? null : Math.round(Number(values.fee) * 100) }));
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
  if (action === 'step-fixture') return browseFixture(id);
  if (action === 'edit' || action === 'new-fixture') return fixture(action === 'new-fixture');
  if (action === 'join-form' || action === 'player-login-join') return playerForm(false, true);
  if (action === 'player-register-join') return playerForm(true, true);
  if (action === 'player-login' || action === 'player-register') return playerForm(action === 'player-register', false);
  if (action === 'add-form') return form('Add player', '<label>Player name<input name="name" autocomplete="name" maxlength="40" required></label>',
    'Add player', values => update({ ...values, action: 'add', kickoff: state.game.kickoff }));
  if (action === 'swap-form') return form('Swap players', state.teams.map((side, i) => '<label>Team ' + ['A', 'B'][i] +
    '<select name="' + ['a', 'b'][i] + '">' + side.map(player => '<option value="' + player + '">' + esc(nameFor(player)) + '</option>').join('') +
    '</select></label>').join(''), 'Swap players', values => update({ ...values, action: 'swap' }));
  if (action === 'remove-form') return form('Remove ' + esc(nameFor(id)) + '?', '', 'Remove player', () => update({ action: 'remove', id }));
  if (action === 'copy-link') {
    const link = new URL('/', location.origin);
    link.searchParams.set('game', state.game.linkId);
    return copy(link.href, 'Game link copied.');
  }
  if (action === 'copy-teams') return copy('*' + state.game.title + '*\n' + date(state.game.kickoff) + ' · ' + state.game.venue + '\n///' + state.game.meetingPoint + ' · https://w3w.co/' + state.game.meetingPoint + '\n\n' +
    sides().map((names, i) => '*Team ' + ['A', 'B'][i] + '*\n' + names.join('\n')).join('\n\n'), 'Teams copied for WhatsApp.');
  if (action === 'ledger') return showLedger();
  if (action === 'record-payment') {
    const account = state.accounts[Number(id)];
    if (!account) return;
    const paymentId = crypto.randomUUID();
    return form('Record payment for ' + esc(account.name),
      '<label>Amount received (£)<input type="number" name="amount" min="0.01" max="10000" step="0.01" required></label>',
      'Record payment', async values => {
        const ok = await update({ action, key: account.key, id: paymentId, amount: Math.round(Number(values.amount) * 100) });
        if (ok) setTimeout(showLedger, 0);
        return ok;
      });
  }
  if (action === 'link-player') {
    const account = state.accounts[Number(id)];
    const targets = state.accounts.filter(entry => entry.phoneEnd);
    return form('Link records for ' + esc(account.name),
      '<p>Ask the player directly for the linking code shown under My payments. Linking gives them access to these records.</p>' +
      '<label>Player account<select name="target" required><option value="">Choose player</option>' +
      targets.map(entry => '<option value="' + esc(entry.key) + '">' + esc(entry.name + ' · ending ' + entry.phoneEnd) + '</option>').join('') +
      '</select></label><label>Player’s linking code<input name="linkCode" maxlength="12" required></label>', 'Link records', async values => {
        const ok = await update({ action, key: account.key, target: values.target, linkCode: values.linkCode });
        if (ok) setTimeout(showLedger, 0);
        return ok;
      });
  }
  if (action === 'undo-payment') {
    return form('Remove this payment entry?', '<p>The balance will be recalculated.</p>', 'Remove entry', async () => {
      const ok = await update({ action, id });
      if (ok) setTimeout(showLedger, 0);
      return ok;
    });
  }
  if (action === 'attendance') {
    const ok = await update({ action, id, kickoff: control.dataset.kickoff, played: control.dataset.played === 'true' });
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
  const accounts = state.accounts || [];
  const outstanding = accounts.reduce((sum, row) => sum + Math.max(0, row.charged - row.paid), 0);
  const pastGames = state.ledger.filter(row => row.kickoff !== state.game.kickoff && Date.parse(row.kickoff) <= Date.now());
  const payments = accounts.flatMap(account => account.payments.filter(payment => payment.id)).sort((a, b) => b.date.localeCompare(a.date));
  modal.innerHTML = '<h2 id="dialog-title">Player balances</h2><p><strong>' + money(outstanding) +
    ' outstanding</strong></p>' + (accounts.length ?
    '<div class="sheet"><table><thead><tr><th>Player</th><th>Games played</th><th>Total paid</th><th>Balance</th><th>Payment</th></tr></thead><tbody>' +
    accounts.map((row, index) => {
      const balance = row.charged - row.paid;
      return '<tr><td>' + esc(row.name + (row.phoneEnd ? ' · ending ' + row.phoneEnd : '')) + '</td><td>' + row.games + '</td><td>' + money(row.paid) + '</td><td>' +
        (balance > 0 ? money(balance) + ' owed' : balance < 0 ? money(-balance) + ' credit' : 'Settled') +
        '</td><td>' + button('Record payment', 'record-payment', 'small soft', index) +
        (!row.phoneEnd && accounts.some(a => a.phoneEnd) ? button('Link records', 'link-player', 'small quiet', index) : '') + '</td></tr>';
    }).join('') + '</tbody></table></div>' : '<p class="muted">Balances appear when players join.</p>') +
    (payments.length ? '<details><summary>Payment history</summary><ul class="list">' + payments.map(payment =>
      '<li class="row"><span>' + esc(payment.name) + ' · ' + money(payment.amount) + ' · ' + esc(date(payment.date)) + '</span>' +
      button('Remove entry', 'undo-payment', 'small quiet', payment.id) + '</li>').join('') + '</ul></details>' : '') +
    (pastGames.length ? '<details><summary>Past attendance</summary><ul class="list">' + pastGames.map(row =>
      '<li class="row"><span>' + esc(row.name) + ' · ' + esc(date(row.kickoff)) + ' · ' + (row.played === false ? 'Did not play' : 'Played') +
      '</span><button type="button" class="soft small" data-action="attendance" data-id="' + esc(row.id) +
      '" data-kickoff="' + esc(row.kickoff) + '" data-played="' + (row.played === false) + '">' +
      (row.played === false ? 'Mark played' : 'Mark absent') + '</button></li>').join('') + '</ul></details>' : '') +
    '<p class="dialog-status warning" role="alert"></p><div class="actions">' +
    (accounts.length ? button('Download CSV', 'ledger-csv') : '') +
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
  const pounds = pence => (pence / 100).toFixed(2);
  const csv = [['Full name','Games played','Charges GBP','Paid GBP','Owes GBP','Credit GBP'],
    ...state.accounts.map(row => [row.name, row.games, pounds(row.charged), pounds(row.paid),
      pounds(Math.max(0, row.charged - row.paid)), pounds(Math.max(0, row.paid - row.charged))])]
    .map(row => row.map(field).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'touchline-payment-sheet.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
