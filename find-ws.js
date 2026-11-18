import https from 'https';

const agent = new https.Agent({ rejectUnauthorized: false });

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { agent, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function run() {
  console.log("1. Fetching homepage...");
  const html = await fetchUrl('https://hulusport.et/');

  console.log("2. Extracting script URLs...");
  const scriptRegex = /<script[^>]+src="([^"]+)"/g;
  let match;
  const scriptUrls = [];
  while ((match = scriptRegex.exec(html)) !== null) {
    let src = match[1];
    if (src.startsWith('/')) src = 'https://hulusport.et' + src;
    scriptUrls.push(src);
  }
  console.log(`Found ${scriptUrls.length} scripts.`);

  console.log("3. Downloading scripts and searching for WebSockets...\n");
  for (const url of scriptUrls) {
    try {
      const js = await fetchUrl(url);
      
      // Search for wss:// or ws://
      const wsMatch = js.match(/wss?:\/\/[^"'\s]+/g);
      if (wsMatch) {
        console.log(`[FOUND WEBSOCKET URL IN] ${url.split('/').pop()}`);
        console.log(wsMatch);
      }

      // Search for '/ws/' or '/socket' paths
      const socketPathMatch = js.match(/["'](\/(ws|socket|live)[^"']*)["']/ig);
      if (socketPathMatch) {
        const uniquePaths = [...new Set(socketPathMatch)];
        console.log(`[FOUND SOCKET PATH IN] ${url.split('/').pop()}`);
        console.log(uniquePaths);
      }
    } catch (e) {
      // Ignore errors on individual scripts
    }
  }
  console.log("\nDone.");
}
run();