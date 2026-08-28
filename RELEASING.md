# Releasing Agent Teams

Agent Teams is currently released as beta software. Public Windows installers
must be built from a clean checkout and code-signed before distribution.

## Clean verification

Use a supported Node.js and npm version, then run:

```powershell
npm ci
npm test
npm run audit
npm run dist:win
```

`npm ci` also downloads the Electron runtime used by the packager. The Windows
installer is written to `release/`.

## Release checks

Before publishing a release:

1. Review `CHANGELOG.md`, the version in `package.json`, and the lockfile.
2. Run the complete verification commands above on a clean machine or CI runner.
3. Smoke-test the unpacked application with each supported provider.
4. Replace the default Electron icon with an original, project-owned icon.
5. Sign the installer and executable with a trusted Windows code-signing
   certificate. Configure electron-builder through its documented `CSC_LINK`
   and `CSC_KEY_PASSWORD` environment variables or the appropriate certificate
   store; never commit signing secrets.
6. Verify the Authenticode signature and publish a SHA-256 checksum.
7. Tag the exact reviewed commit and attach only artifacts produced from it.

An unsigned installer is suitable for local testing but should not be described
as a trusted production release. macOS and Linux targets require their own clean
build, signing/notarization, and smoke-test process before support is claimed.

## Suggested verification commands

```powershell
Get-AuthenticodeSignature .\release\Agent-Teams-*-win-x64.exe
Get-FileHash .\release\Agent-Teams-*-win-x64.exe -Algorithm SHA256
```
