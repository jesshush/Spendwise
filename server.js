const express = require('express');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// 1. Database: one file, two tables
const db = new DatabaseSync(process.env.DB_PATH || 'spendwise.db');
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, email TEXT UNIQUE, password TEXT)`);
db.exec(`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER)`);

const app = express();
app.use(express.json());
app.use(express.static('public'));

// 2. Never store real passwords: store a scrambled (hashed) version
function hash(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function check(pw, stored) {
  return hash(pw, stored.split(':')[0]) === stored;
}

// 3. Logging in = giving the browser a secret token in a cookie
function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions VALUES (?, ?)').run(token, userId);
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax' });
}

app.post('/api/signup', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 8) {
    return res.status(400).json({ error: 'Fill everything in. Password needs 8+ characters.' });
  }
  try {
    const r = db.prepare('INSERT INTO users (name, email, password) VALUES (?, ?, ?)')
      .run(name, email.toLowerCase(), hash(password));
    startSession(res, r.lastInsertRowid);
    res.json({ name });
  } catch {
    res.status(409).json({ error: 'That email already has an account' });
  }
});

app.post('/api/login', (req, res) => {
  const email = (req.body.email || '').toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !check(req.body.password || '', user.password)) {
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  startSession(res, user.id);
  res.json({ name: user.name });
});

app.get('/api/me', (req, res) => {
  const token = (req.headers.cookie || '').match(/token=(\w+)/)?.[1];
  const user = token && db.prepare(
    'SELECT u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  res.json(user);
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Spendwise running on port ' + PORT));
