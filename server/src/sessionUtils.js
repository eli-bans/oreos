const db = require('./db/schema');

function parseQuestions(raw) {
  try {
    const value = JSON.parse(raw || '[]');
    if (!Array.isArray(value)) return [];
    return value.map((q) => String(q).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// Metadata only (never the BLOB) for the session's brief attachment, if any.
function getBriefMeta(sessionId) {
  const row = db
    .prepare('SELECT filename, mime, size, uploaded_at FROM session_briefs WHERE session_id = ?')
    .get(sessionId);
  if (!row) return null;
  return { filename: row.filename, mime: row.mime, size: row.size, uploaded_at: row.uploaded_at };
}

function parseSessionRow(row) {
  if (!row) return null;
  return {
    ...row,
    constraints: JSON.parse(row.constraints || '{}'),
    questions: parseQuestions(row.questions),
    brief: getBriefMeta(row.id),
  };
}

module.exports = { parseQuestions, parseSessionRow, getBriefMeta };
