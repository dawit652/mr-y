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
  console.log("Downloading main JS bundle...");
  const js = await fetchUrl('https://hulusport.et/assets/index-CmPKCR-9.js');
  
  console.log("Searching for API endpoints and polling logic...\n");
  
  // 1. Look for strings that start with / and look like API paths
  const apiPaths = js.match(/["'](\/(api|sport|live|match)[a-zA-Z0-9_\-\/]*)["']/g);
  if (apiPaths) {
    console.log("=== API Paths Found ===");
    const uniquePaths = [...new Set(apiPaths.map(p => p.replace(/["']/g, '')))];
    uniquePaths.forEach(p => console.log(p));
  }

  // 2. Look for how they configure polling (e.g. refetchInterval, setInterval)
  console.log("\n=== Polling Logic ===");
  const pollMatches = js.match(/setInterval\([^,]+,\s*\d+\)/g);
  const reactQueryMatches = js.match(/refetchInterval:\s*\d+/g);
  
  if (pollMatches) console.log("Native Polls:", [...new Set(pollMatches)].slice(0, 5));
  if (reactQueryMatches) console.log("React Query Polls:", [...new Set(reactQueryMatches)].slice(0, 5));
  
  if (!pollMatches && !reactQueryMatches) {
      console.log("No obvious polling intervals found in the main bundle.");
  }
}

run();