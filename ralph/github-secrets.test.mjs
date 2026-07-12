import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRepoSlug, playSecrets } from './github-secrets.mjs';

test('parseRepoSlug handles https/.git/trailing-slash/ssh, rejects non-github', () => {
  assert.equal(parseRepoSlug('https://github.com/octo/snake-game'), 'octo/snake-game');
  assert.equal(parseRepoSlug('https://github.com/octo/snake-game.git'), 'octo/snake-game');
  assert.equal(parseRepoSlug('https://github.com/octo/snake-game/'), 'octo/snake-game');
  assert.equal(parseRepoSlug('git@github.com:octo/snake-game.git'), 'octo/snake-game');
  assert.equal(parseRepoSlug('https://gitlab.com/octo/x'), null);
  assert.equal(parseRepoSlug(''), null);
  assert.equal(parseRepoSlug(null), null);
});

test('playSecrets wires the full set when everything is present', () => {
  const { secrets, variables } = playSecrets({
    serviceAccountJson: '{"client_email":"x"}',
    keystore: { keystoreBase64: 'QUJD', storePassword: 'p1', keyPassword: 'p2', keyAlias: 'upload' },
    packageName: 'com.you.snake',
  });
  assert.equal(secrets.PLAY_SERVICE_ACCOUNT_JSON, '{"client_email":"x"}');
  assert.equal(secrets.ANDROID_KEYSTORE_BASE64, 'QUJD');
  assert.equal(secrets.ANDROID_STORE_PASSWORD, 'p1');
  assert.equal(secrets.ANDROID_KEY_PASSWORD, 'p2');
  assert.equal(secrets.ANDROID_KEY_ALIAS, 'upload');
  assert.equal(variables.PLAY_PACKAGE_NAME, 'com.you.snake');
});

test('playSecrets omits what is missing (partial wire)', () => {
  const r = playSecrets({ packageName: 'com.you.x' }); // no SA, no keystore
  assert.deepEqual(r.secrets, {});
  assert.deepEqual(r.variables, { PLAY_PACKAGE_NAME: 'com.you.x' });
  const k = playSecrets({ keystore: { keystoreBase64: 'QQ' } });
  assert.equal(k.secrets.ANDROID_KEYSTORE_BASE64, 'QQ');
  assert.equal(k.secrets.ANDROID_KEY_ALIAS, 'upload'); // defaulted
  assert.equal(Object.keys(k.variables).length, 0);
});
