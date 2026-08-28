# Releasing Agent Teams

Agent Teams is currently released as beta software. Version tags trigger the
Windows release workflow in `.github/workflows/release.yml`. The workflow builds
from a clean checkout, verifies the project, creates a SHA-256 checksum and
publishes the installer as a GitHub Release.

## Clean verification

Before tagging, use a supported Node.js and npm version locally:

```powershell
npm ci
npm test
npm run audit
npm run build
```

The GitHub workflow repeats these checks and runs `npm run dist:win` on a clean
Windows runner. Generated installers remain outside Git history.

## Automated release

1. Update `package.json`, `package-lock.json`, `CHANGELOG.md` and the version in
   `README.md` through a reviewed pull request.
2. Wait for the `main` CI workflow to pass on Windows and Ubuntu.
3. Tag the exact reviewed `main` commit and push the tag:

```powershell
git switch main
git pull --ff-only origin main
git tag -a v1.1.0-beta.2 -m "Agent Teams 1.1.0-beta.2"
git push origin v1.1.0-beta.2
```

The tag must equal `v` followed by the version in `package.json`. Tags that
contain a hyphen, such as beta versions, are published as prereleases. The
workflow uploads the installer and its generated `SHA256SUMS.txt` file.

To sign future Windows releases, configure the repository secrets `CSC_LINK`
and `CSC_KEY_PASSWORD`. Electron Builder consumes these values during the build.
Without them, the workflow publishes an explicitly labelled unsigned beta.

## Release checks

Before publishing a release:

1. Review `CHANGELOG.md`, the version in `package.json`, and the lockfile.
2. Run the complete verification commands above.
3. Smoke-test the application with each supported provider.
4. Replace the default Electron icon with an original, project-owned icon.
5. Prefer signing the installer and executable with a trusted Windows
   code-signing certificate. Never commit signing secrets.
6. Tag only the exact reviewed `main` commit.
7. Verify the release workflow, Authenticode status and published SHA-256
   checksum before announcing the release.

An unsigned installer is suitable for a clearly labelled public beta but should
not be described as a trusted production release. macOS and Linux targets
require their own clean build, signing/notarization, and smoke-test process
before support is claimed.

## Suggested verification commands

```powershell
Get-AuthenticodeSignature .\release\Agent-Teams-*-win-x64.exe
Get-FileHash .\release\Agent-Teams-*-win-x64.exe -Algorithm SHA256
```
