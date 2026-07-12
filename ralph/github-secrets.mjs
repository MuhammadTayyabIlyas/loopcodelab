// Pure helpers for auto-wiring a repo's GitHub Actions secrets/variables for the Play release
// workflow (so "Submit to Play" sets them via `gh`, not the user by hand). The `gh` calls +
// keystore generation live in server.js; here we parse the repo slug and shape the secret set.
// No I/O — unit-tested.

// "https://github.com/owner/repo(.git)" or "git@github.com:owner/repo.git" -> "owner/repo".
export function parseRepoSlug(repoUrl) {
  const m = String(repoUrl || '').match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

// Build the Actions secrets (encrypted) + variables (plain) for play-release.yml from whatever
// inputs are available; omits missing ones so a partial wire still sets what it can.
export function playSecrets({ serviceAccountJson, keystore, packageName } = {}) {
  const secrets = {};
  if (serviceAccountJson) secrets.PLAY_SERVICE_ACCOUNT_JSON = serviceAccountJson;
  if (keystore?.keystoreBase64) {
    secrets.ANDROID_KEYSTORE_BASE64 = keystore.keystoreBase64;
    secrets.ANDROID_STORE_PASSWORD = keystore.storePassword || '';
    secrets.ANDROID_KEY_PASSWORD = keystore.keyPassword || '';
    secrets.ANDROID_KEY_ALIAS = keystore.keyAlias || 'upload';
  }
  const variables = {};
  if (packageName) variables.PLAY_PACKAGE_NAME = packageName;
  return { secrets, variables };
}
