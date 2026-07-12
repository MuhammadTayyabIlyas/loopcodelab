import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFlutterRun, flutterEnvAssignments, diskOkForBuild, FLUTTER_BUILD_FORMAT } from './flutter-env.mjs';

test('isFlutterRun only for the flutter-app output format', () => {
  assert.equal(isFlutterRun({ outputFormat: 'flutter-app' }), true);
  assert.equal(isFlutterRun({ outputFormat: 'web-app' }), false);
  assert.equal(isFlutterRun(null), false);
  assert.equal(isFlutterRun({}), false);
  assert.equal(FLUTTER_BUILD_FORMAT, 'flutter-app');
});

test('flutterEnvAssignments keeps $HOME literal and points caches under it', () => {
  const a = flutterEnvAssignments();
  assert.ok(a.includes('PUB_CACHE=$HOME/.pub-cache'));
  assert.ok(a.includes('GRADLE_USER_HOME=$HOME/.gradle'));
  assert.ok(a.includes('FLUTTER_ROOT=/opt/flutter'));
  assert.ok(a.includes('ANDROID_HOME=/opt/android-sdk'));
  const pathLine = a.find((x) => x.startsWith('PATH='));
  assert.ok(pathLine.includes('/opt/flutter/bin'));
  assert.ok(pathLine.includes('.pub-cache/bin')); // flutterfire after `dart pub global activate`
  assert.ok(pathLine.endsWith(':$PATH'));
});

test('flutterEnvAssignments honors a resolved home + custom roots', () => {
  const a = flutterEnvAssignments({ home: '/home/wt_x', flutterRoot: '/opt/fl', androidHome: '/opt/sdk' });
  assert.ok(a.includes('PUB_CACHE=/home/wt_x/.pub-cache'));
  assert.ok(a.includes('GRADLE_USER_HOME=/home/wt_x/.gradle'));
  assert.ok(a.includes('FLUTTER_ROOT=/opt/fl'));
});

test('diskOkForBuild thresholds at the GiB minimum', () => {
  assert.equal(diskOkForBuild(5 * 1024 ** 3), true);
  assert.equal(diskOkForBuild(2 * 1024 ** 3), false);
  assert.equal(diskOkForBuild(4 * 1024 ** 3, 3), true);
  assert.equal(diskOkForBuild('not-a-number'), false);
});
