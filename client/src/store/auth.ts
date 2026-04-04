import { create } from 'zustand';
import { User } from '@/lib/api';

interface AuthState {
  user: User | null;
  token: string | null;
  setAuth: (user: User, token: string) => void;
  logout: () => void;
}

function loadFromStorage(): { user: User | null; token: string | null } {
  try {
    const token = localStorage.getItem('oreos_token');
    const user = localStorage.getItem('oreos_user');
    return { token, user: user ? JSON.parse(user) : null };
  } catch {
    return { user: null, token: null };
  }
}

export const useAuthStore = create<AuthState>((set) => ({
  ...loadFromStorage(),
  setAuth: (user, token) => {
    localStorage.setItem('oreos_token', token);
    localStorage.setItem('oreos_user', JSON.stringify(user));
    set({ user, token });
  },
  logout: () => {
    localStorage.removeItem('oreos_token');
    localStorage.removeItem('oreos_user');
    set({ user: null, token: null });
  },
}));
