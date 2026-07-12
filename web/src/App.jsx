import { useEffect, useState } from 'react';
import { api } from './api.js';
import Landing from './pages/Landing.jsx';
import Auth from './pages/Auth.jsx';
import Dashboard from './pages/Dashboard.jsx';
import NewBuild from './pages/NewBuild.jsx';
import Settings from './pages/Settings.jsx';
import BuildDetail from './pages/BuildDetail.jsx';

// Tiny hash router (#/, #/login, #/app) — no router dependency.
function useHash() {
  const [hash, setHash] = useState(window.location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}
export const go = (h) => { window.location.hash = h; };

export default function App() {
  const hash = useHash();
  const [me, setMe] = useState(undefined); // undefined=loading, null=signed out, {}=user

  const refresh = () => api.me().then(setMe);
  useEffect(() => { refresh(); }, []);

  if (me === undefined) {
    return <div className="grid h-full place-items-center text-muted">Loading…</div>;
  }

  const route = hash.replace(/^#/, '');
  const open = me === 'open'; // single-tenant: dashboard usable without login
  const meOr = open ? { email: 'local', workspace: 'local', plan: null } : me;
  // Auth-gated surfaces: in open mode they're always reachable; otherwise need a session.
  const gated = (el) => (open ? el : me ? el : <Auth onDone={refresh} />);

  // The admin panel is not part of the single-tenant basic edition.
  if (route.startsWith('/new')) {
    return gated(<NewBuild />);
  }
  if (route.startsWith('/settings')) {
    return gated(<Settings me={meOr} open={open} />);
  }
  if (route.startsWith('/build/')) {
    return gated(<BuildDetail project={decodeURIComponent(route.slice('/build/'.length))} />);
  }
  if (route.startsWith('/app')) {
    if (open) return <Dashboard me={meOr} open />;
    return me ? <Dashboard me={me} onSignOut={() => api.logout().then(refresh)} /> : <Auth onDone={refresh} />;
  }
  if (route.startsWith('/login')) {
    if (open) { go('/app'); return null; }
    return <Auth onDone={() => { refresh(); go('/app'); }} />;
  }
  return <Landing me={me} />;
}
