import https from 'https';
import db from './narobet-db.js';

async function fetchCatalog() {
  console.log(`[${new Date().toISOString()}] Fetching Narobet casino catalog...`);
  
  const options = {
    hostname: 'narobet.bet',
    path: '/api/games/qt/list',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Origin': 'https://narobet.bet',
      'Referer': 'https://narobet.bet/games',
    },
  };

  return new Promise((resolve) => {
    https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error(`Failed: HTTP ${res.statusCode}`);
          return resolve(false);
        }
        try {
          const parsed = JSON.parse(data);
          const stmt = db.prepare('INSERT OR REPLACE INTO catalog (id, data) VALUES (?, ?)');
          stmt.run('narobet_main', JSON.stringify(parsed));
          console.log(`[${new Date().toISOString()}] Success: Saved ${parsed.games?.length || 0} games.`);
          resolve(true);
        } catch (e) {
          console.error('Failed to parse JSON:', e.message);
          resolve(false);
        }
      });
    }).on('error', (e) => {
      console.error('Network error:', e.message);
      resolve(false);
    }).end();
  });
}

async function loop() {
  await fetchCatalog();
  console.log('Waiting 6 hours for next sync...');
  setTimeout(loop, 21600000);
}

loop();