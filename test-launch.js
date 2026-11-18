import https from 'https';

// The game ID from your screenshot
const gameId = '2021-hit-slot'; 

// Based on your screenshot, the URL was /games/abcdabra/<uuid>
// So we test the abcdabra launch endpoints first, then standard QTech ones.
const paths = [
  `/api/games/abcdabra/launch?gameId=${gameId}&mode=demo`,
  `/api/games/abcdabra/session?gameId=${gameId}&mode=demo`,
  `/api/games/qt/launch?gameId=${gameId}&mode=demo`,
  `/api/games/launch?gameId=${gameId}&mode=demo`
];

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://narobet.bet',
  'Referer': 'https://narobet.bet/games'
};

async function testEndpoint(path) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'narobet.bet',
      path: path,
      method: 'GET',
      headers: headers
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        console.log(`\n[Status: ${res.statusCode}] ${path}`);
        
        // If it's a redirect to login
        if (res.statusCode >= 300 && res.statusCode < 400) {
          console.log(`  -> Redirected to: ${res.headers.location}`);
        } 
        // If it returns data, we want to see it!
        else if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(data);
            console.log(`  -> Success! Response keys: ${Object.keys(parsed).join(', ')}`);
            
            // Try to find the game URL
            const url = parsed.url || parsed.gameUrl || parsed.launchUrl || parsed.game_url;
            if (url) {
              console.log(`\n  🎯 FOUND GAME URL:\n  ${url}`);
            }
          } catch (e) {
            console.log(`  -> Response is not JSON. Starts with: ${data.substring(0, 100)}`);
          }
        } else {
          console.log(`  -> Error response: ${data.substring(0, 100)}`);
        }
        resolve();
      });
    });

    req.on('error', (e) => {
      console.log(`\n[Network Error] ${path} -> ${e.message}`);
      resolve();
    });
    
    req.end();
  });
}

(async () => {
  console.log('Probing Narobet for unauthenticated playable game URLs...');
  for (const p of paths) {
    await testEndpoint(p);
  }
  console.log('\nDone.');
})();