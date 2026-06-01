const router = require('express').Router();
const { v4: uuid } = require('uuid');
const db = require('../db/schema');
const { requireAuth, requireRole } = require('../middleware/auth');
const { parseQuestions, parseSessionRow } = require('../sessionUtils');

function normalizeQuestions(input) {
  if (!input) return [];
  if (!Array.isArray(input)) return [];
  return input.map((q) => String(q).trim()).filter(Boolean);
}

function randomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// Lecturer: create a session
router.post('/', requireAuth, requireRole('lecturer'), (req, res) => {
  const { name, constraints = {}, questions } = req.body;
  if (!name) return res.status(400).json({ error: 'Session name required' });
  const normalizedQuestions = normalizeQuestions(questions);

  let code;
  do { code = randomCode(); }
  while (db.prepare('SELECT id FROM sessions WHERE join_code = ?').get(code));

  const id = uuid();
  db.prepare(`
    INSERT INTO sessions (id, name, lecturer_id, join_code, constraints, questions)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, req.user.id, code, JSON.stringify(constraints), JSON.stringify(normalizedQuestions));

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

// Student: restore latest saved work for this session
router.get('/:id/workspace', requireAuth, (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Not found' });

  const snap = db.prepare(`
    SELECT content, language, ts FROM snapshots
    WHERE session_id = ? AND student_id = ?
    ORDER BY ts DESC LIMIT 1
  `).get(req.params.id, req.user.id);

  if (snap?.content) {
    return res.json({
      content: snap.content,
      language: snap.language,
      hasSavedWork: true,
      savedAt: snap.ts,
    });
  }

  // Fallback: latest event that carried full editor text (between snapshot intervals)
  const recentEvents = db.prepare(`
    SELECT data FROM events
    WHERE session_id = ? AND student_id = ?
    ORDER BY ts DESC LIMIT 100
  `).all(req.params.id, req.user.id);

  for (const row of recentEvents) {
    try {
      const data = JSON.parse(row.data);
      if (typeof data.fullCode === 'string' && data.fullCode.length > 0) {
        const constraints = JSON.parse(session.constraints || '{}');
        return res.json({
          content: data.fullCode,
          language: data.language || constraints.language || 'javascript',
          hasSavedWork: true,
        });
      }
    } catch {
      // ignore malformed event payloads
    }
  }

  const constraints = JSON.parse(session.constraints || '{}');
  res.json({
    content: '',
    language: constraints.language || 'javascript',
    hasSavedWork: false,
  });
});

// Get single session
router.get('/:id', requireAuth, (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Not found' });
  res.json(parseSession(session));
});

// Lecturer: update status / constraints
router.patch('/:id', requireAuth, requireRole('lecturer'), (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND lecturer_id = ?').get(req.params.id, req.user.id);
  if (!session) return res.status(404).json({ error: 'Not found' });

  const { status, constraints, questions } = req.body;
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
  if (questions !== undefined) {
    updates.push('questions = ?');
    params.push(JSON.stringify(normalizeQuestions(questions)));
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
  return parseSessionRow(s);
}

module.exports = router;
