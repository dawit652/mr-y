import https from 'https';

const gameId = '2021-hit-slot'; 
const sessionCookie = 'YOUR_COOKIE_VALUE_HERE'; // <--- PASTE YOUR COOKIE HERE

const paths = [
  `/api/games/abcdabra/launch?gameId=${gameId}&mode=demo`,
  `/api/games/qt/launch?gameId=${gameId}&mode=demo`
];

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Origin': 'https://narobet.bet',
  'Referer': 'https://narobet.bet/games',
  'Cookie': `session=${sessionCookie}` // We are injecting the cookie!
};

async function testEndpoint(path) {
  return new Promise((resolve) => {
    https.request({ hostname: 'narobet.bet', path: path, method: 'GET', headers: headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        console.log(`\n[Status: ${res.statusCode}] ${path}`);
        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(data);
            const url = parsed.url || parsed.gameUrl || parsed.launchUrl;
            if (url) console.log(`\n  🎯 FOUND GAME URL:\n  ${url}`);
            else console.log(`  -> 200 OK, but no URL found. Keys: ${Object.keys(parsed).join(', ')}`);
          } catch (e) {
            console.log(`  -> Not JSON. Starts with: ${data.substring(0, 100)}`);
          }
        } else {
          console.log(`  -> Failed: ${res.headers.location || data.substring(0, 50)}`);
        }
        resolve();
      });
    }).on('error', (e) => { console.log(e.message); resolve(); }).end();
  });
}

(async () => {
  console.log('Probing Narobet WITH logged-in cookie...');
  for (const p of paths) await testEndpoint(p);
})();