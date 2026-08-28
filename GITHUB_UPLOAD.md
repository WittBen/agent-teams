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

Do not commit the installer to the source repository. Create a GitHub Release
for tag `v1.1.0-beta.1`, attach the `.exe` from the prepared `GitHub-Upload`
folder, and publish its SHA-256 checksum from `SHA256SUMS.txt`.

The current installer is unsigned. Mark it clearly as an unsigned beta build,
or sign it with a trusted code-signing certificate before public distribution.
See `RELEASING.md` for the complete release checklist.
