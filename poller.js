import https from 'https';
import db from './db.js';
// import { createPinnedAgent } from './tls-pin.js'; // <-- UNCOMMENT THIS IF YOU COPIED THE PIN FILE

// Using the insecure agent for now, replace with the pinned agent from mr-y
const agent = new https.Agent({ rejectUnauthorized: false });

async function fetchCatalog() {
  console.log(`[${new Date().toISOString()}] Fetching casino catalog...`);
  
  const options = {
    hostname: 'api.hulusport.com',
    path: '/casino-new/lobby/?device=desktop',
    method: 'GET',
    agent: agent,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Origin': 'https://hulusport.com',
      'Referer': 'https://hulusport.com/games',
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
          // Save the entire catalog as one JSON string
          const stmt = db.prepare('INSERT OR REPLACE INTO catalog (id, data) VALUES (?, ?)');
          stmt.run('hulusport_main', JSON.stringify(parsed));
          console.log(`[${new Date().toISOString()}] Success: Saved ${parsed.length} categories.`);
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

// Run every 6 hours
async function loop() {
  await fetchCatalog();
  console.log('Waiting 6 hours for next sync...');
  setTimeout(loop, 21600000);
}

loop();