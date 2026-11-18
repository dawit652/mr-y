import Database from 'better-sqlite3';
const db = new Database('narobet.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS catalog (
    id TEXT PRIMARY KEY,
    data TEXT
  );
`);

console.log('Narobet Database initialized (narobet.db)');
export default db;