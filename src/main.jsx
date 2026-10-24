import React from 'react';
import ReactDOM from 'react-dom/client';
import SharedSnapshotRouter from './sharing/SharedSnapshotRouter';
import './App.css';
import { electronAPI } from './api';

window.electronAPI = electronAPI;

class GlobalErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(_error) { return { hasError: true }; }
  componentDidCatch(error, info) { console.error("Global Error:", error, info); }
  render() {
    if (this.state.hasError) {
      return (
        <main className="bg-background text-text" style={{ padding: '2rem', minHeight: '100vh' }}>
          <h1>Unable to open TraceOmics</h1>
          <p role="alert">Reload the page to reconnect to your saved session.</p>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>Reload page</button>
        </main>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <GlobalErrorBoundary>
      <SharedSnapshotRouter />
    </GlobalErrorBoundary>
  </React.StrictMode>
);
