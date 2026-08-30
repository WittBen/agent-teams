import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from './i18n';

const EMPTY_STATE = {
  chatId: '', chatName: '', projectName: '', windowTitle: '',
  profile: { hasTestCommand: false, hasPreviewCommand: false, previewUrl: '' },
};

function fileIcon(file) {
  if (file.kind === 'word') return '📘';
  if (file.kind === 'pdf') return '📕';
  if (file.kind === 'image') return '🖼️';
  if (file.kind === 'text') return '📄';
  return '📦';
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ReviewWindow() {
  const { t } = useI18n();
  const [state, setState] = useState(EMPTY_STATE);
  const [files, setFiles] = useState([]);
  const [filter, setFilter] = useState('');
  const [selectedPath, setSelectedPath] = useState('');
  const [artifact, setArtifact] = useState(null);
  const [editorContent, setEditorContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [snapshots, setSnapshots] = useState([]);
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [replaceAll, setReplaceAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [runOutput, setRunOutput] = useState('');
  const [previewRunning, setPreviewRunning] = useState(false);
  const activeChatIdRef = useRef('');

  const loadFiles = useCallback(async (chatId = activeChatIdRef.current) => {
    if (!chatId || !window.electronAPI?.reviewList) return;
    setError('');
    const result = await window.electronAPI.reviewList(chatId);
    if (result?.error) throw new Error(result.error);
    setFiles(result?.files || []);
  }, []);

  const loadSnapshots = useCallback(async (chatId, relativePath) => {
    if (!chatId || !relativePath) { setSnapshots([]); return; }
    const result = await window.electronAPI?.reviewSnapshots?.(chatId, relativePath);
    setSnapshots(result?.snapshots || []);
  }, []);

  const selectArtifact = useCallback(async (relativePath, chatId = state.chatId) => {
    if (!relativePath || !chatId) return;
    if (dirty && !window.confirm(t('Ungespeicherte Änderungen verwerfen?'))) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await window.electronAPI.reviewInspect(chatId, relativePath);
      if (result?.error && !result.kind) throw new Error(result.error);
      setSelectedPath(relativePath);
      setArtifact(result);
      setEditorContent(result?.content || result?.text || '');
      setDirty(false);
      setFindText('');
      setReplaceText('');
      await loadSnapshots(chatId, relativePath);
    } catch (selectionError) {
      setError(selectionError.message);
    } finally {
      setBusy(false);
    }
  }, [dirty, loadSnapshots, state.chatId, t]);

  useEffect(() => {
    document.body.classList.add('review-window-mode');
    let active = true;
    window.electronAPI?.getReviewWindowState?.().then(initial => {
      if (!active || !initial) return;
      activeChatIdRef.current = initial.chatId;
      setState(initial);
      loadFiles(initial.chatId).catch(loadError => setError(loadError.message));
      window.electronAPI?.reviewStatus?.(initial.chatId).then(status => {
        const preview = status?.runs?.find(run => run.action === 'preview' && run.running);
        setPreviewRunning(Boolean(preview));
        if (preview?.output) setRunOutput(preview.output);
      }).catch(() => undefined);
    }).catch(loadError => setError(loadError.message));
    const unsubscribeState = window.electronAPI?.onReviewWindowState?.(next => {
      if (!next) return;
      activeChatIdRef.current = next.chatId;
      setState(next);
      setSelectedPath('');
      setArtifact(null);
      setDirty(false);
      loadFiles(next.chatId).catch(loadError => setError(loadError.message));
    });
    const unsubscribeOutput = window.electronAPI?.onReviewProcessOutput?.(output => {
      if (output?.chatId !== activeChatIdRef.current && activeChatIdRef.current) return;
      setRunOutput(output?.output || '');
      if (output?.action === 'preview' && output?.finished) setPreviewRunning(false);
    });
    return () => {
      active = false;
      document.body.classList.remove('review-window-mode');
      unsubscribeState?.();
      unsubscribeOutput?.();
    };
  }, [loadFiles]);

  useEffect(() => {
    const detail = String(state.windowTitle || t('Prüfumgebung')).replace(/^Agent Teams\s*[–—-]\s*/i, '');
    document.title = `Agent Teams – ${detail}`;
  }, [state.windowTitle, t]);

  const visibleFiles = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return query ? files.filter(file => file.relativePath.toLowerCase().includes(query)) : files;
  }, [files, filter]);

  const refreshCurrent = async () => {
    await loadFiles();
    if (selectedPath) await selectArtifact(selectedPath);
  };

  const saveText = async () => {
    if (!artifact || artifact.kind !== 'text' || !dirty) return;
    if (!window.confirm(t('Änderungen speichern? Der aktuelle Stand wird zuvor als Snapshot gesichert.'))) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.electronAPI.reviewSaveText({
        chatId: state.chatId,
        relativePath: selectedPath,
        content: editorContent,
        expectedMtimeMs: artifact.mtimeMs,
      });
      setArtifact(result.artifact);
      setEditorContent(result.artifact.content || '');
      setDirty(false);
      setNotice(t('Datei gespeichert. Snapshot {id} wurde angelegt.', { id: result.snapshot.id.slice(0, 8) }));
      await loadSnapshots(state.chatId, selectedPath);
      await loadFiles();
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setBusy(false);
    }
  };

  const replaceWord = async () => {
    if (!findText || !artifact || artifact.kind !== 'word') return;
    if (!window.confirm(t('Word-Text ersetzen? Das Original wird zuvor als Snapshot gesichert.'))) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.electronAPI.reviewReplaceWord({
        chatId: state.chatId,
        relativePath: selectedPath,
        findText,
        replaceText,
        replaceAll,
        expectedMtimeMs: artifact.mtimeMs,
      });
      setArtifact(result.artifact);
      setEditorContent(result.artifact.text || '');
      setFindText('');
      setReplaceText('');
      setNotice(t('{count} Word-Textstelle(n) ersetzt. Snapshot {id} wurde angelegt.', {
        count: result.replacements, id: result.snapshot.id.slice(0, 8),
      }));
      await loadSnapshots(state.chatId, selectedPath);
      await loadFiles();
    } catch (replaceError) {
      setError(replaceError.message);
    } finally {
      setBusy(false);
    }
  };

  const restore = async snapshot => {
    setBusy(true);
    setError('');
    try {
      const result = await window.electronAPI.reviewRestore(state.chatId, snapshot.id);
      if (result?.cancelled) return;
      setArtifact(result.artifact);
      setEditorContent(result.artifact.content || result.artifact.text || '');
      setDirty(false);
      setNotice(t('Snapshot wurde wiederhergestellt. Der vorherige Stand bleibt ebenfalls gesichert.'));
      await loadSnapshots(state.chatId, selectedPath);
      await loadFiles();
    } catch (restoreError) {
      setError(restoreError.message);
    } finally {
      setBusy(false);
    }
  };

  const runCommand = async action => {
    setBusy(true);
    setError('');
    setNotice('');
    setRunOutput('');
    try {
      const result = await window.electronAPI.reviewRun(state.chatId, action);
      setRunOutput(result.output || '');
      if (action === 'preview') {
        setPreviewRunning(Boolean(result.running));
        setNotice(t('Vorschauprozess läuft.'));
      } else {
        setNotice(result.ok ? t('Prüfbefehl erfolgreich abgeschlossen.') : t('Prüfbefehl ist fehlgeschlagen.'));
      }
    } catch (runError) {
      setError(runError.message);
    } finally {
      setBusy(false);
    }
  };

  const stopPreview = async () => {
    try {
      await window.electronAPI.reviewStop(state.chatId, 'preview');
      setPreviewRunning(false);
    } catch (stopError) {
      setError(stopError.message);
    }
  };

  const openArtifactExternally = async () => {
    try {
      const result = await window.electronAPI.reviewOpenFile(state.chatId, selectedPath);
      if (result?.error) throw new Error(result.error);
    } catch (openError) {
      setError(openError.message);
    }
  };

  const openPreviewUrl = async () => {
    try {
      await window.electronAPI.reviewOpenPreviewUrl(state.chatId);
    } catch (openError) {
      setError(openError.message);
    }
  };

  return (
    <main className="review-window-page">
      <header className="review-window-header">
        <div>
          <h1>🧪 {t('Prüf- und Vorschauumgebung')}</h1>
          <span>{state.chatName} · 📁 {state.projectName} · {files.length} {t('Dateien')}</span>
        </div>
        <div className="review-window-actions">
          {state.profile.hasTestCommand && <button className="btn btn-secondary" disabled={busy} onClick={() => runCommand('test')}>▶ {t('Prüfung starten')}</button>}
          {state.profile.hasPreviewCommand && !previewRunning && <button className="btn btn-secondary" disabled={busy} onClick={() => runCommand('preview')}>🚀 {t('Vorschau starten')}</button>}
          {previewRunning && <button className="btn btn-danger" onClick={stopPreview}>■ {t('Vorschau stoppen')}</button>}
          {state.profile.previewUrl && <button className="btn btn-secondary" onClick={openPreviewUrl}>🌐 {t('Vorschau öffnen')}</button>}
          <button className="icon-btn" title={t('Aktualisieren')} onClick={refreshCurrent}>↻</button>
          <button className="icon-btn" title={t('Fenster schließen')} onClick={() => window.electronAPI.closeReviewWindow()}>✕</button>
        </div>
      </header>

      <div className="review-window-layout">
        <aside className="review-file-panel">
          <input className="form-input" value={filter} onChange={event => setFilter(event.target.value)} placeholder={t('Dateien durchsuchen…')} />
          <div className="review-file-list">
            {visibleFiles.map(file => (
              <button key={file.relativePath} className={`review-file-item ${selectedPath === file.relativePath ? 'active' : ''}`}
                onClick={() => selectArtifact(file.relativePath)}>
                <span>{fileIcon(file)}</span>
                <span><strong>{file.name}</strong><small>{file.relativePath} · {formatBytes(file.size)}</small></span>
              </button>
            ))}
            {!visibleFiles.length && <div className="review-empty">{t('Keine prüfbaren Dateien gefunden.')}</div>}
          </div>
        </aside>

        <section className="review-preview-panel">
          {error && <div className="review-message error" role="alert">{error}</div>}
          {notice && <div className="review-message success" role="status">{notice}</div>}
          {!artifact && !busy && <div className="review-empty large">{t('Wähle links eine Projektdatei für Vorschau und Prüfung aus.')}</div>}
          {busy && !artifact && <div className="review-empty large">{t('Datei wird geprüft…')}</div>}
          {artifact && (
            <>
              <div className="review-artifact-head">
                <div><strong>{fileIcon(artifact)} {artifact.relativePath}</strong><span>{formatBytes(artifact.size)} · {new Date(artifact.modifiedAt).toLocaleString()}</span></div>
                <button className="btn btn-secondary" onClick={openArtifactExternally}>{t('Extern öffnen')}</button>
              </div>
              {artifact.error && <div className="review-message error">{artifact.error}</div>}
              {artifact.kind === 'image' && artifact.dataUrl && <div className="review-image-preview"><img src={artifact.dataUrl} alt={artifact.name} /></div>}
              {artifact.kind === 'text' && (
                <div className="review-editor-wrap">
                  <textarea className="review-text-editor" value={editorContent}
                    onChange={event => { setEditorContent(event.target.value); setDirty(event.target.value !== artifact.content); }} />
                  <div className="review-editor-actions">
                    <span>{dirty ? t('Ungespeicherte Änderungen') : t('Keine offenen Änderungen')}</span>
                    <button className="btn btn-primary" disabled={!dirty || busy} onClick={saveText}>{t('Mit Snapshot speichern')}</button>
                  </div>
                </div>
              )}
              {artifact.kind === 'word' && (
                <div className="review-word-preview">
                  <div className="review-word-warning">
                    {t('Inhaltsvorschau: Text und Struktur wurden lokal gelesen. Für eine verbindliche Layoutprüfung öffne die Datei zusätzlich in Word oder einer kompatiblen Office-App.')}
                  </div>
                  <div className="review-word-stats">
                    <span>{t('Absätze')}: {artifact.details?.paragraphs || 0}</span>
                    <span>{t('Tabellen')}: {artifact.details?.tables || 0}</span>
                    <span>{t('Bilder')}: {artifact.details?.images || 0}</span>
                  </div>
                  <pre className="review-word-text">{artifact.text || t('Kein Text gefunden.')}</pre>
                  <div className="review-word-replace">
                    <strong>{t('Sichere Textersetzung')}</strong>
                    <input className="form-input" value={findText} onChange={event => setFindText(event.target.value)} placeholder={t('Exakten vorhandenen Text suchen')} />
                    <textarea className="form-textarea" rows={3} value={replaceText} onChange={event => setReplaceText(event.target.value)} placeholder={t('Neuer Text')} />
                    <label><input type="checkbox" checked={replaceAll} onChange={event => setReplaceAll(event.target.checked)} /> {t('Alle Vorkommen im Dokument ersetzen')}</label>
                    <button className="btn btn-primary" disabled={!findText || busy} onClick={replaceWord}>{t('Mit Snapshot ersetzen')}</button>
                  </div>
                </div>
              )}
              {(artifact.kind === 'pdf' || artifact.kind === 'binary') && (
                <div className="review-empty large">
                  <span>{artifact.kind === 'pdf' ? '📕' : '📦'}</span>
                  <strong>{t('Dieses Format wird sicher über die installierte Standardanwendung geöffnet.')}</strong>
                  <button className="btn btn-primary" onClick={openArtifactExternally}>{t('Datei öffnen')}</button>
                </div>
              )}
            </>
          )}
        </section>

        <aside className="review-side-panel">
          <section>
            <h2>{t('Snapshots')}</h2>
            <p>{t('Vor jeder Änderung wird die Originaldatei außerhalb des Projektordners gesichert.')}</p>
            <div className="review-snapshot-list">
              {snapshots.map(snapshot => (
                <button key={snapshot.id} className="review-snapshot-item" onClick={() => restore(snapshot)} disabled={busy}>
                  <strong>{new Date(snapshot.createdAt).toLocaleString()}</strong>
                  <span>{snapshot.reason} · {formatBytes(snapshot.bytes)}</span>
                </button>
              ))}
              {!snapshots.length && <div className="review-empty">{t('Noch keine Snapshots für diese Datei.')}</div>}
            </div>
          </section>
          <section className="review-run-output">
            <h2>{t('Prüfausgabe')}</h2>
            <pre>{runOutput || t('Noch kein Prüf- oder Vorschauprozess ausgeführt.')}</pre>
          </section>
        </aside>
      </div>
    </main>
  );
}
