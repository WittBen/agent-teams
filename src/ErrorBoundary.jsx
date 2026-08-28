import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Unbehandelter Renderer-Fehler:', error, info?.componentStack || '');
  }

  render() {
    if (!this.state.error) return this.props.children;
    const english = document.documentElement.lang === 'en';
    return (
      <main role="alert" style={{ minHeight: '100vh', padding: 32, background: '#111b21', color: '#e9edef', fontFamily: 'system-ui' }}>
        <h1>{english ? 'Agent Teams encountered an error' : 'Agent Teams hat einen Fehler festgestellt'}</h1>
        <p>{english
          ? 'Your locally saved data was not deleted. Restart the interface and report the issue if it happens again.'
          : 'Deine lokal gespeicherten Daten wurden nicht gelöscht. Starte die Oberfläche neu und melde den Fehler, falls er erneut auftritt.'}</p>
        <pre style={{ whiteSpace: 'pre-wrap', color: '#f3a6a6' }}>{String(this.state.error?.message || this.state.error)}</pre>
        <button type="button" onClick={() => window.location.reload()} style={{ padding: '9px 16px', cursor: 'pointer' }}>
          {english ? 'Reload interface' : 'Oberfläche neu laden'}
        </button>
      </main>
    );
  }
}
