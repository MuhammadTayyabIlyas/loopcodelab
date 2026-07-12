// Pure generators + validation for the Microsoft Store packaging step (Phase 3).
// No fs/IO — server.js writes the files into the repo and the package builds on a
// GitHub Actions windows-latest runner (electron-builder appx target, unsigned — the
// Store re-signs). The `pwa` packaging is a validated MANUAL step via pwabuilder.com:
// PWABuilder has no packaging CLI/API (pwa-builder/pwabuilder#5470), so we validate the
// prerequisites and write the exact steps into SUBMISSION-WINDOWS.md instead.
import { semverTo4Part } from './windows-scaffold.mjs';

export const STORE_WORKFLOW_PATH = '.github/workflows/windows-store.yml';
export const STORE_DOC = 'SUBMISSION-WINDOWS.md';
export const STORE_PACKAGINGS = ['electron', 'pwa'];

// Partner Center package identity name, e.g. "12345PublisherName.AppName":
// 3-50 chars of [A-Za-z0-9.-], MAY start with a digit (Store-assigned prefix often does).
export function validIdentityName(s) {
  return /^[A-Za-z0-9.-]{3,50}$/.test(String(s || ''));
}

// Partner Center publisher id: "CN=<GUID>" (Windows Store certification subject).
export function validPublisherId(s) {
  return /^CN=.+/.test(String(s || ''));
}

// Fail-closed gate (spec: name the key). Store targets always need the Partner Center
// reservation values — they go into the appx identity (electron) or the pwabuilder form (pwa).
export function validateStoreInput({ packaging, identityName, publisher, publisherDisplayName, productName, version, previewUrl } = {}) {
  const errors = [];
  if (!STORE_PACKAGINGS.includes(packaging)) errors.push(`packaging must be one of: ${STORE_PACKAGINGS.join(', ')}`);
  if (!validIdentityName(identityName)) errors.push('identityName must be the Partner Center package identity (3-50 chars, letters/digits/dots/dashes), e.g. 12345Publisher.AppName');
  if (!validPublisherId(publisher)) errors.push('publisher must be the Partner Center publisher id, e.g. CN=xxxxxxxx-xxxx-…');
  if (!String(publisherDisplayName || '').trim()) errors.push('publisherDisplayName is required (Partner Center account display name)');
  else if (String(publisherDisplayName).trim().toLowerCase() === String(productName || '').trim().toLowerCase()) {
    errors.push('publisherDisplayName must differ from the product name (Store policy)');
  }
  if (!semverTo4Part(version)) errors.push('version must be semver x.y.z, e.g. 1.0.0');
  if (packaging === 'pwa' && !/^https:\/\//.test(String(previewUrl || ''))) {
    errors.push('the pwa packaging needs the live preview reachable over https (pwabuilder.com packages from the URL)');
  }
  return { ok: errors.length === 0, errors };
}

// appx applicationId: letters/digits only, must start with a letter.
export function electronApplicationId(productName) {
  const v = String(productName || '').replace(/[^A-Za-z0-9]/g, '');
  return /^[A-Za-z]/.test(v) ? v.slice(0, 64) : 'App';
}

// package.json for the committed Electron wrapper (store-electron/). The workflow stages
// the built web output into store-electron/web before `electron-builder --win appx`.
// buildResources is NOT "build" — many web apps build INTO ./build and electron-builder
// would misread it as its resources dir.
export function electronPackageJson({ productName, appId, version, identityName, publisher, publisherDisplayName }) {
  return {
    name: 'store-wrapper',
    productName,
    version,
    private: true,
    main: 'main.js',
    devDependencies: { electron: '^37.0.0', 'electron-builder': '^26.0.0' },
    build: {
      appId,
      productName,
      directories: { output: 'dist', buildResources: 'build-res' },
      files: ['main.js', 'web/**/*'],
      win: { target: ['appx'] },
      appx: {
        identityName,
        publisher,
        publisherDisplayName,
        applicationId: electronApplicationId(productName),
        displayName: productName,
      },
    },
  };
}

export function electronMainJs() {
  return `// Minimal Store wrapper: shows the bundled web app (staged into ./web at CI time).
const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'web', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
`;
}

// windows-latest workflow: build the web app (if it has an npm build), stage the output
// into the Electron wrapper with robocopy (exit codes >= 8 are real failures — 1 just
// means "files copied"), build the unsigned AppX, upload it as the windows-store artifact.
export function windowsStoreYaml({ frontendDir, hasNodeBuild }) {
  const webBuild = hasNodeBuild
    ? `      - name: Install & build web
        run: |
          npm ci || npm install
          npm run build
`
    : `      - name: (static web app — no build step)
        run: echo "using committed static output in ${frontendDir}"
`;
  return `name: Windows Store Package
on:
  workflow_dispatch: {}

jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
${webBuild}      - name: Stage web output into the Electron wrapper
        shell: pwsh
        run: |
          robocopy "${frontendDir}" store-electron/web /E /XD .git .github node_modules src-tauri store-electron /NFL /NDL /NJH /NJS
          if ($LASTEXITCODE -ge 8) { exit 1 } else { $global:LASTEXITCODE = 0 }
      - name: Build Store package (unsigned AppX — the Store re-signs it)
        shell: pwsh
        run: |
          cd store-electron
          npm install
          npx electron-builder --win appx
      - name: Upload Store package
        uses: actions/upload-artifact@v4
        with:
          name: windows-store
          path: |
            store-electron/dist/*.appx
            store-electron/dist/*.msix
          if-no-files-found: error
`;
}

const slugFile = (s) => String(s || 'app').toLowerCase()
  .replace(/[^a-z0-9._-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'app';
export function storeShareName(project) { return `${slugFile(project)}-store.appx`; }

export function storeSubmissionMd({ project, packaging, identityName, publisher, publisherDisplayName, version, previewUrl, appId } = {}) {
  return `# ${project || 'project'} — Microsoft Store submission

**Packaging:** ${packaging === 'pwa' ? 'PWA (pwabuilder.com, manual — leaner package)' : 'Electron AppX (automated on GitHub Actions)'}
**Identity:** \`${identityName || '(reserve in Partner Center)'}\` · **Publisher:** \`${publisher || 'CN=…'}\` (${publisherDisplayName || 'publisher'})
**App id:** \`${appId || ''}\` · **Version:** \`${version || '1.0.0'}\`

## 0. One-time: reserve the app in Partner Center (do this FIRST)

1. Register (free) at https://partner.microsoft.com/dashboard (Individual is fine).
2. **Apps and games → New product → App** → reserve the app name.
3. Open **Product identity** and copy the three values into webtmux Settings → Microsoft Store
   (or the Store dialog): **Package/Identity/Name** (identityName), **Package/Identity/Publisher**
   (\`CN=…\`), **Publisher display name**.

## 1. Get the Store package (unsigned — the Store re-signs it for free)

${packaging === 'pwa'
    ? `**PWA path (manual, ~2 min):** PWABuilder has no packaging CLI/API, so this step runs on
pwabuilder.com:
1. Open https://www.pwabuilder.com and enter the live preview URL: ${previewUrl || '(preview URL)'}
2. **Package for stores → Windows**, paste the three identity values above, version \`${version || '1.0.0'}\`.
3. Download the **MSIX** package (this app's PWA baseline was validated at build time).`
    : `**Electron path (automated):** the committed \`store-electron/\` wrapper + the
**"Windows Store Package"** GitHub Action build an unsigned \`.appx\`:
1. The webtmux "Build Store package" step dispatches the Action and shares the package to
   Google Drive (link + QR appear on the build page), or run **Actions → "Windows Store
   Package"** on GitHub yourself and download the **windows-store** artifact.

Alternative (leaner package, manual): feed the live preview URL${previewUrl ? ` (${previewUrl})` : ''}
to https://www.pwabuilder.com → **Package for stores → Windows** with the same identity values.`}

## 2. Submit

1. Partner Center → your app → **Start submission → Packages** → upload the \`.appx\`/\`.msix\`.
2. Fill listing (screenshots live in \`store-assets/\` if generated), pricing, age rating.
3. **Submit for certification** (first pass typically 24-72 h).

## Notes

- The package is **unsigned on purpose** — the Store re-signs uploads with Microsoft's cert;
  no code-signing certificate is needed for Store distribution.
- The direct-download installer (WINDOWS-INSTALLER.md) is separate: sign THAT with your own
  cert if you want SmartScreen-clean sideloading.
- Version bumps: Partner Center requires each submission's version to increase (semver here
  becomes the 4-part MSIX version x.y.z.0).
`;
}
