import https from 'https';

const agent = new https.Agent({ rejectUnauthorized: false });

function fetchUrl(url) {
  return new Promise((resolve) => {
    https.get(url, { agent, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', () => resolve(''));
  });
}

async function run() {
  console.log("Downloading main bundle to find chunks...");
  const mainJs = await fetchUrl('https://hulusport.et/assets/index-CmPKCR-9.js');
  
  // Find all dynamically imported chunks (e.g., "assets/SportData-abc123.js")
  const chunkRegex = /["']([^"']*assets\/[a-zA-Z0-9_\-\.]+\.js)["']/g;
  let match;
  const chunks = new Set();
  
  while ((match = chunkRegex.exec(mainJs)) !== null) {
    let path = match[1];
    if (!path.startsWith('http')) {
      path = 'https://hulusport.et/' + path.replace(/^\//, '');
    }
    chunks.add(path);
  }
  
  // Also look for chunk filenames directly (e.g., "Sport-abc.js")
  const fileRegex = /["']([a-zA-Z0-9_\-]+-[a-zA-Z0-9_\-]+\.js)["']/g;
  while ((match = fileRegex.exec(mainJs)) !== null) {
    let path = 'https://hulusport.et/assets/' + match[1];
    chunks.add(path);
  }

  console.log(`Found ${chunks.size} potential JavaScript chunks.`);
  console.log("Scanning all chunks for API URLs and WebSockets...\n");

  for (const url of chunks) {
    const js = await fetchUrl(url);
    if (!js) continue;
    
    const fileName = url.split('/').pop();
    
    // 1. Look for API domain names
    const apiDomains = js.match(/https?:\/\/[a-zA-Z0-9\.\-]*hulusport[a-zA-Z0-9\.\-]*/g);
    if (apiDomains) {
      console.log(`[DOMAIN] ${fileName}:`, [...new Set(apiDomains)]);
    }

    // 2. Look for WebSockets
    const wsUrls = js.match(/wss?:\/\/[^"'\s]+/g);
    if (wsUrls) {
      console.log(`[WEBSOCKET] ${fileName}:`, [...new Set(wsUrls)]);
    }

    // 3. Look for polling intervals
    const intervals = js.match(/setInterval\([^,]+,\s*\d+\)|refetchInterval:\s*\d+/g);
    if (intervals) {
      console.log(`[POLLING] ${fileName}:`, [...new Set(intervals)]);
    }
  }
  
  console.log("\nScan complete.");
}

run();