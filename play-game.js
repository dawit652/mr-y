import puppeteer from 'puppeteer';

(async () => {
  // Launch Chrome using the profile where you are logged in
  const browser = await puppeteer.launch({
    headless: false, 
    executablePath: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    userDataDir: 'C:\\Users\\dawit\\Desktop\\claude projects\\mr-y\\chrome-profile',
    defaultViewport: null
  });

  const page = await browser.newPage();

  console.log('Navigating to Narobet to establish session...');
  await page.goto('https://narobet.bet/games', { waitUntil: 'networkidle2' });

  console.log('Fetching game URL directly from the browser...');

  // We execute the fetch INSIDE the browser, so it automatically uses your cookies!
  const gameData = await page.evaluate(async () => {
    const response = await fetch('/api/games/abcdabra/init', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        gameUuid: '137b2075-5fad-45ef-b5fc-04d69364079a' // Plinko
      })
    });

    if (!response.ok) {
      return { error: `HTTP ${response.status} - ${response.statusText}` };
    }
    return await response.json();
  });

  console.log('\n======================================================');
  
  if (gameData.error) {
    console.log('❌ Error from Narobet:', gameData.error);
    console.log('You might not be logged in. Please log in inside the Chrome window and try again.');
  } else {
    console.log('✅ RAW RESPONSE FROM NAROBET:');
    console.log(JSON.stringify(gameData, null, 2));
    
    // Extract the URL (Narobet usually returns it in a field called game_uri or url)
    const url = gameData.game_uri || gameData.url || gameData.launch_url;
    
    if (url) {
      console.log('\n🎯 HERE IS YOUR PLAYABLE URL:');
      console.log(url);
    } else {
      console.log('\nCould not find a URL in the response.');
    }
  }
  
  console.log('======================================================\n');
  
  console.log('Browser will stay open for 30 seconds so you can log in if needed...');
  await new Promise(resolve => setTimeout(resolve, 30000)); 
  
  await browser.close();
})();