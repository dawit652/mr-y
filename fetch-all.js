import https from 'https';
import fs from 'fs';

const agent = new https.Agent({ rejectUnauthorized: false });
const idFile = 'C:\\\\Users\\\\dawit\\\\Desktop\\\\claude projects\\\\mr-y\\\\data\\\\match-ids.txt';
const outDir = 'C:\\\\Users\\\\dawit\\\\Desktop\\\\claude projects\\\\mr-y\\\\data\\\\matches';
fs.mkdirSync(outDir, { recursive: true });

const ids = fs.readFileSync(idFile, 'utf8').split(/\s+/).filter(Boolean);
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : ids.length;
const work = ids.slice(0, limit);

const CONCURRENCY = 3;
let idx = 0, done = 0, failed = 0;
const t0 = Date.now();

function fetchOne(id) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (success) => {
      if (settled) return;
      settled = true;
      done++;
      if (!success) failed++;
      if (done % 25 === 0) {
        const el = ((Date.now() - t0) / 1000).toFixed(0);
        const rate = (done / el).toFixed(1);
        const eta = ((work.length - done) / rate).toFixed(0);
        console.log(`${done}/${work.length}  failed=${failed}  ${rate}/s  ETA ${eta}s`);
      }
      resolve();
    };
    const req = https.request({
      hostname: 'api.hulusport.et',
      path: `/sport-data/matches/${id}/`,
      method: 'GET', agent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Origin': 'https://hulusport.et',
        'Referer': 'https://hulusport.et/',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { fs.writeFileSync(`${outDir}\\\\match-${id}.json`, data); finish(true); }
          catch { finish(false); }
        } else { finish(false); }
      });
    });
    req.on('error', () => finish(false));
    req.setTimeout(15000, () => { try { req.destroy(); } catch {} });
    req.end();
  });
}

async function worker() {
  while (idx < work.length) {
    if (failed > 20 && done > 40 && failed / done > 0.05) {
      console.error(`Aborting: ${((failed/done)*100).toFixed(1)}% failures`);
      idx = work.length;
      break;
    }
    await fetchOne(work[idx++]);
  }
}

console.log(`Fetching ${work.length} matches, concurrency ${CONCURRENCY}...`);
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const sec = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\nDone in ${sec}s. ${done - failed}/${work.length} succeeded, ${failed} failed.`);
console.log(`Files: ${outDir}`);