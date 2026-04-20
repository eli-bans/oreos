const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const db = require('../db/schema');
const { JWT_SECRET } = require('../middleware/auth');

const SNAPSHOT_INTERVAL_MS = 5000;

module.exports = function attachSockets(io) {
  // Authenticate socket connections
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('No token'));
    try {
      socket.user = jwt.verify(token, JWT_SECRET);
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const { user } = socket;

    // --- STUDENT: join a session room ---
    socket.on('student:join', ({ sessionId }) => {
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
      if (!session) return socket.emit('error', 'Session not found');
      if (session.status === 'ended') return socket.emit('error', 'Session has ended');

      // Register participant if not already
      const existing = db.prepare('SELECT id FROM participants WHERE session_id = ? AND student_id = ?').get(sessionId, user.id);
      if (!existing) {
        db.prepare('INSERT INTO participants (id, session_id, student_id) VALUES (?, ?, ?)').run(uuid(), sessionId, user.id);
      }

      socket.join(`session:${sessionId}`);
      socket.sessionId = sessionId;
      socket.lastSnapshot = 0;

      // Notify lecturer room
      io.to(`lecturer:${sessionId}`).emit('student:joined', {
        studentId: user.id,
        name: user.name,
        email: user.email,
      });

      // Send current session state + constraints
      socket.emit('session:state', {
        status: session.status,
        constraints: JSON.parse(session.constraints),
      });
    });

    // --- STUDENT: code change event ---
    socket.on('student:keystroke', ({ sessionId, type, data, ts }) => {
      const eventId = uuid();
      db.prepare('INSERT INTO events (id, session_id, student_id, type, data, ts) VALUES (?, ?, ?, ?, ?, ?)')
        .run(eventId, sessionId, user.id, type, JSON.stringify(data ?? {}), ts ?? Date.now());

      // Throttled snapshot: save full code every SNAPSHOT_INTERVAL_MS
      const now = Date.now();
      if (data?.fullCode !== undefined && now - (socket.lastSnapshot || 0) >= SNAPSHOT_INTERVAL_MS) {
        db.prepare('INSERT INTO snapshots (id, session_id, student_id, content, language, ts) VALUES (?, ?, ?, ?, ?, ?)')
          .run(uuid(), sessionId, user.id, data.fullCode, data.language ?? 'javascript', now);
        socket.lastSnapshot = now;

        // Stream live code to lecturer
        io.to(`lecturer:${sessionId}`).emit('student:code_update', {
          studentId: user.id,
          code: data.fullCode,
          language: data.language ?? 'javascript',
          ts: now,
        });
      }

      // Always stream the raw event to lecturer for live monitoring
      io.to(`lecturer:${sessionId}`).emit('student:event', {
        studentId: user.id,
        name: user.name,
        type,
        data,
        ts: ts ?? Date.now(),
      });
    });

    // --- STUDENT: activity flag (tab switch, paste, idle, etc.) ---
    socket.on('student:flag', ({ sessionId, type, detail }) => {
      const flagId = uuid();
      const ts = Date.now();
      db.prepare('INSERT INTO flags (id, session_id, student_id, type, detail, ts) VALUES (?, ?, ?, ?, ?, ?)')
        .run(flagId, sessionId, user.id, type, detail ?? null, ts);

      io.to(`lecturer:${sessionId}`).emit('student:flagged', {
        id: flagId,
        session_id: sessionId,
        student_id: user.id,
        name: user.name,
        type,
        detail,
        ts,
      });
    });

    // --- LECTURER: watch a session ---
    socket.on('lecturer:watch', ({ sessionId }) => {
      const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND lecturer_id = ?').get(sessionId, user.id);
      if (!session) return socket.emit('error', 'Session not found or not yours');

      socket.join(`lecturer:${sessionId}`);

      // Send current participants with latest code
      const participants = db.prepare(`
        SELECT u.id, u.name, u.email, p.joined_at
        FROM participants p JOIN users u ON u.id = p.student_id
        WHERE p.session_id = ?
      `).all(sessionId);

      const withCode = participants.map(p => {
        const snap = db.prepare('SELECT content, language, ts FROM snapshots WHERE session_id = ? AND student_id = ? ORDER BY ts DESC LIMIT 1').get(sessionId, p.id);
        const flagCount = db.prepare('SELECT COUNT(*) as c FROM flags WHERE session_id = ? AND student_id = ?').get(sessionId, p.id);
        return { ...p, code: snap?.content ?? '', language: snap?.language ?? 'javascript', lastSeen: snap?.ts, flag_count: flagCount?.c ?? 0 };
      });

      socket.emit('session:participants', withCode);
    });

    // --- LECTURER: push constraint update to students ---
    socket.on('lecturer:update_constraints', ({ sessionId, constraints }) => {
      const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND lecturer_id = ?').get(sessionId, user.id);
      if (!session) return socket.emit('error', 'Not authorized');

      db.prepare('UPDATE sessions SET constraints = ? WHERE id = ?').run(JSON.stringify(constraints), sessionId);
      io.to(`session:${sessionId}`).emit('session:constraints_updated', constraints);
    });

    // --- LECTURER: change session status (start / end) ---
    socket.on('lecturer:set_status', ({ sessionId, status }) => {
      const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND lecturer_id = ?').get(sessionId, user.id);
      if (!session) return socket.emit('error', 'Not authorized');

      const updates = { status };
      if (status === 'active') updates.started_at = Math.floor(Date.now() / 1000);
      if (status === 'ended')  updates.ended_at   = Math.floor(Date.now() / 1000);

      db.prepare(`UPDATE sessions SET status = ?${status === 'active' ? ', started_at = ?' : status === 'ended' ? ', ended_at = ?' : ''} WHERE id = ?`)
        .run(...(status === 'waiting' ? [status, sessionId] : [status, updates.started_at ?? updates.ended_at, sessionId]));

      io.to(`session:${sessionId}`).emit('session:state', { status, constraints: JSON.parse(session.constraints) });
      io.to(`lecturer:${sessionId}`).emit('session:status_changed', { status });
    });

    socket.on('disconnect', () => {
      if (socket.sessionId) {
        io.to(`lecturer:${socket.sessionId}`).emit('student:left', { studentId: user.id });
      }
    });
  });
};
