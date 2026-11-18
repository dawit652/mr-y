import https from 'https';
import fs from 'fs';

const agent = new https.Agent({ rejectUnauthorized: false });

const options = {
  hostname: 'narobet.bet',
  path: '/api/games/qt/list',
  method: 'GET',
  agent: agent,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Origin': 'https://narobet.bet',
    'Referer': 'https://narobet.bet/games',
  },
};

https.request(options, (res) => {
  let data = '';
  res.on('data', (c) => { data += c; });
  res.on('end', () => {
    console.log('Status Code:', res.statusCode);
    console.log('Response length:', data.length, 'bytes');
    
    try {
      const parsed = JSON.parse(data);
      fs.writeFileSync('narobet-catalog.json', data);
      console.log('Saved to narobet-catalog.json');

      if (Array.isArray(parsed)) {
        console.log(`\nTop-level is an Array with ${parsed.length} items.`);
        console.log('\n--- First Item Structure ---');
        console.log(JSON.stringify(parsed[0], null, 2).substring(0, 1500));
      } else if (typeof parsed === 'object') {
        console.log('\nTop-level is an Object. Keys:', Object.keys(parsed));
        // Try to find the games array
        for (const key of Object.keys(parsed)) {
          if (Array.isArray(parsed[key]) && parsed[key].length > 10) {
            console.log(`\nFound large array under key: "${key}" (${parsed[key].length} items)`);
            console.log('\n--- First Item Structure ---');
            console.log(JSON.stringify(parsed[key][0], null, 2).substring(0, 1500));
            break;
          }
        }
      }
    } catch (e) {
      console.log('Not JSON or HTML error page:', data.substring(0, 300));
    }
  });
}).on('error', (e) => console.error('Error:', e.message)).end();