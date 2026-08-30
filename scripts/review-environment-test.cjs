const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const JSZip = require('jszip');

const { createArtifactSandbox } = require('../electron/artifact-sandbox');
const {
  ReviewRunner, appendBounded, commandFingerprint, normalizeReviewEnvironment, normalizePreviewUrl,
} = require('../electron/review-runner');

async function createMinimalDocx(targetPath, text = 'Hallo Projekt') {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body>
</w:document>`);
  fs.writeFileSync(targetPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

function temporaryReviewProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-review-'));
  const projectPath = path.join(root, 'project');
  const snapshotRoot = path.join(root, 'snapshots');
  fs.mkdirSync(projectPath);
  return { root, projectPath, snapshotRoot, sandbox: createArtifactSandbox({ snapshotRoot }) };
}

test('artifact review stays inside the project and hides sensitive paths', async () => {
  const fixture = temporaryReviewProject();
  try {
    fs.mkdirSync(path.join(fixture.projectPath, 'src'));
    fs.mkdirSync(path.join(fixture.projectPath, 'node_modules'));
    fs.writeFileSync(path.join(fixture.projectPath, 'src', 'notes.md'), '# Prüfung\nOK', 'utf8');
    fs.writeFileSync(path.join(fixture.projectPath, '.env'), 'TOKEN=secret', 'utf8');
    fs.writeFileSync(path.join(fixture.projectPath, 'credentials.json'), '{"secret":true}', 'utf8');
    fs.writeFileSync(path.join(fixture.projectPath, 'node_modules', 'hidden.js'), 'hidden', 'utf8');

    const listed = fixture.sandbox.list({ projectPath: fixture.projectPath });
    assert.deepEqual(listed.files.map(file => file.relativePath.replace(/\\/g, '/')), ['src/notes.md']);
    await assert.rejects(() => fixture.sandbox.inspect({ projectPath: fixture.projectPath, relativePath: '../outside.txt' }), /Ungültiger/);
    await assert.rejects(() => fixture.sandbox.inspect({ projectPath: fixture.projectPath, relativePath: '.env' }), /Sensible/);
    await assert.rejects(() => fixture.sandbox.inspect({ projectPath: fixture.projectPath, relativePath: 'node_modules/hidden.js' }), /Geschützter/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('text edits create snapshots, reject stale writes and restore exactly', async () => {
  const fixture = temporaryReviewProject();
  try {
    const target = path.join(fixture.projectPath, 'notes.md');
    fs.writeFileSync(target, 'Version eins', 'utf8');
    const inspected = await fixture.sandbox.inspect({ projectPath: fixture.projectPath, relativePath: 'notes.md' });
    const saved = await fixture.sandbox.saveText({
      projectPath: fixture.projectPath, relativePath: 'notes.md', content: 'Version zwei', expectedMtimeMs: inspected.mtimeMs,
    });
    assert.equal(fs.readFileSync(target, 'utf8'), 'Version zwei');
    assert.equal(saved.snapshot.sha256.length, 64);
    assert.equal(fixture.sandbox.listSnapshots({ projectPath: fixture.projectPath, relativePath: 'notes.md' }).snapshots.length, 1);

    fs.writeFileSync(target, 'Extern geändert', 'utf8');
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(target, future, future);
    await assert.rejects(() => fixture.sandbox.saveText({
      projectPath: fixture.projectPath, relativePath: 'notes.md', content: 'Darf nicht gewinnen', expectedMtimeMs: saved.artifact.mtimeMs,
    }), /zwischenzeitlich verändert/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'Extern geändert');

    const restored = await fixture.sandbox.restoreSnapshot({ projectPath: fixture.projectPath, snapshotId: saved.snapshot.id });
    assert.equal(restored.artifact.content, 'Version eins');
    assert.equal(fs.readFileSync(target, 'utf8'), 'Version eins');
    assert.match(restored.rollbackSnapshot.reason, /Wiederherstellung/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('images preview locally and oversized text is not loaded into the editor', async () => {
  const fixture = temporaryReviewProject();
  try {
    fs.writeFileSync(path.join(fixture.projectPath, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', 'base64'));
    fs.writeFileSync(path.join(fixture.projectPath, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
    const image = await fixture.sandbox.inspect({ projectPath: fixture.projectPath, relativePath: 'pixel.png' });
    const large = await fixture.sandbox.inspect({ projectPath: fixture.projectPath, relativePath: 'large.txt' });
    assert.match(image.dataUrl, /^data:image\/png;base64,/);
    assert.match(large.error, /zu groß/);
    assert.equal(large.content, undefined);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Word text is inspected, replaced safely, snapshotted and restored', async () => {
  const fixture = temporaryReviewProject();
  try {
    const target = path.join(fixture.projectPath, 'brief.docx');
    await createMinimalDocx(target, 'Hallo Projekt');
    const before = await fixture.sandbox.inspect({ projectPath: fixture.projectPath, relativePath: 'brief.docx' });
    assert.equal(before.kind, 'word');
    assert.match(before.text, /Hallo Projekt/);
    assert.equal(before.details.paragraphs, 1);
    assert.equal(before.details.visualLayoutChecked, false);

    const replaced = await fixture.sandbox.replaceWordText({
      projectPath: fixture.projectPath, relativePath: 'brief.docx', findText: 'Projekt', replaceText: 'Team', expectedMtimeMs: before.mtimeMs,
    });
    assert.equal(replaced.replacements, 1);
    assert.match(replaced.artifact.text, /Hallo Team/);
    assert.doesNotMatch(replaced.artifact.text, /Hallo Projekt/);

    const zip = await JSZip.loadAsync(fs.readFileSync(target));
    assert.ok(zip.file('word/document.xml'));
    await fixture.sandbox.restoreSnapshot({ projectPath: fixture.projectPath, snapshotId: replaced.snapshot.id });
    assert.match((await fixture.sandbox.inspect({ projectPath: fixture.projectPath, relativePath: 'brief.docx' })).text, /Hallo Projekt/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Word replacement refuses text split across formatting runs', async () => {
  const fixture = temporaryReviewProject();
  try {
    const target = path.join(fixture.projectPath, 'formatted.docx');
    await createMinimalDocx(target, 'Platzhalter');
    const zip = await JSZip.loadAsync(fs.readFileSync(target));
    zip.file('word/document.xml', (await zip.file('word/document.xml').async('string')).replace(
      '<w:r><w:t>Platzhalter</w:t></w:r>', '<w:r><w:t>Hallo </w:t></w:r><w:r><w:t>Projekt</w:t></w:r>',
    ));
    fs.writeFileSync(target, await zip.generateAsync({ type: 'nodebuffer' }));
    await assert.rejects(() => fixture.sandbox.replaceWordText({
      projectPath: fixture.projectPath, relativePath: 'formatted.docx', findText: 'Hallo Projekt', replaceText: 'Hallo Team',
    }), /Layoutschutzgründen/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('DOCX archives with excessive entry counts are rejected before extraction', async () => {
  const fixture = temporaryReviewProject();
  try {
    const target = path.join(fixture.projectPath, 'archive-bomb.docx');
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>');
    for (let index = 0; index < 5000; index += 1) zip.file(`word/media/empty-${index}.bin`, '');
    fs.writeFileSync(target, await zip.generateAsync({ type: 'nodebuffer' }));
    await assert.rejects(() => fixture.sandbox.inspect({ projectPath: fixture.projectPath, relativePath: 'archive-bomb.docx' }), /zu viele Bestandteile/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('symbolic links cannot escape the reviewed project', async t => {
  const fixture = temporaryReviewProject();
  try {
    const outside = path.join(fixture.root, 'outside.txt');
    fs.writeFileSync(outside, 'outside', 'utf8');
    let relativePath = 'linked.txt';
    try {
      fs.symlinkSync(outside, path.join(fixture.projectPath, relativePath), 'file');
    } catch (error) {
      if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
      const outsideDirectory = path.join(fixture.root, 'outside-directory');
      fs.mkdirSync(outsideDirectory);
      fs.writeFileSync(path.join(outsideDirectory, 'outside.txt'), 'outside', 'utf8');
      relativePath = path.join('linked-directory', 'outside.txt');
      try {
        fs.symlinkSync(outsideDirectory, path.join(fixture.projectPath, 'linked-directory'), 'junction');
      } catch (junctionError) {
        if (['EPERM', 'EACCES'].includes(junctionError.code)) return t.skip('Symlink and junction creation are not permitted on this Windows host.');
        throw junctionError;
      }
    }
    assert.equal(fixture.sandbox.list({ projectPath: fixture.projectPath }).files.some(file => file.relativePath.includes('linked')), false);
    await assert.rejects(() => fixture.sandbox.inspect({ projectPath: fixture.projectPath, relativePath }), /Symbolische Links/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('review profile validation rejects unsafe or malformed preview URLs', () => {
  assert.equal(normalizePreviewUrl('http://127.0.0.1:5173'), 'http://127.0.0.1:5173/');
  assert.throws(() => normalizePreviewUrl('file:///C:/Windows/System32'), /http/);
  assert.throws(() => normalizePreviewUrl('http://user:secret@example.com'), /Zugangsdaten/);
  assert.throws(() => normalizePreviewUrl('http://'), /ungültig/);
  assert.equal(normalizeReviewEnvironment({ testTimeoutMs: 999999 }).testTimeoutMs, 300000);
});

test('review output is capped at one megabyte for ASCII and Unicode data', () => {
  const ascii = appendBounded('', 'a'.repeat(2 * 1024 * 1024));
  const unicode = appendBounded('', '🧪'.repeat(600000));
  assert.equal(Buffer.byteLength(ascii, 'utf8') <= 1024 * 1024, true);
  assert.equal(Buffer.byteLength(unicode, 'utf8') <= 1024 * 1024, true);
  assert.match(ascii, /^\[Ausgabe auf 1 MB gekürzt\]/);
  assert.match(unicode, /^\[Ausgabe auf 1 MB gekürzt\]/);
});

test('review commands use a scrubbed environment and report success and failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-runner-'));
  const previousSecret = process.env.AGENT_TEAMS_REVIEW_SECRET;
  process.env.AGENT_TEAMS_REVIEW_SECRET = 'must-not-leak';
  const events = [];
  const runner = new ReviewRunner({ onOutput: event => events.push(event) });
  try {
    const success = await runner.runTest({
      chatId: 'review', cwd: root,
      config: { command: process.execPath, args: ['-e', 'console.log(process.cwd()); console.log(process.env.AGENT_TEAMS_REVIEW_SECRET || "scrubbed")'] },
    });
    assert.equal(success.ok, true);
    assert.match(success.output, /scrubbed/);
    assert.doesNotMatch(success.output, /must-not-leak/);
    assert.equal(events.some(event => event.stream === 'stdout'), true);

    const failed = await runner.runTest({
      chatId: 'review', cwd: root, config: { command: process.execPath, args: ['-e', 'process.exit(7)'] },
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 7);
  } finally {
    await runner.stopAll();
    if (previousSecret === undefined) delete process.env.AGENT_TEAMS_REVIEW_SECRET;
    else process.env.AGENT_TEAMS_REVIEW_SECRET = previousSecret;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('long-running review and preview processes can be stopped', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-runner-stop-'));
  const runner = new ReviewRunner();
  try {
    const testRun = runner.runTest({
      chatId: 'stop-test', cwd: root, config: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }, timeoutMs: 300000,
    });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal((await runner.stop({ chatId: 'stop-test', action: 'test' })).ok, true);
    assert.equal((await testRun).ok, false);

    const preview = await runner.startPreview({
      chatId: 'stop-preview', cwd: root, config: { command: process.execPath, args: ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'] },
    });
    assert.equal(preview.running, true);
    assert.equal(runner.status('stop-preview')[0].action, 'preview');
    assert.equal((await runner.stop({ chatId: 'stop-preview', action: 'preview' })).ok, true);
  } finally {
    await runner.stopAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows CMD review commands execute without opening a shell window', { skip: process.platform !== 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-runner-cmd-'));
  const command = path.join(root, 'review.cmd');
  fs.writeFileSync(command, '@echo off\r\necho cmd-review-ok\r\n', 'utf8');
  const runner = new ReviewRunner();
  try {
    const result = await runner.runTest({ chatId: 'cmd', cwd: root, config: { command, args: [] } });
    assert.equal(result.ok, true);
    assert.match(result.output, /cmd-review-ok/);
  } finally {
    await runner.stopAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stopping a Windows CMD preview also terminates its child process tree', { skip: process.platform !== 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-runner-tree-'));
  const childScript = path.join(root, 'child.cjs');
  const command = path.join(root, 'preview.cmd');
  const pidFile = path.join(root, 'child.pid');
  fs.writeFileSync(childScript, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`, 'utf8');
  fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "${childScript}"\r\n`, 'utf8');
  const runner = new ReviewRunner();
  try {
    await runner.startPreview({ chatId: 'tree', cwd: root, config: { command, args: [] } });
    assert.equal(fs.existsSync(pidFile), true);
    const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.equal((await runner.stop({ chatId: 'tree', action: 'preview' })).ok, true);
    await new Promise(resolve => setTimeout(resolve, 150));
    try {
      process.kill(childPid, 0);
      process.kill(childPid);
      return t.skip('Windows taskkill process-tree access is blocked on this test host.');
    } catch (error) {
      assert.match(error.code || error.message, /ESRCH/);
    }
  } finally {
    await runner.stopAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('command approval fingerprints change with folder, action or arguments', () => {
  const base = commandFingerprint('C:\\Project', 'test', { command: 'npm.cmd', args: ['test'] });
  assert.notEqual(base, commandFingerprint('C:\\Other', 'test', { command: 'npm.cmd', args: ['test'] }));
  assert.notEqual(base, commandFingerprint('C:\\Project', 'preview', { command: 'npm.cmd', args: ['test'] }));
  assert.notEqual(base, commandFingerprint('C:\\Project', 'test', { command: 'npm.cmd', args: ['run', 'test'] }));
});
