// server/sudo.mjs — the per-session passwordless-sudo grant shared by the sudo
// toggle routes, the maintenance shell, and monitorTick's dead-session prune.
import { execFileAsync, audit } from './config.mjs';

// --- Per-session passwordless sudo toggle -----------------------------------
// webtmux runs as the unprivileged `tmuxweb` user. A narrow NOPASSWD entry lets
// it call ONLY `/usr/local/sbin/webtmux-sudo on|off|status`, which installs or
// removes a sudoers rule granting tmuxweb passwordless sudo. OS sudo is per-USER,
// not per-tmux-session, so we can't truly isolate it to one pane — instead we
// track which sessions the human switched on and keep the rule active while ANY
// is on. Turning the last one off withdraws sudo immediately (revocable mid-run,
// human-in-the-loop). Default OFF; reset to OFF on boot for a known-safe start.
const SUDO_CTL = '/usr/local/sbin/webtmux-sudo';
export const sudoSessions = new Set();
let sudoRuleActive = null; // last applied state; null = unknown (force a write)
export async function applySudoRule(on) {
  if (sudoRuleActive === on) return;
  await execFileAsync('sudo', ['-n', SUDO_CTL, on ? 'on' : 'off'], { timeout: 10_000 });
  sudoRuleActive = on;
  audit({ sudo: on ? 'on' : 'off', sessions: [...sudoSessions] });
}
export const reconcileSudo = () => applySudoRule(sudoSessions.size > 0);
