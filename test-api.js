import https from 'https';

const agent = new https.Agent({
  rejectUnauthorized: false
});

const options = {
  hostname: 'api.hulusport.et',
  path: '/sport-data/matches/?ln=en',
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
    console.log('Status Code:', res.statusCode);
    console.log('Response:', data.substring(0, 500));
  });
}).on('error', (e) => console.error('Error:', e.message)).end();