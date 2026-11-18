import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    userDataDir: 'C:\\Users\\dawit\\Desktop\\claude projects\\mr-y\\chrome-profile',
    defaultViewport: null
  });

  const page = await browser.newPage();

  // Log EVERY request the browser makes
  page.on('request', (request) => {
    const url = request.url();
    
    // We only care about API calls, launch calls, or iframes
    if (
        url.includes('/api/') || 
        url.includes('launch') || 
        url.includes('play') || 
        url.includes('session') || 
        url.includes('abcdabra')
    ) {
        // Ignore the big lists we already have
        if (url.includes('/list')) return; 

        console.log('\n=====================================');
        console.log(`🚀 REQUEST CAUGHT: [${request.method()}]`);
        console.log(url);
        console.log('=====================================\n');
    }
  });

  console.log('Navigating to Narobet games...');
  await page.goto('https://narobet.bet/games', { waitUntil: 'networkidle2' });

  console.log('👉 CLICK A GAME NOW (e.g., Plinko or 2021 Hit Slot)...');
  
  // Wait 2 minutes for you to interact
  await new Promise(resolve => setTimeout(resolve, 120000)); 
  
  await browser.close();
})();