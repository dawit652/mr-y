import https from 'https';
import fs from 'fs';

const agent = new https.Agent({ rejectUnauthorized: false });
const WATCHLIST   = 'C:\\\\Users\\\\dawit\\\\Desktop\\\\claude projects\\\\mr-y\\\\data\\\\watchlist.txt';
const MOVES_CSV   = 'C:\\\\Users\\\\dawit\\\\Desktop\\\\claude projects\\\\mr-y\\\\data\\\\odds-moves.csv';
const EVENTS_CSV  = 'C:\\\\Users\\\\dawit\\\\Desktop\\\\claude projects\\\\mr-y\\\\data\\\\odds-events.csv';
const INTERVAL_MS = 25000;
const CONCURRENCY = 3;

const ids = fs.readFileSync(WATCHLIST, 'utf8').split(/\s+/).filter(Boolean).map(Number);

if (!fs.existsSync(MOVES_CSV)) {
  fs.writeFileSync(MOVES_CSV, 'timestamp_utc,match_id,hom,awy,market_name,specifier,bet_type_id,outcome,odd_old,odd_new,delta\n');
}
if (!fs.existsSync(EVENTS_CSV)) {
  fs.writeFileSync(EVENTS_CSV, 'timestamp_utc,match_id,hom,awy,event,detail,markets_count\n');
}

function fetchMatch(id) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.hulusport.et',
      path: `/sport-data/matches/${id}/`,
      method: 'GET', agent,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
        'Origin': 'https://hulusport.et',
        'Referer': 'https://hulusport.et/',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { try { req.destroy(); } catch {} });
    req.end();
  });
}

function flattenState(match) {
  const state = new Map();
  if (!match || !Array.isArray(match.items)) return state;
  for (const market of match.items) {
    const g = market.bet_group || {};
    const spec = JSON.stringify(market.specifier || {});
    for (const odd of market.odds || []) {
      if (!odd) continue;
      const key = `${market.id}|${odd.bet_type?.id}|${spec}`;
      state.set(key, {
        market_name: g.name || '',
        specifier: spec.replace(/["{}]/g, '').replace(/:/g, '='),
        bet_type_id: odd.bet_type?.id,
        outcome: String(odd.bet_type?.name || '')
          .replace(/\{\$competitor1\}/g, match.hom || '')
          .replace(/\{\$competitor2\}/g, match.awy || ''),
        odd: Number(odd.odd),
        is_available: odd.is_available !== false,
      });
    }
  }
  return state;
}

const previous = new Map();

function appendMoves(rows) {
  if (!rows.length) return;
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
  const lines = rows.map(r => [
    new Date().toISOString(), r.match_id, r.hom, r.awy,
    r.market_name, r.specifier, r.bet_type_id, r.outcome,
    r.odd_old, r.odd_new, r.delta.toFixed(3),
  ].map(esc).join(',')).join('\n');
  fs.appendFileSync(MOVES_CSV, lines + '\n');
}

function appendEvents(rows) {
  if (!rows.length) return;
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
  const lines = rows.map(r => [
    new Date().toISOString(), r.match_id, r.hom, r.awy,
    r.event, r.detail, r.markets_count,
  ].map(esc).join(',')).join('\n');
  fs.appendFileSync(EVENTS_CSV, lines + '\n');
}

let cycles = 0;
async function runCycle() {
  cycles++;
  const t0 = Date.now();
  let moves = 0, events = 0, fetched = 0, cursor = 0;

  async function worker() {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      const match = await fetchMatch(id);
      if (!match) continue;
      fetched++;

      const state = flattenState(match);
      const prev = previous.get(id);
      const prevMeta = prev?.meta;
      const meta = { expired: match.expired, count: state.size, hom: match.hom, awy: match.awy };

      if (prev && prevMeta) {
        const changed = [], added = [], removed = [];

        for (const [key, cur] of state) {
          const before = prev.state.get(key);
          if (!before) added.push(cur);
          else if (before.odd !== cur.odd && cur.is_available && before.is_available) {
            changed.push({ ...cur, odd_old: before.odd, delta: cur.odd - before.odd });
          }
        }
        for (const [key, before] of prev.state) {
          if (!state.has(key)) removed.push(before);
        }

        if (changed.length) {
          appendMoves(changed.map(c => ({
            match_id: id, hom: match.hom, awy: match.awy,
            market_name: c.market_name, specifier: c.specifier,
            bet_type_id: c.bet_type_id, outcome: c.outcome,
            odd_old: c.odd_old, odd_new: c.odd, delta: c.delta,
          })));
          moves += changed.length;
          for (const c of changed.slice(0, 3)) {
            console.log(`  MOVE ${c.odd_old}->${c.odd}  ${match.hom} vs ${match.awy}  ${c.market_name} ${c.outcome}`);
          }
          if (changed.length > 3) console.log(`  ... +${changed.length - 3} more moves`);
        }

        // Match-level lifecycle (prematch->live, suspended, resumed, finished)
        const eventRows = [];
        if (prevMeta.count > 0 && state.size === 0) {
          eventRows.push({ match_id: id, hom: match.hom, awy: match.awy, event: 'SUSPENDED', detail: 'all markets withdrawn', markets_count: 0 });
        } else if (prevMeta.count === 0 && state.size > 0) {
          eventRows.push({ match_id: id, hom: match.hom, awy: match.awy, event: 'RESUMED', detail: `${state.size} markets opened`, markets_count: state.size });
        }
        if (prevMeta.expired === false && meta.expired === true) {
          eventRows.push({ match_id: id, hom: match.hom, awy: match.awy, event: 'LIVE_START', detail: 'prematch->live', markets_count: state.size });
        }
        if (eventRows.length) {
          appendEvents(eventRows);
          events += eventRows.length;
          for (const e of eventRows) console.log(`  EVENT ${e.event}  ${match.hom} vs ${match.awy}`);
        }

        // Log large ADDED/REMOVED as a single lifecycle event (avoid flooding)
        if (added.length + removed.length >= 20) {
          appendEvents([{ match_id: id, hom: match.hom, awy: match.awy, event: 'MARKET_TURNOVER', detail: `${added.length} added, ${removed.length} removed`, markets_count: state.size }]);
          events++;
        }
      }

      previous.set(id, { state, meta });
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[cycle ${cycles}] ${fetched}/${ids.length} fetched, ${moves} moves, ${events} events, ${sec}s`);
}

console.log(`Polling ${ids.length} matches every ${INTERVAL_MS/1000}s, concurrency ${CONCURRENCY}`);
console.log(`Moves:    ${MOVES_CSV}`);
console.log(`Events:   ${EVENTS_CSV}`);
console.log('Ctrl+C to stop.\n');

async function loop() {
  await runCycle();
  setTimeout(loop, INTERVAL_MS);
}
loop();