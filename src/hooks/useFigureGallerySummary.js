import { useEffect, useState } from 'react';

// Figure count and collection names for the gallery badge and save dialog.
// Within a project these come from the project's shared gallery; otherwise
// from the private gallery. `refreshKey` lets callers reload after a save or
// when the gallery tab opens or closes, rather than on every navigation.
export function useFigureGallerySummary({ userEmail, projectId, refreshKey }) {
  const [figuresCount, setFiguresCount] = useState(0);
  const [figureCollections, setFigureCollections] = useState([]);

  useEffect(() => {
    if (!userEmail) return undefined;
    let cancelled = false;
    const api = window.electronAPI;
    const load = projectId && api?.listProjectFigures
      ? api.listProjectFigures(projectId)
      : api?.getFigures?.(userEmail);
    if (!load) return undefined;
    load.then((figures) => {
      if (cancelled) return;
      const list = Array.isArray(figures) ? figures : [];
      setFiguresCount(list.length);
      setFigureCollections([...new Set(list.map((figure) => figure.collection).filter(Boolean))].sort());
    }).catch(err => {
      if (!cancelled && err.status !== 401) console.error('[App] Failed to load figures count:', err);
    });
    return () => { cancelled = true; };
  }, [userEmail, projectId, refreshKey]);

  return { figuresCount, figureCollections };
}
