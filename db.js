import Database from 'better-sqlite3';
const db = new Database('games.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS catalog (
    id TEXT PRIMARY KEY,
    data TEXT
  );
`);

console.log('mr-y Database initialized successfully (games.db)');
export default db;