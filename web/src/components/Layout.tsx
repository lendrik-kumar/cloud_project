import { NavLink, Outlet } from 'react-router-dom';
import { useAuth, useMe } from '../auth-context';
import { RekognitionUsageMeter } from './RekognitionUsage';

export function Layout() {
  const me = useMe();
  const { signOut } = useAuth();
  const links =
    me.role === 'teacher'
      ? [
          { to: '/classes', label: 'Classes' },
          { to: '/students', label: 'Students' },
        ]
      : [{ to: '/', label: 'My attendance' }];

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="brand">
            <img src="/favicon.svg" alt="" width={26} height={26} />
            <span>CloudAttend</span>
          </NavLink>
          <nav className="nav">
            {links.map((l) => (
              <NavLink key={l.to} to={l.to} end={l.to === '/'} className="nav-link">
                {l.label}
              </NavLink>
            ))}
          </nav>
          <div className="user">
            <span className="user-email" title={me.email}>
              {me.email}
            </span>
            <span className="role-pill">{me.role}</span>
            <button type="button" className="btn btn-sm" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="main">
        <Outlet />
      </main>
      {me.role === 'teacher' && me.rekognitionUsage && (
        <footer className="footer">
          <RekognitionUsageMeter usage={me.rekognitionUsage} />
        </footer>
      )}
    </div>
  );
}
