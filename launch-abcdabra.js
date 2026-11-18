import https from 'https';

const gameUuid = '137b2075-5fad-45ef-b5fc-04d69364079a'; // Plinko

// 🔴 PASTE YOUR COOKIE VALUE HERE
const sessionCookie = 'PASTE_YOUR_COOKIE_HERE'; 

const payload = JSON.stringify({
  game_uuid: gameUuid,
  demo: true 
});

const options = {
  hostname: 'narobet.bet',
  path: '/api/games/abcdabra/init',
  method: 'POST',
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Origin': 'https://narobet.bet',
    'Referer': 'https://narobet.bet/games',
    'Cookie': `next-auth.session-token=${sessionCookie}` // Injecting the cookie
  }
};

console.log(`Requesting Abcdabra session with cookie...`);

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', (c) => { data += c; });
  res.on('end', () => {
    console.log(`HTTP Status: ${res.statusCode}`);
    
    try {
      const parsed = JSON.parse(data);
      const gameUrl = parsed.game_uri || parsed.url || parsed.launch_url;
      
      if (gameUrl) {
        console.log('\n======================================================');
        console.log('🎯 SUCCESS! COPY THIS URL AND PASTE IT IN CHROME:');
        console.log('\n' + gameUrl);
        console.log('\n======================================================');
      } else {
        console.log('\nNo URL found. Here is the response from Narobet:');
        console.log(JSON.stringify(parsed, null, 2));
      }
    } catch (e) {
      console.log('\nFailed to parse JSON. Raw response:');
      console.log(data.substring(0, 300));
    }
  });
});

req.on('error', (e) => console.error('Network Error:', e.message));
req.write(payload);
req.end();