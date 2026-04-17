import React from 'react';

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            background: '#0d0f14',
            color: '#e8eaf0',
            fontFamily: "'Inter', sans-serif",
            padding: 32,
            textAlign: 'center',
          }}
        >
          <span style={{ fontSize: 48, marginBottom: 16 }}>⬡</span>
          <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>
            Something went wrong
          </h1>
          <p style={{ color: '#9399b2', maxWidth: 480, marginBottom: 20 }}>
            The app ran into an unexpected error. This can happen if your browser
            is outdated or blocking required features (e.g.&nbsp;private
            browsing, disabled JavaScript storage).
          </p>
          <pre
            style={{
              background: '#161922',
              border: '1px solid #2a2f42',
              borderRadius: 8,
              padding: 16,
              fontSize: 13,
              color: '#ff5c5c',
              maxWidth: 600,
              overflowX: 'auto',
              marginBottom: 24,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {this.state.error.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: '#6c8aff',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              padding: '10px 24px',
              fontSize: 14,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Reload page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
