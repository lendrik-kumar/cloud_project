import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth-context';
import { Layout } from './components/Layout';
import { Alert, Empty, Loading } from './components/ui';
import { SignInPage } from './pages/SignInPage';
import { MyAttendancePage } from './pages/student/MyAttendancePage';
import { ClassesPage } from './pages/teacher/ClassesPage';
import { ClassLayout } from './pages/teacher/ClassLayout';
import { ClassReportPage } from './pages/teacher/ClassReportPage';
import { RosterPage } from './pages/teacher/RosterPage';
import { SessionPage } from './pages/teacher/SessionPage';
import { SessionsPage } from './pages/teacher/SessionsPage';
import { StudentsPage } from './pages/teacher/StudentsPage';
import { TakeAttendancePage } from './pages/teacher/TakeAttendancePage';
import { TeacherStudentReportPage } from './pages/teacher/TeacherStudentReportPage';

function NotFound() {
  return (
    <div className="page">
      <Empty title="Page not found">
        <a href="#/">Go to the start page</a>
      </Empty>
    </div>
  );
}

function TeacherRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/classes" replace />} />
        <Route path="classes" element={<ClassesPage />} />
        <Route path="classes/:classId" element={<ClassLayout />}>
          <Route index element={<RosterPage />} />
          <Route path="attendance" element={<TakeAttendancePage />} />
          <Route path="sessions" element={<SessionsPage />} />
          <Route path="sessions/:date" element={<SessionPage />} />
          <Route path="report" element={<ClassReportPage />} />
        </Route>
        <Route path="students" element={<StudentsPage />} />
        <Route path="students/:studentId/report" element={<TeacherStudentReportPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

function StudentRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<MyAttendancePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

function Gate() {
  const { state, signOut, refresh } = useAuth();
  switch (state.status) {
    case 'loading':
      return (
        <div className="auth-screen">
          <Loading label="Signing in…" />
        </div>
      );
    case 'signedOut':
      return <SignInPage />;
    case 'error':
      return (
        <div className="auth-screen">
          <div className="auth-card card">
            <h2>Could not load your account</h2>
            <Alert onRetry={() => void refresh()}>{state.message}</Alert>
            <button type="button" className="btn" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </div>
      );
    case 'signedIn':
      return state.me.role === 'teacher' ? <TeacherRoutes /> : <StudentRoutes />;
  }
}

export default function App() {
  // Hash routing: every URL loads index.html, so deep links work on S3/CloudFront
  // with relative asset paths and no rewrite rules.
  return (
    <HashRouter>
      <Gate />
    </HashRouter>
  );
}
