import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';
import AuthPage from '@/pages/AuthPage';
import LecturerHome from '@/pages/lecturer/LecturerHome';
import LecturerSession from '@/pages/lecturer/LecturerSession';
import LecturerReplay from '@/pages/lecturer/LecturerReplay';
import StudentLobby from '@/pages/student/StudentLobby';
import StudentIDE from '@/pages/student/StudentIDE';

function RequireAuth({ children, role }: { children: React.ReactNode; role?: string }) {
  const { user } = useAuthStore();
  if (!user) return <Navigate to="/auth" replace />;
  if (role && user.role !== role) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function RoleRedirect() {
  const { user } = useAuthStore();
  if (!user) return <Navigate to="/auth" replace />;
  return <Navigate to={user.role === 'lecturer' ? '/lecturer' : '/student'} replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<RoleRedirect />} />
        <Route path="/auth" element={<AuthPage />} />
        <Route path="/lecturer" element={<RequireAuth role="lecturer"><LecturerHome /></RequireAuth>} />
        <Route path="/lecturer/session/:id" element={<RequireAuth role="lecturer"><LecturerSession /></RequireAuth>} />
        <Route path="/lecturer/session/:id/replay/:studentId" element={<RequireAuth role="lecturer"><LecturerReplay /></RequireAuth>} />
        <Route path="/student" element={<RequireAuth role="student"><StudentLobby /></RequireAuth>} />
        <Route path="/student/ide/:sessionId" element={<RequireAuth role="student"><StudentIDE /></RequireAuth>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
