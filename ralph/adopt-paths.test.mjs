import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSource, DENY_DIRS } from './adopt-paths.mjs';

const cfg = { projectsRoot: '/home/tmuxweb/projects', repoDir: '/var/www/app', allowRoot: '' };

test('accepts a normal directory', () => {
  assert.deepEqual(validateSource('/home/me/myapp', cfg), { ok: true, path: '/home/me/myapp' });
});
test('rejects a relative path', () => {
  assert.ok(validateSource('myapp', cfg).error);
});
test('rejects system directories', () => {
  for (const d of ['/', '/etc', '/root', '/usr', '/var']) assert.ok(validateSource(d, cfg).error, d);
  assert.ok(DENY_DIRS.includes('/etc'));
});
test('rejects the webtmux repo and its subdirs', () => {
  assert.ok(validateSource('/var/www/app', cfg).error);
  assert.ok(validateSource('/var/www/app/ralph', cfg).error);
});
test('rejects paths inside PROJECTS_ROOT (no self-adopt)', () => {
  assert.ok(validateSource('/home/tmuxweb/projects/foo', cfg).error);
});
test('enforces allowRoot when set', () => {
  const c = { ...cfg, allowRoot: '/srv/code' };
  assert.ok(validateSource('/home/me/x', c).error);
  assert.deepEqual(validateSource('/srv/code/x', c), { ok: true, path: '/srv/code/x' });
});
test('strips a trailing slash', () => {
  assert.deepEqual(validateSource('/home/me/app/', cfg), { ok: true, path: '/home/me/app' });
});
test('rejects subtrees of system directories', () => {
  for (const d of ['/proc/self', '/usr/local/app', '/var/run/x', '/etc/nginx']) assert.ok(validateSource(d, cfg).error, d);
});
test('still accepts a normal /home path', () => {
  assert.deepEqual(validateSource('/home/me/app', cfg), { ok: true, path: '/home/me/app' });
});

import { validateSshTarget, shRemoteQuote, parseSshLs } from './adopt-paths.mjs';

test('validateSshTarget: host must be allowlisted + path non-empty', () => {
  const hosts = ['prod', 'box1'];
  assert.deepEqual(validateSshTarget('prod', hosts, '/srv/app'), { ok: true, host: 'prod', path: '/srv/app' });
  assert.ok(validateSshTarget('nope', hosts, '/x').error);          // not allowlisted
  assert.ok(validateSshTarget('bad host', hosts, '/x').error);       // bad chars
  assert.ok(validateSshTarget('prod', hosts, '   ').error);          // empty path
  assert.ok(validateSshTarget('', hosts, '/x').error);
});

test('validateSshTarget rejects shell metacharacters in the path', () => {
  const hosts = ['prod'];
  for (const bad of ['/x;rm -rf /', '/x|y', '/x$(id)', '/x`id`', '/x&y', '/x\nrm']) {
    assert.ok(validateSshTarget('prod', hosts, bad).error, bad);
  }
  assert.ok(validateSshTarget('prod', hosts, '/srv/my app').ok); // spaces are fine
});

test('shRemoteQuote wraps + escapes single quotes, neutralizes metachars', () => {
  assert.equal(shRemoteQuote('/srv/app'), "'/srv/app'");
  assert.equal(shRemoteQuote("a'b"), "'a'\\''b'");
  // a malicious path becomes one inert single-quoted token
  assert.equal(shRemoteQuote('/x; rm -rf /'), "'/x; rm -rf /'");
});

test('parseSshLs: first line is pwd, dirs end with / and skip dot/node_modules', () => {
  const out = '/srv/app\n./\n../\nsrc/\n.git/\nnode_modules/\nREADME.md\npublic/\n';
  assert.deepEqual(parseSshLs(out), { path: '/srv/app', dirs: ['src', 'public'] });
  assert.deepEqual(parseSshLs(''), { path: '', dirs: [] });
});
