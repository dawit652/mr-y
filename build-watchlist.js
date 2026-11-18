import https from 'https';
import fs from 'fs';

const agent = new https.Agent({ rejectUnauthorized: false });

function fetchJson(path) {
  return new Promise((resolve) => {
    https.get({ hostname: 'api.hulusport.et', path, agent, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

async function run() {
  console.log('1. Fetching core data (to map leagues to sports)...');
  const core = await fetchJson('/sport-data/coredata/?ln=en');
  if (!core) { console.log('Failed to fetch coredata.'); return; }

  // Find "Soccer" or "Football" in the sport types
  const soccerType = core.sport_types.find(s => /soccer|football/i.test(s.name));
  if (!soccerType) { console.log('Could not find Soccer in sport types.'); return; }
  console.log(`   Found Sport: ${soccerType.name} (ID: ${soccerType.id})`);

  // Map all soccer league IDs
  const soccerLeagues = new Set(
    core.leagues
      .filter(l => {
        const sid = l.sport_type_id || l.sport_id || l.sport?.id || l.sport;
        return Number(sid) === Number(soccerType.id);
      })
      .map(l => Number(l.id))
  );
  console.log(`   Found ${soccerLeagues.size} soccer leagues.`);

  console.log('\n2. Fetching latest matches...');
  const matches = await fetchJson('/sport-data/matches/?ln=en');
  if (!matches) { console.log('Failed to fetch matches.'); return; }

  const now = new Date();
  const upcomingSoccer = matches.filter(m => {
    const kick = new Date(m.schedule);
    if (kick <= now) return false; // skip past matches
    const leagueId = Number(m.league?.id || m.league);
    return soccerLeagues.has(leagueId);
  }).sort((a, b) => new Date(a.schedule) - new Date(b.schedule));

  const top30 = upcomingSoccer.slice(0, 30);
  console.log(`\n3. Found ${upcomingSoccer.length} upcoming soccer matches. Selecting top ${top30.length}:\n`);
  
  top30.forEach(m => {
    const time = new Date(m.schedule).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    console.log(`   ${m.id}  |  ${time}  |  ${m.hom} vs ${m.awy}`);
  });

  fs.writeFileSync('C:\\\\Users\\\\dawit\\\\Desktop\\\\claude projects\\\\mr-y\\\\data\\\\watchlist.txt', top30.map(m => m.id).join('\n'));
  console.log('\nSaved 30 matches to data/watchlist.txt');
}
run();