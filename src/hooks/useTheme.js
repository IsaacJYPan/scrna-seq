import { useEffect, useState } from 'react';

function storedTheme() {
  try {
    return localStorage.getItem('theme') || 'light';
  } catch {
    return 'light';
  }
}

// Persists the light/dark choice, applies it to the document, and tells the
// desktop shell so native chrome matches.
export function useTheme() {
  const [theme, setTheme] = useState(storedTheme);
  useEffect(() => {
    try { localStorage.setItem('theme', theme); } catch { /* storage unavailable */ }
    if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    if (window.electronAPI && window.electronAPI.setTheme) {
      window.electronAPI.setTheme(theme);
    }
  }, [theme]);
  return [theme, setTheme];
}
