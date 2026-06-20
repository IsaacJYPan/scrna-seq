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


ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <GlobalErrorBoundary>
      <App />
    </GlobalErrorBoundary>
  </React.StrictMode>
);
