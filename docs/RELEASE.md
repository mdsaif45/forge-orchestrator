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

1. **Bump the version first**, in its own commit on `main`. The artifact filenames come
   from `package.json`, so a tag that disagrees with it produces binaries named after
   the previous release.
   ```bash
   npm version 0.2.0-alpha.2 --no-git-tag-version
   ```
2. **Tag the merge commit**:
   ```bash
   git tag -a v0.2.0-alpha.2 -m "Release v0.2.0-alpha.2"
   git push origin v0.2.0-alpha.2
   ```
3. **Automated CI/CD**:
   - Executes all format, lint, typecheck, unit, smoke, and UI test suites.
   - Builds production renderer and main process bundles.
   - Runs `electron-builder` to package NSIS and Portable binaries.
   - Publishes a draft release with the binaries and their blockmap attached.
4. **Publishing**:
   - Review the draft in the GitHub web interface and click **Publish release**.

### A draft release carries a placeholder tag

GitHub shows a draft as `untagged-<hash>`, and `gh release view <tag>` cannot find it,
because a draft is not bound to its tag until it is published. Inspect one with:

```bash
gh api repos/<owner>/<repo>/releases
```

The real git tag exists the whole time. This is normal GitHub behaviour, not a fault.

### What used to go wrong here

Both `v0.1.0-alpha.1` and `v0.2.0-alpha.2` came out with `prerelease: false` despite
the workflow passing `true`, and each left a stray duplicate draft. The cause was
`softprops/action-gh-release` racing GitHub's own tag-push draft: when it reuses an
existing draft rather than creating one, it patches the assets and not the flags.

An alpha marked `prerelease: false` is shown as **Latest** and goes onto the stable
auto-update channel, so it mattered — and both times it was caught only because this
document said to check by hand.

The workflow now calls `gh release create` directly, which has no reuse path, and a
verification step fails the run if more than one draft exists or the prerelease flag is
wrong. The manual check is no longer needed (#136).

---

## 6. First-Run Health Checks

Forge performs health checks on startup (`src/main/health/healthCheck.ts`):
- Node.js runtime environment >= v22.
- Git availability and CLI version verification.
- Storage directory write permissions for SQLite WAL persistence.
