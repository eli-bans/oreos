const router = require('express').Router();
const { v4: uuid } = require('uuid');
const db = require('../db/schema');
const { requireAuth, requireRole } = require('../middleware/auth');

function randomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// Lecturer: create a session
router.post('/', requireAuth, requireRole('lecturer'), (req, res) => {
  const { name, constraints = {} } = req.body;
  if (!name) return res.status(400).json({ error: 'Session name required' });

  let code;
  do { code = randomCode(); }
  while (db.prepare('SELECT id FROM sessions WHERE join_code = ?').get(code));

  const id = uuid();
  db.prepare(`
    INSERT INTO sessions (id, name, lecturer_id, join_code, constraints)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name, req.user.id, code, JSON.stringify(constraints));

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  res.json(parseSession(session));
});

// Lecturer: list own sessions
router.get('/', requireAuth, requireRole('lecturer'), (req, res) => {
  const sessions = db.prepare('SELECT * FROM sessions WHERE lecturer_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json(sessions.map(parseSession));
});

// Anyone: get session by join code
router.get('/join/:code', requireAuth, (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE join_code = ?').get(req.params.code.toUpperCase());
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(parseSession(session));
});

// Get single session (lecturer)
router.get('/:id', requireAuth, (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Not found' });
  res.json(parseSession(session));
});

// Lecturer: update status / constraints
router.patch('/:id', requireAuth, requireRole('lecturer'), (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND lecturer_id = ?').get(req.params.id, req.user.id);
  if (!session) return res.status(404).json({ error: 'Not found' });

  const { status, constraints } = req.body;
  const updates = [];
  const params = [];

  if (status) {
    updates.push('status = ?');
    params.push(status);
    if (status === 'active') { updates.push('started_at = ?'); params.push(Date.now()); }
    if (status === 'ended')  { updates.push('ended_at = ?');   params.push(Date.now()); }
  }
  if (constraints !== undefined) {
    updates.push('constraints = ?');
    params.push(JSON.stringify(constraints));
  }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  params.push(req.params.id);
  db.prepare(`UPDATE sessions SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  res.json(parseSession(updated));
});

// Lecturer: get participants + latest snapshot for a session
router.get('/:id/participants', requireAuth, requireRole('lecturer'), (req, res) => {
  const participants = db.prepare(`
    SELECT u.id, u.name, u.email, p.joined_at,
      (SELECT content FROM snapshots WHERE session_id = ? AND student_id = u.id ORDER BY ts DESC LIMIT 1) as latest_code,
      (SELECT language FROM snapshots WHERE session_id = ? AND student_id = u.id ORDER BY ts DESC LIMIT 1) as language,
      (SELECT COUNT(*) FROM flags WHERE session_id = ? AND student_id = u.id) as flag_count
    FROM participants p
    JOIN users u ON u.id = p.student_id
    WHERE p.session_id = ?
  `).all(req.params.id, req.params.id, req.params.id, req.params.id);
  res.json(participants);
});

// Lecturer: get full event log for a student in a session
router.get('/:id/replay/:studentId', requireAuth, requireRole('lecturer'), (req, res) => {
  const events = db.prepare(`
    SELECT * FROM events WHERE session_id = ? AND student_id = ? ORDER BY ts ASC
  `).all(req.params.id, req.params.studentId);
  const snapshots = db.prepare(`
    SELECT * FROM snapshots WHERE session_id = ? AND student_id = ? ORDER BY ts ASC
  `).all(req.params.id, req.params.studentId);
  const flags = db.prepare(`
    SELECT * FROM flags WHERE session_id = ? AND student_id = ? ORDER BY ts ASC
  `).all(req.params.id, req.params.studentId);
  res.json({ events: events.map(e => ({ ...e, data: JSON.parse(e.data) })), snapshots, flags });
});

// Lecturer: get all flags for a session
router.get('/:id/flags', requireAuth, requireRole('lecturer'), (req, res) => {
  const flags = db.prepare(`
    SELECT f.*, u.name as student_name FROM flags f
    JOIN users u ON u.id = f.student_id
    WHERE f.session_id = ? ORDER BY f.ts DESC
  `).all(req.params.id);
  res.json(flags);
});

function parseSession(s) {
  return { ...s, constraints: JSON.parse(s.constraints) };
}

module.exports = router;
