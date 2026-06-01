function parseQuestions(raw) {
  try {
    const value = JSON.parse(raw || '[]');
    if (!Array.isArray(value)) return [];
    return value.map((q) => String(q).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function parseSessionRow(row) {
  if (!row) return null;
  return {
    ...row,
    constraints: JSON.parse(row.constraints || '{}'),
    questions: parseQuestions(row.questions),
  };
}

module.exports = { parseQuestions, parseSessionRow };
