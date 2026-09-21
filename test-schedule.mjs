import { nextOccurrence, toUtc, naiveOf, parseLocal, describeRule, normalizeRule } from './public/schedule.js';
let fails = 0;
const iso = (ms, tz) => new Date(ms).toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T');
function eq(name, got, want) { if (got !== want) { fails++; console.log('FAIL', name, '\n  got ', got, '\n  want', want); } else console.log('ok  ', name); }
const at = (s, tz) => toUtc(parseLocal(s), tz);
const B = 'Europe/Berlin', NY = 'America/New_York', T = 'Asia/Tokyo';

// basic conversions
eq('berlin summer', iso(at('2026-07-01T09:00', B), B), '2026-07-01T09:00:00');
eq('berlin winter', iso(at('2026-12-01T09:00', B), B), '2026-12-01T09:00:00');
eq('utc offset summer', at('2026-07-01T09:00', B), Date.UTC(2026, 6, 1, 7, 0));
eq('utc offset winter', at('2026-12-01T09:00', B), Date.UTC(2026, 11, 1, 8, 0));
// daily across the EU DST change (2026-10-25): keeps 09:00 wall clock
const startDaily = '2026-10-24T09:00';
let n = nextOccurrence({ type: 'daily' }, startDaily, B, at('2026-10-24T09:00', B));
eq('daily next after start', iso(n, B), '2026-10-25T09:00:00');
n = nextOccurrence({ type: 'daily' }, startDaily, B, n);
eq('daily after dst', iso(n, B), '2026-10-26T09:00:00');
eq('dst day is 25h long', at('2026-10-25T09:00', B) - at('2026-10-24T09:00', B), 25 * 3600e3);
// one-time
eq('once future', nextOccurrence({ type: 'none' }, '2027-01-01T00:00', T, Date.now()), at('2027-01-01T00:00', T));
eq('once past', nextOccurrence({ type: 'none' }, '2020-01-01T00:00', T, Date.now()), null);
// weekly, far in the future from an old start
n = nextOccurrence({ type: 'weekly' }, '2020-01-06T08:30', NY, at('2026-09-21T08:30', NY)); // Mon
eq('weekly from old start', iso(n, NY), '2026-09-28T08:30:00');
n = nextOccurrence({ type: 'weekly' }, '2020-01-06T08:30', NY, at('2026-09-21T08:29', NY));
eq('weekly same day still due', iso(n, NY), '2026-09-21T08:30:00');
// monthly with clamping: start Jan 31 -> Feb 28 -> Mar 31
n = nextOccurrence({ type: 'monthly' }, '2026-01-31T10:00', B, at('2026-02-01T00:00', B));
eq('monthly clamp feb', iso(n, B), '2026-02-28T10:00:00');
n = nextOccurrence({ type: 'monthly' }, '2026-01-31T10:00', B, n);
eq('monthly back to 31', iso(n, B), '2026-03-31T10:00:00');
// yearly leap day
n = nextOccurrence({ type: 'yearly' }, '2024-02-29T12:00', B, at('2024-03-01T00:00', B));
eq('yearly leap -> feb 28', iso(n, B), '2025-02-28T12:00:00');
n = nextOccurrence({ type: 'yearly' }, '2024-02-29T12:00', B, at('2027-03-01T00:00', B));
eq('yearly leap -> 2028', iso(n, B), '2028-02-29T12:00:00');
// weekdays Mon/Wed/Fri
const r = normalizeRule({ type: 'weekdays', days: [5, 1, 3, 3] });
eq('normalize weekdays', JSON.stringify(r), '{"type":"weekdays","days":[1,3,5]}');
n = nextOccurrence(r, '2026-09-22T07:00', B, at('2026-09-22T07:00', B)); // Tue start
eq('weekdays -> wed', iso(n, B), '2026-09-23T07:00:00');
n = nextOccurrence(r, '2026-09-22T07:00', B, n);
eq('weekdays -> fri', iso(n, B), '2026-09-25T07:00:00');
n = nextOccurrence(r, '2026-09-22T07:00', B, n);
eq('weekdays -> mon', iso(n, B), '2026-09-28T07:00:00');
n = nextOccurrence(r, '2026-09-22T07:00', B, at('2026-09-01T00:00', B)); // before start
eq('weekdays before start', iso(n, B), '2026-09-23T07:00:00');
// custom every 3 days, and every 2 months, every 2 weeks
n = nextOccurrence({ type: 'custom', every: 3, unit: 'day' }, '2026-09-01T09:00', B, at('2026-09-07T09:00', B));
eq('custom 3 days', iso(n, B), '2026-09-10T09:00:00');
n = nextOccurrence({ type: 'custom', every: 2, unit: 'month' }, '2026-01-15T09:00', B, at('2026-09-16T09:00', B));
eq('custom 2 months', iso(n, B), '2026-11-15T09:00:00');
n = nextOccurrence({ type: 'custom', every: 2, unit: 'week' }, '2026-09-01T09:00', B, at('2026-09-15T09:00', B));
eq('custom 2 weeks', iso(n, B), '2026-09-29T09:00:00');
// nonexistent time (spring forward 2026-03-29 02:30 Berlin) still yields something sane
n = nextOccurrence({ type: 'daily' }, '2026-03-28T02:30', B, at('2026-03-28T02:30', B));
eq('spring-forward gap is next day', new Date(n).getUTCDate(), 29);
// describe
eq('desc weekly', describeRule({ type: 'weekly' }, '2026-09-21T09:00'), 'Every Mon');
eq('desc monthly', describeRule({ type: 'monthly' }, '2026-09-22T09:00'), 'Monthly on the 22nd');
eq('desc custom', describeRule({ type: 'custom', every: 3, unit: 'day' }, '2026-09-22T09:00'), 'Every 3 days');
eq('desc weekdays', describeRule({ type: 'weekdays', days: [1,2,3,4,5] }, ''), 'Weekdays');
// follow-up series: every 3h until 21:00 on a daily rule -> 09,12,15,18,21 then next day 09
const hr = normalizeRule({ type: 'daily', hours: { every: 3, until: '21:00' } });
eq('normalize hours', JSON.stringify(hr), '{"type":"daily","hours":{"every":3,"until":"21:00"}}');
let seq = [], t = at('2026-09-21T08:00', B);
for (let i = 0; i < 7; i++) { t = nextOccurrence(hr, '2026-09-21T09:00', B, t); seq.push(iso(t, B).slice(5, 16)); }
eq('series daily 3h', seq.join(' '), '09-21T09:00 09-21T12:00 09-21T15:00 09-21T18:00 09-21T21:00 09-22T09:00 09-22T12:00');
// cut-off is inclusive only when it lands exactly; 5h until 21:00 -> 09,14,19 then next day
seq = []; t = at('2026-09-21T08:00', B);
for (let i = 0; i < 4; i++) { t = nextOccurrence({ type: 'daily', hours: { every: 5, until: '21:00' } }, '2026-09-21T09:00', B, t); seq.push(iso(t, B).slice(5, 16)); }
eq('series 5h stops before cut-off', seq.join(' '), '09-21T09:00 09-21T14:00 09-21T19:00 09-22T09:00');
// series never rolls into the next day even with until 23:59
seq = []; t = at('2026-09-21T08:00', B);
for (let i = 0; i < 4; i++) { t = nextOccurrence({ type: 'daily', hours: { every: 10, until: '23:59' } }, '2026-09-21T20:00', B, t); seq.push(iso(t, B).slice(5, 16)); }
eq('series stays within the day', seq.join(' '), '09-21T20:00 09-22T20:00 09-23T20:00 09-24T20:00');
// weekdays Mon/Wed + every 4h until 17:00: Mon 09,13,17 then Wed 09
const wh = { type: 'weekdays', days: [1, 3], hours: { every: 4, until: '17:00' } };
seq = []; t = at('2026-09-21T08:00', B); // Mon
for (let i = 0; i < 4; i++) { t = nextOccurrence(wh, '2026-09-21T09:00', B, t); seq.push(iso(t, B).slice(5, 16)); }
eq('series on chosen weekdays', seq.join(' '), '09-21T09:00 09-21T13:00 09-21T17:00 09-23T09:00');
// resuming mid-day picks the next follow-up, not tomorrow
eq('mid-day resume', iso(nextOccurrence(hr, '2026-09-21T09:00', B, at('2026-09-21T13:30', B)), B), '2026-09-21T15:00:00');
// one-time with follow-ups ends after the last one
const oh = { type: 'none', hours: { every: 2, until: '13:00' } };
eq('once + follow-ups last', iso(nextOccurrence(oh, '2026-09-21T09:00', B, at('2026-09-21T12:00', B)), B), '2026-09-21T13:00:00');
eq('once + follow-ups done', nextOccurrence(oh, '2026-09-21T09:00', B, at('2026-09-21T13:00', B)), null);
// monthly with follow-ups: after the last follow-up, the next month
const mh = { type: 'monthly', hours: { every: 6, until: '15:00' } };
eq('monthly + follow-ups next month', iso(nextOccurrence(mh, '2026-01-31T09:00', B, at('2026-01-31T15:00', B)), B), '2026-02-28T09:00:00');
// bad hours rejected
eq('bad hours every', normalizeRule({ type: 'daily', hours: { every: 24, until: '21:00' } }), null);
eq('bad hours until', normalizeRule({ type: 'daily', hours: { every: 2, until: '9pm' } }), null);
eq('desc hours', describeRule(hr, '2026-09-21T09:00'), 'Every day · then every 3h until 21:00');
eq('desc once hours', describeRule(oh, '2026-09-21T09:00'), 'Then every 2h until 13:00');

// perf: 2000 evaluations should be quick (cron has a 10ms CPU budget per run, we do a handful)
const t0 = performance.now();
for (let i = 0; i < 2000; i++) nextOccurrence({ type: 'daily' }, '2020-01-01T09:00', B, Date.now());
console.log('2000 daily evals ms:', (performance.now() - t0).toFixed(1));
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
