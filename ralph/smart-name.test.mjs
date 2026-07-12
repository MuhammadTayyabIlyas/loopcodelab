import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smartName, previewSafeProject } from './smart-name.mjs';

import crypto from 'node:crypto';
const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex'); // the real server hash

test('smartName: strips the agent persona preamble (the real failing case)', () => {
  const n = smartName('you are a multi-agent flutter firebase development team build a quiz app for pakistani students');
  assert.ok(!n.includes('multi-agent'), n);
  assert.ok(!n.startsWith('you'), n);
  assert.match(n, /quiz/);
  assert.ok(n.length <= 32, `len ${n.length}`);
});

test('smartName: common phrasings', () => {
  assert.equal(smartName('build me a todo list app'), 'todo-list-app');
  assert.equal(smartName('create a budgeting tool for freelancers'), 'budgeting-tool-freelancers');
  assert.match(smartName('a recipe sharing platform'), /recipe-sharing-platform/); // no action verb
});

test('smartName: always DNS-safe, non-empty, capped', () => {
  for (const idea of ['', '!!!', 'x', 'build a ' + 'word '.repeat(40)]) {
    const n = smartName(idea);
    assert.match(n, /^[a-z0-9-]*$/);
    assert.ok(n.length >= 1 && n.length <= 32);
    assert.ok(!n.startsWith('-') && !n.endsWith('-'));
  }
  assert.equal(smartName(''), 'project');
});

test('previewSafeProject: short names pass through unchanged', () => {
  assert.equal(previewSafeProject('quiz-app', 'tayyabcheema777', sha1), 'quiz-app');
  assert.equal(previewSafeProject('vajd', 'tayyabcheema777', sha1), 'vajd');
});

test('previewSafeProject: long name + tenant always fits 63-char label', () => {
  const long = 'you-are-a-multi-agent-flutter-firebase-development-team-build-a';
  const tenant = 'tayyabcheema777';
  const safe = previewSafeProject(long, tenant, sha1);
  const label = `${safe}--${tenant}`;
  assert.ok(label.length <= 63, `label is ${label.length} chars: ${label}`);
  assert.match(safe, /^[a-z0-9-]+$/);
  // distinct long names that share a prefix must not collide (hash disambiguates)
  const a = previewSafeProject(long + '-one', tenant, sha1);
  const b = previewSafeProject(long + '-two', tenant, sha1);
  assert.notEqual(a, b);
});

test('previewSafeProject: handles a very long tenant slug', () => {
  const safe = previewSafeProject('my-cool-project-name-here', 'a'.repeat(40), sha1);
  assert.ok((`${safe}--${'a'.repeat(40)}`).length <= 63);
});
