# Release & Distribution Runbook

This document describes the packaging, release pipeline, code signing, and auto-update processes for **Forge**.

---

## 1. Distribution Targets

Forge is packaged with `electron-builder` into two Windows x64 distributions:

1. **NSIS Installer**: `Forge-<version>-windows-x64.exe`
   - Supports custom installation directories and desktop/start-menu shortcuts.
   - Preserves user databases (`forge.db`) and workspaces across upgrades.
2. **Portable Executable**: `Forge-<version>-portable-x64.exe`
   - Zero-install, standalone executable.

---

## 2. Packaging Commands

```bash
# Build production bundle and package Windows installer & portable binaries
npm run dist:win

# Build unpacked directory for inspection
npm run dist:dir
```

All distribution artifacts are output to the `dist/` directory.

---

## 3. Native Modules & Prebuilds

Forge uses native Node addons:
- `better-sqlite3`: N-API prebuilds are bundled directly.
- `node-pty`: Rebuilt automatically on target environments when required via `scripts/setup-native.mjs`.

---

## 4. Code Signing Policy

- **Development / Personal Use**: Unsigned builds by default. Windows SmartScreen may show an unknown publisher prompt on first run.
- **Production Signing**:
  Configure the following GitHub Actions secrets or environment variables:
  - `CSC_LINK`: Path or Base64-encoded string of the PKCS#12 (`.pfx`) certificate.
  - `CSC_KEY_PASSWORD`: Password for the signing certificate.

---

## 5. Release Workflow

Releases are automated via GitHub Actions (`.github/workflows/release.yml`):

1. **Tag Version**:
   ```bash
   git tag -a v0.1.0 -m "Release v0.1.0"
   git push origin v0.1.0
   ```
2. **Automated CI/CD**:
   - Executes all format, lint, typecheck, unit, smoke, and UI test suites.
   - Builds production renderer and main process bundles.
   - Runs `electron-builder` to package NSIS and Portable binaries.
   - Publishes a draft release to GitHub Releases with attached installer binaries, checksums, and auto-generated release notes.
3. **Publishing**:
   - Review draft release notes in GitHub web interface and click **Publish release**.

---

## 6. First-Run Health Checks

Forge performs health checks on startup (`src/main/health/healthCheck.ts`):
- Node.js runtime environment >= v22.
- Git availability and CLI version verification.
- Storage directory write permissions for SQLite WAL persistence.
