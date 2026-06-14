/**
 * Client-side auth module.
 * Uses Electron IPC when available, falls back to localStorage for dev server.
 */

const isElectron = !!window.electronAPI?.signup;

// --- localStorage fallback for dev (vite-only, no Electron) ---
function localStorageAuth() {
  const USERS_KEY = '__benchone_users__';
  const getUsers = () => JSON.parse(localStorage.getItem(USERS_KEY) || '[]');
  const saveUsers = (users) => localStorage.setItem(USERS_KEY, JSON.stringify(users));

  return {
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

// --- Electron IPC auth ---
function electronAuth() {
  return {
    async signup(email, password, displayName) {
      return window.electronAPI.signup(email, password, displayName);
    },
    async login(email, password) {
      return window.electronAPI.login(email, password);
    }
  };
}

const auth = isElectron ? electronAuth() : localStorageAuth();

export default auth;
