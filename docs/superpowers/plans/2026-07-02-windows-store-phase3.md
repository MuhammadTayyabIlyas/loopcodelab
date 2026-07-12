# Windows installer Phase 3 — Microsoft Store packaging (plan)

Spec: `docs/superpowers/specs/2026-07-01-pwa-default-windows-packaging-design.md` (P3).
Builds on the proven Phase 2 plumbing: scaffold+push → `windows-delivering` phase →
`ralph-windows-deliver.sh` (dispatch/poll/download Actions artifact) → Drive link+QR → reap.

## Design adjustment vs. the spec (verified 2026-07-02)

The spec assumed a **PWABuilder CLI** could produce the Store MSIX from the preview URL on the
Actions runner. That CLI does not exist: `@pwabuilder/cli` only supports create/start/build
(no platform packaging), the legacy PWABuilder-CLI is archived/unmaintained, and packaging is
only available through the pwabuilder.com web UI (pwa-builder/pwabuilder#5470, open as of
2026-03). There is no documented HTTP API either. Therefore:

- **`electron` packaging (automated, default):** electron-builder `appx` target on the
  `windows-latest` runner — deterministic, documented, unsigned (the Store re-signs for free).
  This is the automated Store path.
- **`pwa` packaging (manual, leaner package):** a validated checklist step — the user feeds the
  live preview URL to pwabuilder.com and downloads the MSIX (~2 min). We validate the
  prerequisites (HTTPS preview, PWA baseline from `run.pwa`, Partner Center identity) and write
  the exact steps into `SUBMISSION-WINDOWS.md`. If PWABuilder ever ships a CLI/API, this
  becomes an automated packager with no architectural change.

## Deliverables

1. **`ralph/windows-store.mjs`** (pure, TDD): `STORE_WORKFLOW_PATH`, `STORE_DOC`,
   `validateStoreInput` (fail-closed: packaging ∈ {pwa,electron}; Partner Center identity trio
   present + well-formed — identityName, `CN=…` publisher id, publisherDisplayName ≠ product
   name; semver; pwa → HTTPS preview URL), `electronPackageJson` / `electronMainJs`
   (wrapper loading the built web output from `store-electron/web`), `windowsStoreYaml`
   (robocopy the web output into the wrapper → `npx electron-builder --win appx` → upload
   `windows-store` artifact), `storeShareName` (`<slug>-store.appx`),
   `storeSubmissionMd` (reserve-first Partner Center checklist, both packagings).
2. **`ralph/ralph-windows-deliver.sh`**: `--workflow` / `--artifact` / `--kind store` params
   (store artifact matches `*.appx`/`*.msix`; installer unchanged `*.exe`/`*.msi`).
3. **server.js**: `VAULT_PROVIDERS` += `windows-store` (Partner Center identity JSON),
   `windows-signing` (optional installer code-signing cert JSON — wired as Actions secrets,
   never committed). `prepareWindowsStore` + `POST /api/ralph/windows/store` (electron →
   `windows-delivering` with `run.windowsDeliverKind='store'`; pwa → checklist only, no phase).
   Reap branches on the kind; DELIVERABLE.md composes installer + store links.
   `POST /api/ralph/windows/submit` → refresh `SUBMISSION-WINDOWS.md`, wire
   `WINDOWS_CERT_BASE64`/`WINDOWS_CERT_PASSWORD` secrets when the vault key exists
   (best-effort, mirrors Play), record `run.windows.submit`.
4. **UI**: web/ BuildDetail "🏪 Build Store package" (dialog: packaging + identity + version)
   + "🏬 Submit to Store" + store ready panel; Settings/Admin "Microsoft Store" +
   "Windows signing" cards; PWA status-dialog equivalents. sw VERSION bump; web build.
5. **Stub e2e** (`RALPH_FORCE_TOOL` + fake remote) + docs. One real Actions smoke of the
   electron appx job before relying on it (same caveat discipline as Phase 2a).

## Non-goals (unchanged from spec)

No automated Partner Center submission (reserve app + upload stay manual); no paid
Tauri→Store route; no macOS/Linux targets; single delivery at a time per run (phase-gated).
