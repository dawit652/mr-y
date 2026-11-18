import https from 'https';
import fs from 'fs';

const agent = new https.Agent({ rejectUnauthorized: false });
const WATCHLIST  = 'C:\\\\Users\\\\dawit\\\\Desktop\\\\claude projects\\\\mr-y\\\\data\\\\watchlist.txt';
const OUT_CSV    = 'C:\\\\Users\\\\dawit\\\\Desktop\\\\claude projects\\\\mr-y\\\\data\\\\odds-moves.csv';

// Base 6 minutes (360,000ms) + up to 60s random jitter
const BASE_INTERVAL = 360000; 

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0'
];

// Helpers
const sleep = ms => new Promise(r => setTimeout(r, ms));
const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

if (!fs.existsSync(WATCHLIST)) process.exit(1);
const ids = fs.readFileSync(WATCHLIST, 'utf8').split(/\s+/).filter(Boolean).map(Number);

if (!fs.existsSync(OUT_CSV)) {
  fs.writeFileSync(OUT_CSV, 'timestamp_utc,match_id,hom,awy,market_name,specifier,bet_type_id,outcome,odd_old,odd_new,delta\n');
}

function fetchMatch(id) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.hulusport.et',
      path: `/sport-data/matches/${id}/`,
      method: 'GET', agent,
      headers: {
        'User-Agent': randomUA(),
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://hulusport.et',
        'Referer': 'https://hulusport.et/',
        'Connection': 'keep-alive'
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
    req.setTimeout(15000, () => { try { req.destroy(); } catch {} });
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
  fs.appendFileSync(OUT_CSV, lines + '\n');
}

let cycles = 0;
async function runCycle() {
  cycles++;
  const t0 = Date.now();
  let moves = 0, fetched = 0;
  
  // Shuffle the watchlist so we don't hit them in the exact same order every time
  const cycleIds = shuffle([...ids]); 

  for (const id of cycleIds) {
    const match = await fetchMatch(id);
    if (!match) { await sleep(2000); continue; }
    fetched++;

    const state = flattenState(match);
    const prev = previous.get(id);

    if (prev) {
      const changed = [];
      for (const [key, cur] of state) {
        const before = prev.get(key);
        if (before && before.odd !== cur.odd && cur.is_available && before.is_available) {
          changed.push({ ...cur, odd_old: before.odd, delta: cur.odd - before.odd });
        }
      }
      
      if (changed.length) {
        appendMoves(changed.map(c => ({
          match_id: id, hom: match.hom, awy: match.awy,
          market_name: c.market_name, specifier: c.specifier,
          bet_type_id: c.bet_type_id, outcome: c.outcome,
          odd_old: c.odd_old, odd_new: c.odd, delta: c.delta,
        })));
        moves += changed.length;
        console.log(`  MOVE ${changed[0].odd_old}->${changed[0].odd}  ${match.hom} vs ${match.awy}  (+${changed.length-1} more)`);
      }
    }
    previous.set(id, state);

    // HUMAN BEHAVIOR: pause randomly between 1.5 and 4 seconds between match requests
    const pause = Math.floor(Math.random() * 2500) + 1500;
    await sleep(pause); 
  }

  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[cycle ${cycles}] ${fetched}/${ids.length} fetched, ${moves} moves, ${sec}s`);
}

console.log(`Stealth Poller Started.`);
console.log(`Matches: ${ids.length}`);
console.log(`Base interval: 6 minutes + random jitter.\n`);

async function loop() {
  await runCycle();
  // Next cycle in ~6 minutes + up to 60 seconds of random delay
  const nextDelay = BASE_INTERVAL + Math.floor(Math.random() * 60000);
  console.log(`Waiting ${(nextDelay/1000).toFixed(0)}s for next cycle...\n`);
  setTimeout(loop, nextDelay);
}
loop();