import https from 'https';
import fs from 'fs';

const agent = new https.Agent({ rejectUnauthorized: false });

const endpoints = [
  ['configurations',        '/configurations/'],
  ['sport-data-coredata',   '/sport-data/coredata/?ln=en'],
  ['sport-data-matches',    '/sport-data/matches/?ln=en'],
  ['active-tournaments',    '/tournament/active-tournaments/'],
  ['casino-lobby',          '/casino-new/lobby/?device=desktop'],
  ['promotions-active',     '/promotions/active/?trigger_type=2'],
  ['promo-bars',            '/notifications/promo-bars/active/?audience=guest'],
];

const outDir = 'C:\\\\Users\\\\dawit\\\\Desktop\\\\claude projects\\\\mr-y\\\\data';
fs.mkdirSync(outDir, { recursive: true });

function fetchOne(name, path) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.hulusport.et',
      path: path,
      method: 'GET',
      agent: agent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Origin': 'https://hulusport.et',
        'Referer': 'https://hulusport.et/',
      },
    };
    https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        const file = `${outDir}\\\\${name}.json`;
        fs.writeFileSync(file, data);
        let summary;
        try {
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed)) summary = `array, ${parsed.length} items`;
          else if (parsed && typeof parsed === 'object') summary = `object, keys: ${Object.keys(parsed).slice(0,5).join(',')}`;
          else summary = typeof parsed;
        } catch {
          summary = `non-JSON (${data.length} chars, starts: ${data.substring(0, 60).replace(/\\s+/g,' ')})`;
        }
        console.log(`${String(res.statusCode).padEnd(4)} ${name.padEnd(22)} ${String(data.length).padStart(8)}B  ${summary}`);
        resolve();
      });
    }).on('error', (e) => {
      console.log(`ERR  ${name.padEnd(22)} ${e.message}`);
      resolve();
    }).end();
  });
}

for (const [name, path] of endpoints) {
  await fetchOne(name, path);
}
console.log('\nDone. Files written to:', outDir);