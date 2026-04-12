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
        id: Date.now(),
        email: normalizedEmail,
        displayName: displayName.trim(),
        // In dev fallback, we store password as-is (NOT for production)
        _pw: password,
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
      if (user._pw !== password) return { error: 'Incorrect password.' };
      return { id: user.id, email: user.email, displayName: user.displayName };
    }
  };
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
