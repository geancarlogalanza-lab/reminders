// Scheduler behaviour tests: run with `node test-worker.mjs`
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from './src/worker.js';

const db = new DatabaseSync(':memory:');
db.exec(readFileSync('schema.sql', 'utf8'));
const DB = {
  prepare(sql) {
    const st = db.prepare(sql); let args = [];
    return {
      bind(...a) { args = a.map(v => (v === undefined ? null : v)); return this; },
      async all() { return { results: st.all(...args) }; },
      async first() { return st.get(...args) ?? null; },
      async run() { const r = st.run(...args); return { meta: { changes: r.changes } }; },
    };
  },
};

let sent = [], discordStatus = 200;
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('https://discord.test/')) throw new Error('unexpected fetch ' + url);
  sent.push(JSON.parse(init.body));
  return new Response(discordStatus === 200 ? '{}' : 'nope', { status: discordStatus });
};
const env = { DB, APP_TOKEN: 't', DISCORD_WEBHOOK_URL: 'https://discord.test/hook', DISCORD_USER_ID: '123456789012345678' };
const tick = () => new Promise(res => worker.scheduled({}, env, { waitUntil: p => p.then(res, e => { throw e; }) }));
const row = id => db.prepare('SELECT * FROM reminders WHERE id = ?').get(id);
const insert = (id, title, start_local, rule, next_at) =>
  db.prepare('INSERT INTO reminders (id,title,start_local,tz,rule,enabled,next_at,created_at,updated_at) VALUES (?,?,?,?,?,1,?,0,0)')
    .run(id, title, start_local, 'Europe/Berlin', JSON.stringify(rule), next_at);

let fails = 0;
const ok = (name, cond, extra = '') => { if (!cond) fails++; console.log((cond ? 'ok   ' : 'FAIL ') + name, extra); };
const now = Date.now(), DAY = 86400e3;

// 1) daily reminder whose last 3 occurrences were missed: sends once, marked late, next is in the future
insert('a', 'Stretch', '2026-01-01T09:00', { type: 'daily' }, now - 3 * DAY);
await tick();
ok('missed daily sent once', sent.length === 1, sent[0]?.content);
ok('late marker present', /sent late/.test(sent[0]?.content));
ok('mention appended', sent[0]?.content.endsWith('<@123456789012345678>') && sent[0].allowed_mentions.users[0] === '123456789012345678');
ok('next is in the future, not a catch-up', row('a').next_at > now && row('a').next_at < now + DAY);
ok('last_fired_at set', row('a').last_fired_at >= now);

// 2) second tick right away: nothing to send
sent = [];
await tick();
ok('no duplicate on next tick', sent.length === 0);

// 3) one-time reminder due now: sent, then next_at cleared (moves to "Sent")
insert('b', 'Pay rent', '2026-09-21T09:00', { type: 'none' }, now - 10e3);
await tick();
ok('one-time sent on time (no late marker)', sent.length === 1 && sent[0].content === 'Pay rent\n<@123456789012345678>');
ok('one-time cleared', row('b').next_at === null && row('b').last_fired_at !== null);

// 4) Discord down: reminder is put back and retried on a later tick
sent = []; discordStatus = 500;
insert('c', 'Feed cat', '2026-01-01T18:00', { type: 'daily' }, now - 5e3);
await tick();
ok('attempted while down', sent.length === 1);
ok('rolled back so it is still due', row('c').next_at === now - 5e3 && row('c').last_fired_at === null);
discordStatus = 200; sent = [];
await tick();
ok('retried after recovery', sent.length === 1 && sent[0].content.startsWith('Feed cat'));
ok('advanced after success', row('c').next_at > now);

// 5) disabled reminders are ignored
db.prepare('UPDATE reminders SET enabled = 0, next_at = NULL WHERE id = ?').run('a');
sent = [];
await tick();
ok('disabled ignored', sent.length === 0);

// 6) old sent one-time reminders are pruned after 30 days, repeating ones never are
db.prepare('UPDATE reminders SET last_fired_at = ? WHERE id = ?').run(now - 31 * DAY, 'b');
await tick();
ok('old sent one-time pruned', row('b') === undefined);
ok('repeating kept', row('a') !== undefined && row('c') !== undefined);

// 7) API round trip: PUT computes next_at, GET lists, DELETE removes
const put = await worker.fetch(new Request('http://x/api/reminders/12345678-1234-4123-8123-123456789abc', {
  method: 'PUT', headers: { Authorization: 'Bearer t', 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Dentist', start_local: '2030-05-05T10:00', tz: 'Europe/Berlin', rule: { type: 'none' } }),
}), env, {});
const putBody = await put.json();
ok('PUT ok', put.status === 200 && putBody.next_at === Date.UTC(2030, 4, 5, 8, 0), JSON.stringify(putBody.next_at));
const bad = await worker.fetch(new Request('http://x/api/reminders/12345678-1234-4123-8123-123456789abc', {
  method: 'PUT', headers: { Authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: '{}',
}), env, {});
ok('wrong token rejected', bad.status === 401);
const del = await worker.fetch(new Request('http://x/api/reminders/12345678-1234-4123-8123-123456789abc', { method: 'DELETE', headers: { Authorization: 'Bearer t' } }), env, {});
ok('DELETE ok', del.status === 200 && row('12345678-1234-4123-8123-123456789abc') === undefined);


// 8) mention handling: bad DISCORD_USER_ID is ignored; a 400 with a mention is retried without it
sent = [];
env.DISCORD_USER_ID = 'not-an-id';
insert('m1', 'Ping', '2026-01-01T09:00', { type: 'none' }, now - 1000);
await tick();
ok('bad user id ignored', sent.length === 1 && sent[0].content === 'Ping' && sent[0].allowed_mentions.users.length === 0);
env.DISCORD_USER_ID = '1265554293738438767';
sent = []; let calls = 0; const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => { calls++; const body = JSON.parse(init.body); sent.push(body); return new Response(body.allowed_mentions.users.length ? '{"allowed_mentions":["users"]}' : '{}', { status: body.allowed_mentions.users.length ? 400 : 200 }); };
insert('m2', 'Pong', '2026-01-01T09:00', { type: 'none' }, now - 1000);
await tick();
ok('400 on mention retried without it', calls === 2 && sent[1].content === 'Pong' && row('m2').next_at === null);
globalThis.fetch = realFetch;
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
