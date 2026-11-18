import puppeteer from 'puppeteer';
import fs from 'fs';

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    userDataDir: 'C:\\Users\\dawit\\Desktop\\claude projects\\mr-y\\chrome-profile',
    defaultViewport: null
  });

  const page = await browser.newPage();

  // Listen for ALL requests
  page.on('request', async (request) => {
    const url = request.url();
    
    // We want the exact INIT request
    if (url.includes('/api/games/abcdabra/init')) {
      console.log('\n======================================================');
      console.log('🚀 INTERCEPTED INIT REQUEST!');
      console.log('URL:', url);
      console.log('Method:', request.method());
      
      // Log the exact headers
      console.log('\nHEADERS:');
      const headers = request.headers();
      console.log(JSON.stringify(headers, null, 2));
      
      // Log the exact payload
      console.log('\nPAYLOAD:');
      console.log(request.postData());
      
      // Save to a file for later use
      fs.writeFileSync('captured-request.json', JSON.stringify({
        headers,
        payload: request.postData()
      }, null, 2));
      console.log('Saved to captured-request.json');
      console.log('======================================================\n');
    }
  });

  console.log('Navigating to Narobet...');
  await page.goto('https://narobet.bet/games', { waitUntil: 'networkidle2' });

  console.log('👉 CLICK A GAME (e.g., Plinko) NOW!');
  
  await new Promise(resolve => setTimeout(resolve, 120000)); 
  await browser.close();
})();