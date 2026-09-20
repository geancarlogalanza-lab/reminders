// Recurrence + time zone math shared by the Worker (server) and the page (client).
// All "naive" values are wall-clock date-times encoded with Date.UTC(), i.e. no
// zone applied. Real instants are epoch milliseconds (UTC).

const DAY = 86400000;
const fmtCache = new Map();

function fmt(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

// Wall clock in `tz` at instant `utcMs`, as a naive value.
export function naiveOf(utcMs, tz) {
  const p = {};
  for (const { type, value } of fmt(tz).formatToParts(new Date(utcMs))) p[type] = value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
}

// Instant at which the wall clock in `tz` reads `naive`.
export function toUtc(naive, tz) {
  const off1 = naiveOf(naive, tz) - naive;
  let utc = naive - off1;
  const off2 = naiveOf(utc, tz) - utc;
  if (off2 !== off1) utc = naive - off2;
  return utc;
}

export function isValidTimeZone(tz) {
  try { fmt(tz); return true; } catch { return false; }
}

// "2026-09-21T09:00" -> naive ms
export function parseLocal(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s || '');
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return Number.isFinite(t) ? t : null;
}

function addMonths(naive, n) {
  const d = new Date(naive);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n, day = d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(day, last), d.getUTCHours(), d.getUTCMinutes());
}

function monthsBetween(a, b) {
  const da = new Date(a), db = new Date(b);
  return (db.getUTCFullYear() - da.getUTCFullYear()) * 12 + (db.getUTCMonth() - da.getUTCMonth());
}

// Validate and normalise a rule object. Returns null if invalid.
export function normalizeRule(r) {
  if (!r || typeof r !== 'object') return null;
  switch (r.type) {
    case 'none': case 'daily': case 'weekly': case 'monthly': case 'yearly':
      return { type: r.type };
    case 'weekdays': {
      const days = [...new Set((r.days || []).map(Number))].filter(d => d >= 0 && d <= 6 && Number.isInteger(d)).sort();
      return days.length ? { type: 'weekdays', days } : null;
    }
    case 'custom': {
      const every = Number(r.every);
      if (!Number.isInteger(every) || every < 1 || every > 999) return null;
      if (!['day', 'week', 'month'].includes(r.unit)) return null;
      return { type: 'custom', every, unit: r.unit };
    }
    default: return null;
  }
}

// First occurrence strictly after `afterMs`, or null if none.
export function nextOccurrence(rule, startLocal, tz, afterMs) {
  const start = parseLocal(startLocal);
  if (start === null) return null;
  const type = rule.type;

  if (type === 'none') {
    const t = toUtc(start, tz);
    return t > afterMs ? t : null;
  }

  const afterNaive = naiveOf(afterMs, tz);

  if (type === 'weekdays') {
    const tod = start - Math.floor(start / DAY) * DAY;
    const base = Math.max(Math.floor(start / DAY), Math.floor(afterNaive / DAY) - 1) * DAY;
    for (let i = 0; i < 16; i++) {
      const cand = base + i * DAY + tod;
      if (cand < start) continue;
      if (!rule.days.includes(new Date(cand).getUTCDay())) continue;
      const u = toUtc(cand, tz);
      if (u > afterMs) return u;
    }
    return null;
  }

  // Fixed-step rules: candidate k -> naive
  let gen, k;
  const stepDays = type === 'daily' ? 1 : type === 'weekly' ? 7
    : type === 'custom' && rule.unit === 'day' ? rule.every
    : type === 'custom' && rule.unit === 'week' ? rule.every * 7 : 0;
  if (stepDays) {
    gen = k => start + k * stepDays * DAY;
    k = Math.max(0, Math.floor((afterNaive - start) / (stepDays * DAY)) - 1);
  } else {
    const stepMonths = type === 'monthly' ? 1 : type === 'yearly' ? 12 : rule.every;
    gen = k => addMonths(start, k * stepMonths);
    k = Math.max(0, Math.floor(monthsBetween(start, afterNaive) / stepMonths) - 1);
  }
  for (let i = 0; i < 8; i++, k++) {
    const u = toUtc(gen(k), tz);
    if (u > afterMs) return u;
  }
  return null;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Human description of a rule, e.g. "Every week on Monday".
export function describeRule(rule, startLocal) {
  const start = parseLocal(startLocal);
  const d = start === null ? new Date() : new Date(start);
  switch (rule.type) {
    case 'none': return 'Once';
    case 'daily': return 'Every day';
    case 'weekly': return `Every ${DAY_NAMES[d.getUTCDay()]}`;
    case 'monthly': return `Monthly on the ${ordinal(d.getUTCDate())}`;
    case 'yearly': return `Yearly on ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
    case 'weekdays':
      if (rule.days.length === 7) return 'Every day';
      if (rule.days.join() === '1,2,3,4,5') return 'Weekdays';
      if (rule.days.join() === '0,6') return 'Weekends';
      return rule.days.map(x => DAY_NAMES[x]).join(', ');
    case 'custom': {
      const unit = rule.unit + (rule.every === 1 ? '' : 's');
      return rule.every === 1 ? `Every ${rule.unit}` : `Every ${rule.every} ${unit}`;
    }
    default: return '';
  }
}
