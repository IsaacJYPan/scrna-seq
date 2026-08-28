function authApi() {
  return typeof window !== 'undefined' ? window.electronAPI : null;
}

const unavailable = Object.freeze({ error: 'Authentication service is unavailable.' });

const auth = {
  async registrationPolicy() {
    return authApi()?.registrationPolicy?.() || { registrationEnabled: false };
  },

  async signup(email, password, displayName) {
    return authApi()?.signup?.(email, password, displayName) || unavailable;
  },

  async startDemoGuest() {
    return authApi()?.startDemoGuest?.() || { error: 'The public demo is unavailable.' };
  },

  async login(email, password) {
    return authApi()?.login?.(email, password) || unavailable;
  },
};

export default auth;
