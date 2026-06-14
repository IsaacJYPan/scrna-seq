import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './App.css';
import { electronAPI } from './api';

window.electronAPI = electronAPI;

class GlobalErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError(error) { return { hasError: true }; }
  componentDidCatch(error, info) { console.error("Global Error:", error, info); }
  render() {
    if (this.state.hasError) return <div style={{padding: '2rem', color: 'white'}}><h1>Critical Application Error</h1><p>Please restart the application.</p></div>;
    return this.props.children;
  }
}

// Globally intercept fetch to use IPC for Plumber backend
const originalFetch = window.fetch;
window.fetch = async (resource, config = {}) => {
  if (typeof resource === 'string' && (resource.startsWith('http://localhost:8000') || resource.startsWith('/'))) {
    if (window.electronAPI?.apiRequest) {
      const endpoint = resource.replace('http://localhost:8000', '');
      const responseData = await window.electronAPI.apiRequest(endpoint, config);
      if (responseData && responseData.error) {
        return {
          ok: false,
          json: async () => responseData,
          text: async () => JSON.stringify(responseData),
          headers: new Headers({ 'content-type': 'application/json' })
        };
      }
      return {
        ok: true,
        json: async () => responseData,
        text: async () => typeof responseData === 'string' ? responseData : JSON.stringify(responseData),
        headers: new Headers({ 'content-type': 'application/json' })
      };
    }
  }
  return originalFetch(resource, config);
};

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <GlobalErrorBoundary>
      <App />
    </GlobalErrorBoundary>
  </React.StrictMode>
);
