const BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

function getToken() {
  return localStorage.getItem('oreos_token');
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export const api = {
  register: (body: { name: string; email: string; password: string; role: 'student' | 'lecturer' }) =>
    request<{ token: string; user: User }>('/auth/register', { method: 'POST', body: JSON.stringify(body) }),

  login: (body: { email: string; password: string }) =>
    request<{ token: string; user: User }>('/auth/login', { method: 'POST', body: JSON.stringify(body) }),

  createSession: (body: { name: string; constraints?: Constraints }) =>
    request<Session>('/sessions', { method: 'POST', body: JSON.stringify(body) }),

  listSessions: () =>
    request<Session[]>('/sessions'),

  getSessionByCode: (code: string) =>
    request<Session>(`/sessions/join/${code}`),

  getSession: (id: string) =>
    request<Session>(`/sessions/${id}`),

  updateSession: (id: string, body: Partial<{ status: string; constraints: Constraints }>) =>
    request<Session>(`/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  getParticipants: (sessionId: string) =>
    request<Participant[]>(`/sessions/${sessionId}/participants`),

  getReplay: (sessionId: string, studentId: string) =>
    request<ReplayData>(`/sessions/${sessionId}/replay/${studentId}`),

  getFlags: (sessionId: string) =>
    request<Flag[]>(`/sessions/${sessionId}/flags`),
};

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'student' | 'lecturer';
}

export interface Constraints {
  allowPaste?: boolean;
  allowTabSwitch?: boolean;
  language?: string;
  timeLimit?: number; // seconds
}

export interface Session {
  id: string;
  name: string;
  lecturer_id: string;
  join_code: string;
  status: 'waiting' | 'active' | 'ended';
  constraints: Constraints;
  created_at: number;
  started_at?: number;
  ended_at?: number;
}

export interface Participant {
  id: string;
  name: string;
  email: string;
  joined_at: number;
  latest_code?: string;
  language?: string;
  flag_count: number;
}

export interface ReplayData {
  events: ReplayEvent[];
  snapshots: Snapshot[];
  flags: Flag[];
}

export interface ReplayEvent {
  id: string;
  session_id: string;
  student_id: string;
  type: string;
  data: Record<string, unknown>;
  ts: number;
}

export interface Snapshot {
  id: string;
  session_id: string;
  student_id: string;
  content: string;
  language: string;
  ts: number;
}

export interface Flag {
  id: string;
  session_id: string;
  student_id: string;
  student_name?: string;
  type: string;
  detail?: string;
  ts: number;
}
