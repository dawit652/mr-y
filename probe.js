import https from 'https';

const agent = new https.Agent({ rejectUnauthorized: false });
const id = 2757372;

const candidates = [
  `/sport-data/matches/${id}/`,
  `/sport-data/matches/${id}/odds/`,
  `/sport-data/match/${id}/`,
  `/sport-data/match/${id}/odds/`,
  `/sport-data/odds/${id}/`,
  `/sport-data/odds/?match_id=${id}`,
  `/sport-data/match-odds/?match_id=${id}`,
  `/sport-data/matches/${id}/markets/`,
  `/sport-data/markets/?match_id=${id}`,
  `/event/${id}/`,
  `/event/${id}/odds/`,
  `/event-odds/${id}/`,
];

function probe(path) {
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
        let hint = '';
        try {
          const p = JSON.parse(data);
          if (Array.isArray(p)) hint = `array(${p.length})`;
          else if (p && typeof p === 'object') hint = `keys: ${Object.keys(p).slice(0,4).join(',')}`;
        } catch { hint = `html?(${data.length}B)`; }
        console.log(`${String(res.statusCode).padEnd(4)} ${String(data.length).padStart(8)}B  ${hint.padEnd(30)} ${path}`);
        resolve();
      });
    }).on('error', (e) => {
      console.log(`ERR  ${e.message.padEnd(30)} ${path}`);
      resolve();
    }).end();
  });
}

for (const c of candidates) await probe(c);