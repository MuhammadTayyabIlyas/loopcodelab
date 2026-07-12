import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTrack, validBundleId, defaultBundleId,
  playWorkflowYaml, codemagicYaml, playChecklistMd, iosChecklistMd,
  PLAY_WORKFLOW_PATH, IOS_WORKFLOW_PATH, submissionDoc, STORES,
} from './store-submit.mjs';

test('normalizeTrack validates and defaults to internal', () => {
  assert.equal(normalizeTrack('beta'), 'beta');
  assert.equal(normalizeTrack('garbage'), 'internal');
  assert.deepEqual(STORES, ['play', 'ios']);
});

test('bundle id validation + default', () => {
  assert.equal(validBundleId('com.tayyab.snake'), true);
  assert.equal(validBundleId('snake'), false); // needs a dot
  assert.equal(validBundleId('1com.x.y'), false); // can't start with digit
  assert.equal(defaultBundleId('My App!'), 'com.example.myapp');
});

test('playWorkflowYaml mirrors the proven apkipa pipeline', () => {
  const y = playWorkflowYaml({ track: 'alpha', status: 'draft' });
  assert.match(y, /flutter build appbundle/);
  assert.match(y, /r0adkll\/upload-google-play@v1/);
  assert.match(y, /track: alpha/);
  assert.match(y, /status: draft/);
  assert.match(y, /run_number \}\} \+ 10/);      // monotonic versionCode
  assert.match(y, /flutter analyze/);            // quality gate
  assert.match(y, /flutter test/);
  assert.match(y, /vars\.PLAY_PACKAGE_NAME/);    // generic packageName
  assert.match(y, /flutter-version: 3\.44\.4/);  // pinned
  assert.match(y, /workflow_dispatch/);
});

test('playWorkflowYaml sanitizes bad track/status', () => {
  const y = playWorkflowYaml({ track: 'zzz', status: 'nope' });
  assert.match(y, /track: internal/);
  assert.match(y, /status: completed/);
});

test('codemagicYaml mirrors apkipa managed-signing iOS build', () => {
  const y = codemagicYaml({ bundleId: 'com.tayyab.snake', integration: 'MyKey' });
  assert.match(y, /instance_type: mac_mini_m2/);
  assert.match(y, /app_store_connect: MyKey/);
  assert.match(y, /bundle_identifier: com\.tayyab\.snake/);
  assert.match(y, /flutter build ipa --release/);
  assert.match(y, /submit_to_testflight: true/);
});

test('codemagicYaml falls back on bad bundle id + sanitizes integration', () => {
  const y = codemagicYaml({ bundleId: 'nope', integration: 'bad name!' });
  assert.match(y, /bundle_identifier: com\.example\.app/);
  assert.match(y, /app_store_connect: badname/);
});

test('checklists name the right files + key prerequisites', () => {
  assert.equal(PLAY_WORKFLOW_PATH, '.github/workflows/play-release.yml');
  assert.equal(IOS_WORKFLOW_PATH, 'codemagic.yaml');
  assert.equal(submissionDoc('ios'), 'SUBMISSION-IOS.md');
  assert.equal(submissionDoc('play'), 'SUBMISSION-PLAY.md');
  const p = playChecklistMd({ project: 'snake', track: 'internal' });
  assert.match(p, /PLAY_SERVICE_ACCOUNT_JSON/);
  assert.match(p, /Service Accounts/);          // how to get the JSON
  assert.match(p, /first .*\.aab upload/i);      // manual first upload
  assert.match(p, /12 testers/);                // closed-testing production gate
  assert.match(p, /continuous days/);
  const i = iosChecklistMd({ project: 'snake', bundleId: 'com.x.snake', integration: 'CodemagicAppStoreKey' });
  assert.match(i, /Apple Developer Program/);
  assert.match(i, /CodemagicAppStoreKey/);
  assert.match(i, /com\.x\.snake/);
  assert.match(i, /flutterfire configure/); // firebase iOS crash note
});
