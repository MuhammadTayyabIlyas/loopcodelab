// Pure helper: which opted-in sudo sessions no longer correspond to a live tmux session.
// Used to auto-revoke the passwordless-sudo grant when a session (e.g. the root maintenance
// shell) ends on its own. No I/O — unit-tested in isolation.
export function deadSudoSessions(sudoNames, liveNames) {
  const live = new Set(liveNames || []);
  return [...(sudoNames || [])].filter((n) => !live.has(n));
}
