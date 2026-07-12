import zlib from 'node:zlib';
// Pure generators for the Windows-installer scaffold (Phase 2a). No fs/IO — the file
// contents and validation live here (unit-tested); server.js writes them into the repo.
// The installer itself builds on a GitHub Actions windows-latest runner via Tauri v2.

export const WINDOWS_WORKFLOW_PATH = '.github/workflows/windows-package.yml';
export const WINDOWS_CHECKLIST_DOC = 'WINDOWS-INSTALLER.md';

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 30) || 'app';
export function defaultWindowsAppId(project) { return `com.webtmux.${slug(project)}`; }

// Tauri identifier: 2+ dot segments, each starting with a letter, [a-z0-9-] after.
export function validWindowsAppId(s) {
  const v = String(s || '');
  if (!/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/.test(v)) return false;
  return !v.endsWith('.');
}

export function sanitizeProductName(input, project) {
  const v = String(input ?? '').trim();
  return (v || String(project || 'App')).slice(0, 60);
}

export function semverTo4Part(v) {
  return /^\d+\.\d+\.\d+$/.test(String(v || '')) ? `${v}.0` : null;
}

export function validateWindowsInput({ appId, productName, version } = {}) {
  const errors = [];
  if (!validWindowsAppId(appId)) errors.push('appId must be reverse-DNS, e.g. com.acme.app');
  if (!semverTo4Part(version)) errors.push('version must be semver x.y.z, e.g. 1.0.0');
  return { ok: errors.length === 0, errors };
}

export function tauriConfJson({ productName, appId, version, frontendDist, beforeBuildCommand = '' }) {
  return {
    $schema: 'https://schema.tauri.app/config/2',
    productName,
    version,
    identifier: appId,
    // Only frontendDist (+ beforeBuildCommand when set). devUrl/beforeDevCommand are
    // OMITTED, not empty-stringed: Tauri v2 rejects `devUrl: ""` ("" is not a "uri").
    build: { frontendDist, ...(beforeBuildCommand ? { beforeBuildCommand } : {}) },
    app: {
      windows: [{ title: productName, width: 1200, height: 800, resizable: true }],
      security: { csp: null },
    },
    bundle: {
      active: true,
      targets: ['nsis', 'msi'],
      icon: ['icons/32x32.png', 'icons/128x128.png', 'icons/128x128@2x.png', 'icons/icon.icns', 'icons/icon.ico'],
    },
  };
}

export function cargoToml({ crateName }) {
  return `[package]
name = "${crateName}"
version = "0.0.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[[bin]]
name = "${crateName}"
path = "src/main.rs"
`;
}

export function buildRs() {
  return `fn main() {
    tauri_build::build()
}
`;
}

export function mainRs() {
  return `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
`;
}

// windows-latest workflow: build the web app (if it has an npm build), generate the
// Tauri icon set from a committed source png, then `tauri build`, and upload the
// installer artifacts. Uses the maintained @tauri-apps/cli.
export function windowsPackageYaml({ frontendDir, hasNodeBuild }) {
  const webBuild = hasNodeBuild
    ? `      - name: Install & build web
        run: |
          npm ci || npm install
          npm run build
`
    : `      - name: (static web app — no build step)
        run: echo "using committed static output in ${frontendDir}"
`;
  return `name: Windows Package
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
      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable
${webBuild}      - name: Install Tauri CLI
        run: npm install -g @tauri-apps/cli@^2
      - name: Generate app icons
        run: tauri icon src-tauri/icons/source.png
      - name: Build installer
        run: tauri build
      - name: Upload installer
        uses: actions/upload-artifact@v4
        with:
          name: windows-installer
          path: |
            src-tauri/target/release/bundle/nsis/*.exe
            src-tauri/target/release/bundle/msi/*.msi
          if-no-files-found: error
`;
}

export function windowsChecklistMd({ project, appId, version }) {
  return `# ${project} — Windows installer

This repo is scaffolded to build a Windows desktop installer (a native Tauri wrapper around the
built web app). The installer builds on a **GitHub Actions \`windows-latest\`** runner — nothing is
built on the server.

- **App identifier:** \`${appId}\`
- **Version:** \`${version}\`

## Build it
1. Push is already done. On GitHub, open **Actions → "Windows Package" → Run workflow**.
2. When the run finishes, open it and download the **\`windows-installer\`** artifact — it contains the
   \`.exe\` (NSIS) and \`.msi\` installers.
3. Run the \`.exe\` or \`.msi\` on a Windows machine to install the app.

## Notes
- The build wraps whatever the web app builds to (\`build/web\`/\`dist\`/\`build\`/\`out\`/\`public\`/root).
- For SmartScreen-clean installs, sign the installer with your own code-signing certificate (added in a
  later step). Unsigned installers show a SmartScreen prompt until the certificate earns reputation.
- App icons are generated from \`src-tauri/icons/source.png\`. Replace it with your brand icon (≥512×512
  PNG) for a branded installer.
`;
}

// A valid solid-color square PNG (RGB), used as a placeholder app icon so Tauri's
// `tauri icon` / `tauri build` always has a source (a missing icon fails the whole run).
// Pure + deterministic (zlib is a builtin transform; no fs/network). Returns a Buffer.
function pngCrc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = ((c >>> 1) ^ (0xEDB88320 & -(c & 1))) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(pngCrc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
export function pngSolidIcon(size = 512, rgb = [37, 99, 235]) {
  const n = Math.max(1, Math.floor(size));
  const [r, g, b] = rgb;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor RGB
  const row = Buffer.alloc(1 + n * 3);
  for (let x = 0; x < n; x++) { row[1 + x * 3] = r; row[1 + x * 3 + 1] = g; row[1 + x * 3 + 2] = b; }
  const raw = Buffer.concat(Array.from({ length: n }, () => Buffer.from(row)));
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}
