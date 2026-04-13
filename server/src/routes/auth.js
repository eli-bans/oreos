const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const db = require('../db/schema');
const { JWT_SECRET } = require('../middleware/auth');

function isEducationalEmail(email) {
  const normalized = String(email).trim().toLowerCase();
  const atIndex = normalized.lastIndexOf('@');
  if (atIndex === -1) return false;
  const domain = normalized.slice(atIndex + 1);
  if (!domain) return false;

  // Accept common education domains globally (.edu, .edu.xx, .ac.xx, edu.xx).
  return (
    /\.edu$/.test(domain) ||
    /\.edu\.[a-z]{2,}$/.test(domain) ||
    /\.ac\.[a-z]{2,}$/.test(domain) ||
    /^edu\.[a-z]{2,}$/.test(domain)
  );
}

router.post('/register', async (req, res) => {
  const { name, email, password, role } = req.body;
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!name || !email || !password || !['student', 'lecturer'].includes(role)) {
    return res.status(400).json({ error: 'name, email, password, and role (student|lecturer) required' });
  }
  if (!isEducationalEmail(normalizedEmail)) {
    return res.status(400).json({ error: 'Please use a valid educational email address' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const hash = await bcrypt.hash(password, 10);
  const id = uuid();
  db.prepare('INSERT INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)').run(id, name, normalizedEmail, hash, role);

  const token = jwt.sign({ id, name, email: normalizedEmail, role }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, user: { id, name, email: normalizedEmail, role } });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ id: user.id, name: user.name, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

module.exports = router;
