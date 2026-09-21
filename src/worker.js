import { nextOccurrence, normalizeRule, parseLocal, isValidTimeZone, naiveOf } from '../public/schedule.js';

const MAX_PER_RUN = 12;          // keeps a catch-up run well inside the free-plan subrequest limit
const LATE_AFTER_MS = 3 * 60e3;  // mark a send as "late" if it is this much past its time
const PRUNE_SENT_AFTER_MS = 30 * 86400e3;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, url);
    } catch (e) {
      console.error('api error', e);
      return json({ error: 'Server error' }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDue(env));
  },
};

// ---------- API ----------

async function handleApi(request, env, url) {
  if (!env.APP_TOKEN || !env.DISCORD_WEBHOOK_URL) {
    return json({ error: 'Server is missing the APP_TOKEN or DISCORD_WEBHOOK_URL secret' }, 500);
  }
  const auth = request.headers.get('Authorization') || '';
  if (!timingSafeEqual(auth, `Bearer ${env.APP_TOKEN}`)) return json({ error: 'Unauthorized' }, 401);

  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'reminders', id?]
  const resource = parts[1], id = parts[2];

  if (resource === 'reminders' && !id && request.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM reminders ORDER BY next_at IS NULL, next_at, last_fired_at DESC').all();
    return json(results.map(rowOut));
  }

  if (resource === 'reminders' && id && request.method === 'PUT') {
    if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: 'Bad id' }, 400);
    const body = await request.json().catch(() => null);
    const v = validate(body);
    if (v.error) return json({ error: v.error }, 400);
    const now = Date.now();
    const next_at = v.enabled ? computeNext(v.rule, v.start_local, v.tz, now) : null;
    if (v.enabled && v.rule.type === 'none' && next_at === null) return json({ error: 'That time has already passed' }, 400);
    await env.DB.prepare(`
      INSERT INTO reminders (id, title, start_local, tz, rule, enabled, next_at, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, start_local = excluded.start_local, tz = excluded.tz,
        rule = excluded.rule, enabled = excluded.enabled, next_at = excluded.next_at, ping = 0, updated_at = excluded.updated_at
    `).bind(id, v.title, v.start_local, v.tz, JSON.stringify(v.rule), v.enabled ? 1 : 0, next_at, now).run();
    const row = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(id).first();
    return json(rowOut(row));
  }

  if (resource === 'reminders' && id && request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM reminders WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }

  if (resource === 'test' && request.method === 'POST') {
    const r = await sendDiscord(env, 'Test notification. Reminders are set up correctly.');
    if (!r.ok) return json({ error: `Discord returned ${r.status}: ${r.detail}` }, 502);
    const idSet = !!(env.DISCORD_USER_ID || '').trim();
    return json({ ok: true, warning: idSet && !r.mentioned ? 'Sent, but DISCORD_USER_ID is not a valid Discord user ID, so you were not pinged.' : '' });
  }

  return json({ error: 'Not found' }, 404);
}

function validate(b) {
  if (!b || typeof b !== 'object') return { error: 'Bad request' };
  const title = String(b.title ?? '').trim();
  if (!title) return { error: 'Title is required' };
  if (title.length > 200) return { error: 'Title is too long' };
  if (parseLocal(b.start_local) === null) return { error: 'Bad date/time' };
  const tz = String(b.tz || '');
  if (!isValidTimeZone(tz)) return { error: 'Bad time zone' };
  const rule = normalizeRule(b.rule);
  if (!rule) return { error: 'Bad repeat rule' };
  return { title, start_local: b.start_local, tz, rule, enabled: b.enabled !== false };
}

// A one-time reminder set for "now" (within the last minute) still goes out on the next tick.
function computeNext(rule, startLocal, tz, now) {
  return nextOccurrence(rule, startLocal, tz, rule.type === 'none' ? now - 60e3 : now);
}

function rowOut(r) {
  return { ...r, rule: JSON.parse(r.rule), enabled: r.enabled === 1 };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ba = enc.encode(a), bb = enc.encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

// ---------- Scheduler (runs every minute) ----------

async function runDue(env) {
  if (!env.DISCORD_WEBHOOK_URL) { console.error('DISCORD_WEBHOOK_URL not set'); return; }
  const now = Date.now();
  const { results } = await env.DB
    .prepare('SELECT * FROM reminders WHERE enabled = 1 AND next_at IS NOT NULL AND next_at <= ? ORDER BY next_at LIMIT ?')
    .bind(now, MAX_PER_RUN).all();

  // Each occurrence is sent PINGS times, one minute apart, so a single missed buzz is not the end of it.
  const pings = Math.max(1, parseInt(env.PINGS, 10) || 1);

  for (const row of results) {
    const rule = JSON.parse(row.rule);
    const ping = row.ping + 1; // the ping number this send is (1-based)
    let next, nextPing, fired = row.last_fired_at;
    if (ping < pings) {
      next = row.next_at + 60e3;
      nextPing = ping;
    } else {
      // Burst finished. If several occurrences were missed (outage), skip to the next future one.
      next = rule.type === 'none' ? null : nextOccurrence(rule, row.start_local, row.tz, Math.max(now, row.next_at));
      nextPing = 0;
    }
    if (ping === 1) fired = now;

    // Claim atomically: only the run that changes the row sends. Prevents duplicates.
    const claim = await env.DB
      .prepare('UPDATE reminders SET next_at = ?, ping = ?, last_fired_at = ?, updated_at = ? WHERE id = ? AND next_at = ? AND ping = ?')
      .bind(next, nextPing, fired, now, row.id, row.next_at, row.ping).run();
    if (!claim.meta.changes) continue;

    const r = await sendDiscord(env, messageFor(row, now, ping, pings));
    if (!r.ok) {
      console.error(`send failed for ${row.id}: ${r.status} ${r.detail}`);
      // Put it back so the next minute retries. A late reminder beats a lost one.
      await env.DB
        .prepare('UPDATE reminders SET next_at = ?, ping = ?, last_fired_at = ? WHERE id = ? AND next_at IS ? AND ping = ?')
        .bind(row.next_at, row.ping, row.last_fired_at, row.id, next, nextPing).run();
    }
  }

  // One-time reminders that were sent long ago are not useful to keep around.
  await env.DB
    .prepare(`DELETE FROM reminders WHERE next_at IS NULL AND last_fired_at IS NOT NULL AND last_fired_at < ? AND json_extract(rule, '$.type') = 'none'`)
    .bind(now - PRUNE_SENT_AFTER_MS).run();
}

function messageFor(row, now, ping, pings) {
  let text = row.title;
  if (ping > 1) return `${text} (${ping}/${pings})`;
  if (now - row.next_at > LATE_AFTER_MS) {
    const due = new Date(naiveOf(row.next_at, row.tz));
    const today = new Date(naiveOf(now, row.tz));
    const hhmm = `${String(due.getUTCHours()).padStart(2, '0')}:${String(due.getUTCMinutes()).padStart(2, '0')}`;
    const sameDay = due.getUTCFullYear() === today.getUTCFullYear() && due.getUTCMonth() === today.getUTCMonth() && due.getUTCDate() === today.getUTCDate();
    text += sameDay ? ` (was due ${hhmm}, sent late)` : ` (was due ${due.getUTCDate()}/${due.getUTCMonth() + 1} ${hhmm}, sent late)`;
  }
  return text;
}

// Plain text is what shows up in the push notification on the phone, so no markdown or embeds.
// The mention is optional; a bad DISCORD_USER_ID must never stop a reminder from going out,
// so an ID that does not look like a Discord ID is ignored, and a 400 is retried without it.
async function sendDiscord(env, text) {
  const userId = (env.DISCORD_USER_ID || '').trim();
  const mention = /^\d{15,22}$/.test(userId) ? userId : '';
  const payload = mention => ({
    content: mention ? `${text}\n<@${mention}>` : text,
    allowed_mentions: { parse: [], users: mention ? [mention] : [] },
    ...(env.APP_URL ? { avatar_url: `${env.APP_URL}/icon-512.png` } : {}),
  });
  try {
    let res = await post(env.DISCORD_WEBHOOK_URL, payload(mention));
    if (res.status === 400 && mention) res = await post(env.DISCORD_WEBHOOK_URL, payload(''));
    if (res.ok) return { ok: true, mentioned: !!mention };
    return { ok: false, status: res.status, detail: (await res.text()).slice(0, 200) };
  } catch (e) {
    return { ok: false, status: 0, detail: String(e) };
  }
}

function post(url, body) {
  return fetch(`${url}?wait=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
