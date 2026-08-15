/**
 * Client-side auth module.
 * Uses Electron IPC when available, falls back to localStorage for dev server.
 */

// --- localStorage fallback for dev (vite-only, no Electron) ---
function localStorageAuth() {
  const USERS_KEY = '__traceomics_users__';
  const getUsers = () => JSON.parse(localStorage.getItem(USERS_KEY) || '[]');
  const saveUsers = (users) => localStorage.setItem(USERS_KEY, JSON.stringify(users));

  return {
    async registrationPolicy() {
      return { registrationEnabled: true };
    },
    async signup(email, password, displayName) {
      const users = getUsers();
      const normalizedEmail = email.trim().toLowerCase();
      if (users.find(u => u.email === normalizedEmail)) {
        return { error: 'An account with this email already exists.' };
      }
      const user = {
        id: crypto.randomUUID(),
        email: normalizedEmail,
        displayName: displayName.trim(),
        _pw: await hashMock(password),
        createdAt: new Date().toISOString()
      };
      users.push(user);
      saveUsers(users);
      return { id: user.id, email: user.email, displayName: user.displayName };
    },
    async login(email, password) {
      const users = getUsers();
      const normalizedEmail = email.trim().toLowerCase();
      const user = users.find(u => u.email === normalizedEmail);
      if (!user) return { error: 'No account found with this email.' };
      const hp = await hashMock(password);
      if (user._pw !== hp) return { error: 'Incorrect password.' };
      return { id: user.id, email: user.email, displayName: user.displayName };
    }
  };
}

async function hashMock(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const fallbackAuth = localStorageAuth();

const auth = {
  async registrationPolicy() {
    if (typeof window !== 'undefined' && window.electronAPI?.registrationPolicy) {
      return window.electronAPI.registrationPolicy();
    }
    return fallbackAuth.registrationPolicy();
  },
  async signup(email, password, displayName) {
    if (typeof window !== 'undefined' && window.electronAPI?.signup) {
      return window.electronAPI.signup(email, password, displayName);
    }
    return fallbackAuth.signup(email, password, displayName);
  },
  async startDemoGuest() {
    if (typeof window !== 'undefined' && window.electronAPI?.startDemoGuest) {
      return window.electronAPI.startDemoGuest();
    }
    return { error: 'The public demo is unavailable.' };
  },
  async login(email, password) {
    if (typeof window !== 'undefined' && window.electronAPI?.login) {
      return window.electronAPI.login(email, password);
    }
    return fallbackAuth.login(email, password);
  }
};

export default auth;
