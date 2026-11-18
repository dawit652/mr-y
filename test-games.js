import https from 'https';

const agent = new https.Agent({ rejectUnauthorized: false });

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

https.request(options, (res) => {
  let data = '';
  res.on('data', (c) => { data += c; });
  res.on('end', () => {
    console.log('Status Code:', res.statusCode);
    console.log('Response length:', data.length, 'bytes');
    try {
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        console.log(`Array with ${parsed.length} items. First item keys:`);
        console.log(Object.keys(parsed[0] || {}));
      } else {
        console.log('Object keys:', Object.keys(parsed));
      }
    } catch (e) {
      console.log('Not JSON or HTML error page:', data.substring(0, 200));
    }
  });
}).on('error', (e) => console.error('Error:', e.message)).end();