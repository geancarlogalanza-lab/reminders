// Runs the Worker locally in Node without Cloudflare (for when `wrangler dev` is not an option):
// Node's built-in SQLite stands in for D1, static files are served from ./public, the cron
// handler runs every minute, and Discord is mocked at /__discord (payloads are printed).
//   node dev-local.mjs            -> http://localhost:8787   (token: "dev")
//   curl -X POST localhost:8787/__scheduled    -> run the cron handler now
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from './src/worker.js';

const PORT = Number(process.env.PORT || 8787);
const db = new DatabaseSync(process.env.DB_FILE || ':memory:');
db.exec(readFileSync('schema.sql', 'utf8'));

const DB = {
  prepare(sql) {
    const st = db.prepare(sql);
    let args = [];
    return {
      bind(...a) { args = a.map(v => (v === undefined ? null : v)); return this; },
      async all() { return { results: st.all(...args) }; },
      async first() { return st.get(...args) ?? null; },
      async run() { const r = st.run(...args); return { meta: { changes: r.changes } }; },
    };
  },
};

const TYPES = { html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', webmanifest: 'application/manifest+json' };
const ASSETS = {
  async fetch(request) {
    let path = new URL(request.url).pathname;
    if (path === '/') path = '/index.html';
    const file = `public${path}`;
    if (!existsSync(file)) return new Response('Not found', { status: 404 });
    return new Response(readFileSync(file), { headers: { 'content-type': TYPES[path.split('.').pop()] || 'application/octet-stream' } });
  },
};

const env = {
  DB, ASSETS,
  APP_TOKEN: process.env.APP_TOKEN || 'dev',
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || `http://127.0.0.1:${PORT}/__discord`,
  DISCORD_USER_ID: process.env.DISCORD_USER_ID || '',
};
const ctx = { waitUntil: p => p.catch(e => console.error('scheduled failed', e)) };
const runCron = () => worker.scheduled({ scheduledTime: Date.now() }, env, ctx);

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const url = `http://localhost:${PORT}${req.url}`;

  if (req.url.startsWith('/__discord')) {
    console.log('[discord]', JSON.parse(body.toString()).content.replace(/\n/g, ' | '));
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    return;
  }
  if (req.url === '/__scheduled') {
    await runCron();
    res.writeHead(200).end('ran\n');
    return;
  }
  const request = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
  const out = await worker.fetch(request, env, ctx);
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
}).listen(PORT, () => console.log(`local app on http://localhost:${PORT}  (token: ${env.APP_TOKEN})`));

// tick on the minute, like Cron Triggers do
setTimeout(() => { runCron(); setInterval(runCron, 60_000); }, 60_000 - (Date.now() % 60_000));
