# GitHub upload

The prepared source archive contains the complete repository content but no
dependencies, generated builds, local Git history, credentials, conversations,
attachments, or other user data.

## Create the repository

1. Extract `Agent-Teams-Source-1.1.0-beta.1.zip` into an empty folder.
2. Create an empty GitHub repository without an automatically generated README,
   license, or `.gitignore`.
3. In the extracted folder, run:

```powershell
git init -b main
git add .
git commit -m "Initial open-source beta"
git remote add origin https://github.com/OWNER/REPOSITORY.git
git push -u origin main
```

Replace `OWNER/REPOSITORY` with the real GitHub location. Review the staged
files with `git status` before committing.

## Publish the Windows beta

Do not commit the installer to the source repository. After the repository is
prepared, merge `.github/workflows/release.yml` and push the matching version
tag. The workflow builds the installer from that tag and publishes a newly
generated SHA-256 checksum with the GitHub prerelease.

When signing secrets are not configured, the workflow marks the installer as an
unsigned beta build. See `RELEASING.md` for the complete release checklist.
