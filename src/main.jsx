import React from 'react';
import ReactDOM from 'react-dom/client';
import DemoRouter from './demo/DemoRouter';
import './App.css';
import { electronAPI } from './api';

window.electronAPI = electronAPI;

class GlobalErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError(_error) { return { hasError: true }; }
  componentDidCatch(error, info) { console.error("Global Error:", error, info); }
  render() {
    if (this.state.hasError) return <div className="bg-background text-text" style={{padding: '2rem', minHeight: '100vh'}}><h1>Critical Application Error</h1><p>Please restart the application.</p></div>;
    return this.props.children;
  }
}


ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <GlobalErrorBoundary>
      <DemoRouter />
    </GlobalErrorBoundary>
  </React.StrictMode>
);
