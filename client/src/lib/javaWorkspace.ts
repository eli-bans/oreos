export const JAVA_WORKSPACE_VERSION = 1;

export type JavaWorkspace = {
  v: typeof JAVA_WORKSPACE_VERSION;
  active: string;
  files: Record<string, string>;
};

export function isJavaWorkspace(content: string): boolean {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(trimmed) as Partial<JavaWorkspace>;
    return parsed.v === JAVA_WORKSPACE_VERSION && !!parsed.files && typeof parsed.active === 'string';
  } catch {
    return false;
  }
}

export function parseJavaWorkspace(content: string): JavaWorkspace | null {
  if (!isJavaWorkspace(content)) return null;
  try {
    const parsed = JSON.parse(content.trimStart()) as JavaWorkspace;
    const files = Object.fromEntries(
      Object.entries(parsed.files).filter(([name, src]) => name.endsWith('.java') && typeof src === 'string')
    );
    if (Object.keys(files).length === 0) return null;
    const active = parsed.active in files ? parsed.active : Object.keys(files)[0];
    return { v: JAVA_WORKSPACE_VERSION, active, files };
  } catch {
    return null;
  }
}

export function serializeJavaWorkspace(workspace: JavaWorkspace): string {
  return JSON.stringify(workspace);
}

export function createDefaultJavaWorkspace(sessionName: string): JavaWorkspace {
  const mainSource =
    `/**\n` +
    ` * Session: ${sessionName}\n` +
    ` * Good luck!\n` +
    ` */\n\n` +
    `public class Main {\n` +
    `    public static void main(String[] args) {\n` +
    `        \n` +
    `    }\n` +
    `}\n`;
  return {
    v: JAVA_WORKSPACE_VERSION,
    active: 'Main.java',
    files: { 'Main.java': mainSource },
  };
}

export function legacyToJavaWorkspace(content: string, sessionName: string): JavaWorkspace {
  const trimmed = content.trim();
  if (!trimmed) return createDefaultJavaWorkspace(sessionName);
  const parsed = parseJavaWorkspace(content);
  if (parsed) return parsed;
  return {
    v: JAVA_WORKSPACE_VERSION,
    active: 'Main.java',
    files: { 'Main.java': content },
  };
}

export function formatJavaWorkspaceForDisplay(content: string): string {
  const workspace = parseJavaWorkspace(content);
  if (!workspace) return content;
  const names = Object.keys(workspace.files).sort();
  if (names.length === 1) return workspace.files[names[0]];
  return names
    .map((name) => `// === ${name} ===\n${workspace.files[name]}`)
    .join('\n\n');
}

export function javaFilesToApiPayload(workspace: JavaWorkspace) {
  return {
    files: Object.entries(workspace.files).map(([name, source]) => ({ name, source })),
  };
}
