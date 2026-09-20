import { nextOccurrence, describeRule, normalizeRule, parseLocal, toUtc } from './schedule.js';

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const LS = { token: 'rm.token', cache: 'rm.cache', queue: 'rm.queue' };
const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

const $app = document.getElementById('app');
const $banner = document.getElementById('banner');
const $settings = document.getElementById('settings');
const $settingsBtn = document.getElementById('settings-btn');

const state = {
  token: localStorage.getItem(LS.token) || '',
  reminders: load(LS.cache, []),
  queue: load(LS.queue, []),     // writes waiting to reach the server, in order
  editing: null,                 // id of the reminder whose row is an edit form
  offline: !navigator.onLine,
  notice: '',                    // last server-side rejection, shown under the composer
  testResult: '',
};

function load(k, fallback) {
  try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; }
}
function persist() {
  localStorage.setItem(LS.cache, JSON.stringify(state.reminders));
  localStorage.setItem(LS.queue, JSON.stringify(state.queue));
}

// ---------- server ----------

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { Authorization: `Bearer ${state.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw { network: true };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw { status: res.status, error: data.error || `HTTP ${res.status}` };
  return data;
}

let syncing = false;
// Push queued writes, then pull the list. Safe to call often.
async function sync() {
  if (syncing || !state.token) return;
  syncing = true;
  try {
    while (state.queue.length) {
      const op = state.queue[0];
      try {
        await api(op.method, op.path, op.body);
      } catch (e) {
        if (e.network) { setOffline(true); return; }
        if (e.status === 401) { signOut('That access token was not accepted.'); return; }
        state.notice = e.error; // rejected for a reason (e.g. time already passed); drop it
      }
      state.queue.shift();
      persist();
    }
    const list = await api('GET', '/api/reminders');
    state.reminders = list;
    for (const op of state.queue) applyOp(op); // anything queued while we were pulling
    persist();
    setOffline(false);
  } catch (e) {
    if (e.network) setOffline(true);
    else if (e.status === 401) signOut('That access token was not accepted.');
    else state.notice = e.error;
  } finally {
    syncing = false;
    renderList();
    renderNotice();
    if (state.queue.length && !state.offline) sync();
  }
}

function setOffline(v) {
  state.offline = v;
  renderBanner();
}

// Optimistic local version of a queued write.
function applyOp(op) {
  if (op.method === 'DELETE') {
    state.reminders = state.reminders.filter(r => r.id !== op.id);
    return;
  }
  const b = op.body;
  const i = state.reminders.findIndex(r => r.id === op.id);
  const prev = i >= 0 ? state.reminders[i] : {};
  const after = b.rule.type === 'none' ? Date.now() - 60e3 : Date.now();
  const next_at = b.enabled ? nextOccurrence(b.rule, b.start_local, b.tz, after) : null;
  const merged = { ...prev, ...b, id: op.id, next_at, last_fired_at: prev.last_fired_at ?? null };
  if (i >= 0) state.reminders[i] = merged; else state.reminders.push(merged);
}

function enqueue(op) {
  state.queue = state.queue.filter(q => q.id !== op.id); // one pending write per reminder
  state.queue.push(op);
  applyOp(op);
  persist();
  renderList();
  renderBanner();
  sync();
}

function saveReminder(id, body) {
  enqueue({ method: 'PUT', path: `/api/reminders/${id}`, id, body });
}
function deleteReminder(id) {
  enqueue({ method: 'DELETE', path: `/api/reminders/${id}`, id });
}

function signOut(message) {
  localStorage.clear();
  Object.assign(state, { token: '', reminders: [], queue: [], editing: null, notice: message || '' });
  $settings.hidden = true;
  $settingsBtn.setAttribute('aria-expanded', 'false');
  render();
}

// ---------- formatting ----------

function fmtTime(d) {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function whenLabel(ms) {
  const d = new Date(ms), now = new Date();
  if (ms <= Date.now()) return 'Now';
  const dayStart = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((dayStart(d) - dayStart(now)) / 864e5);
  const t = fmtTime(d);
  if (days === 0) return `Today ${t}`;
  if (days === 1) return `Tomorrow ${t}`;
  if (days < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
  const opts = { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) };
  return `${d.toLocaleDateString([], opts)} ${t}`;
}
function pastLabel(ms) {
  const d = new Date(ms), now = new Date();
  const opts = { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) };
  return `${d.toLocaleDateString([], opts)} ${fmtTime(d)}`;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pad(n) { return String(n).padStart(2, '0'); }

// ---------- form (create + edit) ----------

function defaultStart() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formHTML(r) {
  const isEdit = !!r;
  const start = r ? r.start_local : defaultStart();
  const [date, time] = start.split('T');
  const rule = r ? r.rule : { type: 'none' };
  const days = rule.days || [new Date(parseLocal(start)).getUTCDay()];
  const opt = (v, label) => `<option value="${v}"${rule.type === v ? ' selected' : ''}>${label}</option>`;
  return `
    <form class="composer" data-id="${r ? r.id : ''}" data-tz="${esc(r ? r.tz : TZ)}" autocomplete="off">
      <input type="text" name="title" placeholder="Remind me to…" maxlength="200" required
             value="${r ? esc(r.title) : ''}" ${isEdit ? '' : 'autofocus'}>
      <div class="row">
        <input type="date" name="date" value="${date}" required>
        <input type="time" name="time" value="${time}" required>
        <select name="repeat" aria-label="Repeat">
          ${opt('none', 'Once')}
          ${opt('daily', 'Every day')}
          ${opt('weekly', 'Every week')}
          ${opt('monthly', 'Every month')}
          ${opt('yearly', 'Every year')}
          ${opt('weekdays', 'Days of the week')}
          ${opt('custom', 'Custom interval')}
        </select>
      </div>
      <div class="days" ${rule.type === 'weekdays' ? '' : 'hidden'}>
        ${DAY_LETTERS.map((l, i) => `<button type="button" data-day="${i}" aria-pressed="${days.includes(i)}" aria-label="${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][i]}">${l}</button>`).join('')}
      </div>
      <div class="custom" ${rule.type === 'custom' ? '' : 'hidden'}>
        <span>Every</span>
        <input type="number" name="every" min="1" max="999" value="${rule.every || 1}" aria-label="Interval">
        <select name="unit" aria-label="Unit">
          <option value="day"${rule.unit === 'day' ? ' selected' : ''}>days</option>
          <option value="week"${rule.unit === 'week' ? ' selected' : ''}>weeks</option>
          <option value="month"${rule.unit === 'month' ? ' selected' : ''}>months</option>
        </select>
      </div>
      <p class="error" hidden></p>
      <div class="actions">
        <button type="submit" class="btn primary">${isEdit ? 'Save' : 'Add reminder'}</button>
        ${isEdit ? '<button type="button" class="btn" data-action="cancel">Cancel</button><span class="spacer"></span><button type="button" class="btn danger" data-action="delete">Delete</button>' : ''}
      </div>
    </form>`;
}

function readForm(form) {
  const fd = new FormData(form);
  const title = String(fd.get('title') || '').trim();
  const date = fd.get('date'), time = String(fd.get('time') || '').slice(0, 5);
  if (!title) throw 'Type what to remind you about.';
  if (!date || !time) throw 'Pick a date and time.';
  const start_local = `${date}T${time}`;
  if (parseLocal(start_local) === null) throw 'Pick a date and time.';
  const type = fd.get('repeat');
  let rule = { type };
  if (type === 'weekdays') rule.days = [...form.querySelectorAll('.days [aria-pressed="true"]')].map(b => +b.dataset.day);
  if (type === 'custom') { rule.every = Number(fd.get('every')); rule.unit = fd.get('unit'); }
  rule = normalizeRule(rule);
  if (!rule) throw type === 'weekdays' ? 'Pick at least one day.' : 'Check the repeat settings.';
  const tz = form.dataset.tz || TZ;
  if (rule.type === 'none' && toUtc(parseLocal(start_local), tz) <= Date.now() - 60e3) throw 'That time has already passed.';
  return { title, start_local, tz, rule };
}

function wireForm(form, onDone) {
  const err = form.querySelector('.error');
  form.addEventListener('click', e => {
    const day = e.target.closest('.days button');
    if (day) { day.setAttribute('aria-pressed', day.getAttribute('aria-pressed') !== 'true'); return; }
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'cancel') onDone(null);
    if (action === 'delete') onDone('delete');
  });
  form.addEventListener('change', e => {
    if (e.target.name === 'repeat') {
      form.querySelector('.days').hidden = e.target.value !== 'weekdays';
      form.querySelector('.custom').hidden = e.target.value !== 'custom';
    }
  });
  form.addEventListener('submit', e => {
    e.preventDefault();
    try {
      const body = readForm(form);
      err.hidden = true;
      onDone(body);
    } catch (msg) {
      err.textContent = msg;
      err.hidden = false;
    }
  });
}

// ---------- views ----------

function render() {
  if (!state.token) {
    $app.innerHTML = `
      <div class="setup">
        <p>Enter the access token you chose when deploying the app (the APP_TOKEN secret). You only do this once per device.</p>
        <form id="setup-form" class="setup">
          <input type="password" name="token" placeholder="Access token" required autofocus>
          <button class="btn primary" type="submit">Continue</button>
        </form>
        <p class="error" ${state.notice ? '' : 'hidden'}>${esc(state.notice)}</p>
      </div>`;
    $app.querySelector('#setup-form').addEventListener('submit', e => {
      e.preventDefault();
      state.token = new FormData(e.target).get('token').trim();
      state.notice = '';
      localStorage.setItem(LS.token, state.token);
      render();
      sync();
    });
    renderBanner();
    return;
  }

  $app.innerHTML = `
    <div id="composer"></div>
    <p id="notice" class="error" hidden></p>
    <div id="list"></div>`;
  mountComposer();
  renderList();
  renderNotice();
  renderBanner();
}

function mountComposer() {
  const host = document.getElementById('composer');
  host.innerHTML = formHTML(null);
  const form = host.querySelector('form');
  wireForm(form, body => {
    state.notice = '';
    saveReminder(crypto.randomUUID(), { ...body, enabled: true });
    mountComposer(); // fresh, empty form
    host.querySelector('input[name=title]').focus();
  });
}

function renderNotice() {
  const el = document.getElementById('notice');
  if (!el) return;
  el.textContent = state.notice;
  el.hidden = !state.notice;
}

function renderBanner() {
  const pending = state.queue.length;
  if (state.offline) {
    $banner.textContent = pending
      ? `Offline. ${pending} change${pending === 1 ? '' : 's'} will be saved when you are back online.`
      : 'Offline. Showing your last saved reminders.';
    $banner.hidden = false;
  } else {
    $banner.hidden = true;
  }
}

function renderList() {
  const host = document.getElementById('list');
  if (!host || state.editing) return; // do not yank an open edit form out from under the user

  const now = Date.now();
  const upcoming = state.reminders.filter(r => r.enabled && r.next_at !== null).sort((a, b) => a.next_at - b.next_at);
  const paused = state.reminders.filter(r => !r.enabled).sort((a, b) => a.title.localeCompare(b.title));
  const sent = state.reminders.filter(r => r.enabled && r.next_at === null && r.last_fired_at).sort((a, b) => b.last_fired_at - a.last_fired_at);

  const row = (r, kind) => {
    const repeating = r.rule.type !== 'none';
    let meta;
    if (kind === 'sent') meta = `Sent ${pastLabel(r.last_fired_at)}`;
    else if (kind === 'paused') meta = `Paused · ${describeRule(r.rule, r.start_local)}`;
    else meta = whenLabel(r.next_at) + (repeating ? ` · ${describeRule(r.rule, r.start_local)}` : '');
    if (r.tz !== TZ) meta += ` · ${r.tz}`;
    const cls = ['item', kind !== 'upcoming' ? 'dim' : '', kind === 'upcoming' && r.next_at <= now ? 'due' : ''].join(' ');
    return `
      <li class="${cls}" data-id="${r.id}">
        <button type="button" class="item-main" data-edit="${r.id}">
          <div class="title">${esc(r.title)}</div>
          <div class="meta">${esc(meta)}</div>
        </button>
        ${repeating ? `<label class="switch" title="${r.enabled ? 'Pause' : 'Resume'}"><input type="checkbox" data-toggle="${r.id}" ${r.enabled ? 'checked' : ''} aria-label="Enabled"><span class="knob"></span></label>` : ''}
      </li>`;
  };

  host.innerHTML = `
    <h2>Upcoming</h2>
    ${upcoming.length ? `<ul class="list">${upcoming.map(r => row(r, 'upcoming')).join('')}</ul>` : '<p class="empty">Nothing scheduled.</p>'}
    ${paused.length ? `<h2>Paused</h2><ul class="list">${paused.map(r => row(r, 'paused')).join('')}</ul>` : ''}
    ${sent.length ? `<h2>Sent</h2><ul class="list">${sent.map(r => row(r, 'sent')).join('')}</ul>` : ''}`;
}

function openEdit(id) {
  const r = state.reminders.find(x => x.id === id);
  const li = document.querySelector(`.item[data-id="${id}"]`);
  if (!r || !li) return;
  state.editing = id;
  li.className = 'item editing';
  li.innerHTML = formHTML(r);
  const form = li.querySelector('form');
  wireForm(form, result => {
    state.editing = null;
    if (result === 'delete') deleteReminder(id);
    else if (result) { state.notice = ''; saveReminder(id, { ...result, enabled: r.enabled }); }
    else renderList();
  });
  form.querySelector('input[name=title]').focus();
}

function toggle(id, enabled) {
  const r = state.reminders.find(x => x.id === id);
  if (!r) return;
  saveReminder(id, { title: r.title, start_local: r.start_local, tz: r.tz, rule: r.rule, enabled });
}

function renderSettings() {
  $settings.innerHTML = `
    <div class="panel">
      <div class="line">
        <div>
          <div>Discord notifications</div>
          <div class="muted" id="test-result">${esc(state.testResult || 'Send a test message to check the setup.')}</div>
        </div>
        <button type="button" class="btn" id="test-btn">Send test</button>
      </div>
      <div class="line">
        <div class="muted">Times are shown in ${esc(TZ)}. Reminders keep the time zone they were created in.</div>
      </div>
      <div class="line">
        <div class="muted">Forget the access token on this device.</div>
        <button type="button" class="btn" id="signout-btn">Sign out</button>
      </div>
    </div>`;
  $settings.querySelector('#test-btn').addEventListener('click', async e => {
    e.target.disabled = true;
    state.testResult = 'Sending…';
    renderSettings();
    try { const r = await api('POST', '/api/test'); state.testResult = r.warning || 'Sent. Check Discord on your phone.'; }
    catch (err) { state.testResult = err.network ? 'You are offline.' : err.error; }
    renderSettings();
  });
  $settings.querySelector('#signout-btn').addEventListener('click', () => signOut());
}

// ---------- events ----------

$app.addEventListener('click', e => {
  const edit = e.target.closest('[data-edit]');
  if (edit && !state.editing) openEdit(edit.dataset.edit);
});
$app.addEventListener('change', e => {
  if (e.target.dataset.toggle) toggle(e.target.dataset.toggle, e.target.checked);
});
$settingsBtn.addEventListener('click', () => {
  if (!state.token) return;
  const open = $settings.hidden;
  $settings.hidden = !open;
  $settingsBtn.setAttribute('aria-expanded', String(open));
  if (open) renderSettings();
});
window.addEventListener('online', () => { setOffline(false); sync(); });
window.addEventListener('offline', () => setOffline(true));
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
// Relative labels ("Today", "Now") drift; refresh them occasionally.
setInterval(() => { if (!state.editing) renderList(); }, 60e3);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');

render();
sync();
