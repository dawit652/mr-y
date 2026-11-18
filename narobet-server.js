import express from 'express';
import cors from 'cors';
import db from './narobet-db.js';

const app = express();
app.use(cors());

app.get('/api/games', (req, res) => {
  try {
    const row = db.prepare('SELECT data FROM catalog WHERE id = ?').get('narobet_main');
    if (!row) return res.status(404).json({ error: "Catalog not fetched yet" });
    res.json(JSON.parse(row.data));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3300, () => console.log('Narobet API running on http://127.0.0.1:3300'));