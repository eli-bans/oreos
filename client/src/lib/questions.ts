/** Split lecturer textarea into separate questions (blank line between each). */
export function questionsFromText(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((q) => q.trim())
    .filter(Boolean);
}

export function questionsToText(questions: string[]): string {
  return questions.join('\n\n');
}
