import { useEffect, useState } from 'react';
import { api } from '../api.js';

// MCP connections manager — two flavors:
//   admin=true  → platform-wide servers (Admin dashboard), with a "share with
//                 all users" toggle
//   admin=false → the signed-in workspace's own connections (Settings)
export default function McpServers({ admin = false }) {
  const [servers, setServers] = useState(null);
  const [form, setForm] = useState({ name: '', url: '', auth: '', capabilities: '', shared: false });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const list = admin ? api.adminMcp : api.mcp;
  const add = admin ? api.adminAddMcp : api.addMcp;
  const del = admin ? api.adminDeleteMcp : api.deleteMcp;

  const load = () => list().then((d) => setServers(d.servers || [])).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    setBusy(true); setMsg('');
    try {
      await add({ ...form, capabilities: form.capabilities });
      setForm({ name: '', url: '', auth: '', capabilities: '', shared: false });
      setMsg('Connection added.');
      load();
    } catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  }
  async function remove(id) {
    setBusy(true); setMsg('');
    try { await del(id); load(); } catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="card">
      <h2 className="font-semibold">MCP connections</h2>
      <p className="mt-1 text-xs text-muted">
        {admin
          ? 'Platform-wide MCP servers (e.g. a Google Drive/Gmail gateway). Only your own builds use them unless you mark one "shared with all users" — then use a service account, not your personal grant.'
          : <>Connect your own tools (Gmail, Google Drive, Calendar…) so build agents can use them. Get a personal, pre-authorized MCP URL from Composio, Pipedream, or Zapier MCP — they handle the Google sign-in — and paste it here. Used only in your builds.</>}
      </p>

      {msg && <p className="mt-2 text-xs text-slate-600">{msg}</p>}

      {/* Existing servers */}
      <div className="mt-3 space-y-2">
        {servers === null && <p className="text-xs text-muted">Loading…</p>}
        {Array.isArray(servers) && servers.length === 0 && <p className="text-xs text-muted">No connections yet.</p>}
        {(servers || []).map((s) => (
          <div key={s.id} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-panel2/60 px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{s.name} {s.shared && <span className="badge bg-accent/15 text-accent">shared</span>}</p>
              <p className="truncate text-xs text-muted">{s.url} · {s.capabilities.join(', ')}{s.has_auth ? ' · 🔑' : ''}</p>
            </div>
            <button className="btn-ghost shrink-0 px-2 py-1 text-xs" disabled={busy} onClick={() => remove(s.id)}>Remove</button>
          </div>
        ))}
      </div>

      {/* Add form */}
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <input className="input" placeholder="Name (e.g. my-gdrive)" value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        <input className="input" placeholder="Capabilities (e.g. google-drive, gmail)" value={form.capabilities}
          onChange={(e) => setForm((f) => ({ ...f, capabilities: e.target.value }))} />
        <input className="input sm:col-span-2" placeholder="https://… MCP endpoint (SSE)" value={form.url}
          onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} />
        <input className="input sm:col-span-2" type="password" placeholder="Bearer token (optional — if the URL itself isn't secret-keyed)" value={form.auth}
          onChange={(e) => setForm((f) => ({ ...f, auth: e.target.value }))} />
        {admin && (
          <label className="flex items-center gap-2 text-xs text-slate-600 sm:col-span-2">
            <input type="checkbox" checked={form.shared} onChange={(e) => setForm((f) => ({ ...f, shared: e.target.checked }))} />
            Share with all users’ builds (otherwise owner-only)
          </label>
        )}
      </div>
      <button className="btn-primary mt-3 px-4 py-2 text-sm" disabled={busy || !form.name.trim() || !form.url.trim() || !form.capabilities.trim()} onClick={save}>
        Add connection
      </button>
    </div>
  );
}
