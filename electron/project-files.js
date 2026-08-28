const fs = require('fs');
const path = require('path');

function writeProjectFile({ projectPath, filename, content }) {
  try {
    if (!projectPath) return { error: 'Kein Projekt-Ordner konfiguriert' };
    if (!filename || path.isAbsolute(filename) || typeof content !== 'string') return { error: 'Ungültige Datei' };
    if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) return { error: 'Datei ist größer als 2 MB' };
    const segments = filename.split(/[\\/]+/).filter(Boolean).map(segment => segment.toLowerCase());
    if (segments.some(segment => ['.git', '.svn', 'node_modules'].includes(segment))) {
      return { error: 'Geschützter Projektpfad' };
    }
    const projectRoot = path.resolve(projectPath);
    const filePath = path.resolve(projectRoot, filename);
    const relativePath = path.relative(projectRoot, filePath);
    if (!relativePath || relativePath.startsWith('..' + path.sep) || relativePath === '..' || path.isAbsolute(relativePath)) {
      return { error: 'Datei muss innerhalb des Projekt-Ordners liegen' };
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const created = !fs.existsSync(filePath);
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true, path: filePath, relativePath, created, bytes: Buffer.byteLength(content, 'utf8') };
  } catch (error) {
    return { error: error.message };
  }
}

function listProjectFiles({ projectPath }) {
  try {
    if (!projectPath || !fs.existsSync(projectPath)) return { files: [] };
    const projectRoot = path.resolve(projectPath);
    const files = [];
    const ignoredDirectories = new Set(['.git', '.svn', 'node_modules', '.agent-teams', 'dist', 'build', 'release']);
    function walk(directory, depth = 0) {
      if (depth > 6 || files.length >= 200) return;
      let entries = [];
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (files.length >= 200) break;
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!ignoredDirectories.has(entry.name.toLowerCase())) walk(fullPath, depth + 1);
        } else if (entry.isFile()) {
          files.push({ name: path.relative(projectRoot, fullPath), path: fullPath });
        }
      }
    }
    walk(projectRoot);
    return { files };
  } catch (error) {
    return { files: [], error: error.message };
  }
}

module.exports = { writeProjectFile, listProjectFiles };
