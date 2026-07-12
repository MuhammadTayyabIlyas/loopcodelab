import { useState } from 'react';
import { api } from '../api.js';
import { go } from '../App.jsx';

export default function Auth({ onDone }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ email: '', password: '', invite: '', name: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const signup = mode === 'signup';

  async function submit(e) {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      if (signup) await api.signup(form.email, form.password, form.invite, form.name);
      else await api.login(form.email, form.password);
      onDone?.();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="grid min-h-full place-items-center px-6 py-10">
      <form onSubmit={submit} className="card w-full max-w-sm">
        <button type="button" className="mb-4 text-xs text-muted hover:text-slate-600" onClick={() => go('/')}>← back</button>
        <h1 className="text-xl font-bold">{signup ? 'Create your account' : 'Welcome back'}</h1>
        <p className="mb-5 mt-1 text-sm text-muted">{signup ? 'Beta access requires an invite code.' : 'Sign in to your workspace.'}</p>

        {signup && (<>
          <label className="label">Name</label>
          <input className="input mb-3" value={form.name} onChange={set('name')} autoComplete="name" />
        </>)}
        <label className="label">Email</label>
        <input className="input mb-3" type="email" required value={form.email} onChange={set('email')} autoComplete="email" />
        <label className="label">Password</label>
        <input className="input mb-3" type="password" required minLength={8} value={form.password} onChange={set('password')}
          autoComplete={signup ? 'new-password' : 'current-password'} />
        {signup && (<>
          <label className="label">Invite code</label>
          <input className="input mb-3" value={form.invite} onChange={set('invite')} placeholder="beta invite" />
        </>)}

        <button className="btn-primary mt-2 w-full" disabled={busy}>{busy ? '…' : signup ? 'Create account' : 'Sign in'}</button>
        {err && <p className="mt-3 text-sm text-danger">{err}</p>}
        <p className="mt-4 text-center text-sm text-muted">
          {signup ? 'Already have an account? ' : 'No account? '}
          <button type="button" className="text-accent" onClick={() => { setErr(''); setMode(signup ? 'login' : 'signup'); }}>
            {signup ? 'Sign in' : 'Create one'}
          </button>
        </p>
      </form>
    </div>
  );
}
