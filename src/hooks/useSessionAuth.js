import { useCallback, useEffect, useState } from 'react';
import { reconcileRestoredSession } from '../liveRState';

// The signed-in user comes from the HttpOnly session cookie, not cached local
// metadata. Until the server answers, `authResolution` is 'checking' so the
// login form is not shown to someone who is still signed in; a failed check is
// 'error' and retryable, because an outage does not mean the user signed out.
export function useSessionAuth() {
  const [user, setUser] = useState(null);
  const [authResolution, setAuthResolution] = useState(() => (
    typeof window.electronAPI?.restoreSession === 'function' ? 'checking' : 'resolved'
  ));
  const [authRetry, setAuthRetry] = useState(0);
  const [loggedOutNotice, setLoggedOutNotice] = useState('');

  useEffect(() => {
    let cancelled = false;
    if (!window.electronAPI?.restoreSession) {
      setAuthResolution('resolved');
      return undefined;
    }
    setAuthResolution('checking');
    window.electronAPI.restoreSession().then((restored) => {
      if (cancelled) return;
      setUser((currentUser) => reconcileRestoredSession(currentUser, restored));
      setAuthResolution('resolved');
    }).catch(() => {
      if (!cancelled) setAuthResolution('error');
    });
    return () => { cancelled = true; };
  }, [authRetry]);

  const retryAuth = useCallback(() => setAuthRetry((value) => value + 1), []);

  return {
    user, setUser, authResolution, setAuthResolution, retryAuth, loggedOutNotice, setLoggedOutNotice,
  };
}
