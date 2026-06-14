import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// We need to test auth.js, but since it relies on window.electronAPI,
// we will mock window.electronAPI before importing the functions.

describe('auth.js login/signup flow', () => {
  let auth;

  beforeEach(async () => {
    // Mock the electronAPI
    global.window = {
      electronAPI: {
        signup: vi.fn(async (email, password, organization) => {
          if (email === 'duplicate@example.com') {
            return { error: 'Email already in use' };
          }
          return { id: 'user-123', email, organization, created_at: new Date().toISOString() };
        }),
        login: vi.fn(async (email, password) => {
          if (email === 'test@example.com' && password === 'correct') {
            return { id: 'user-123', email: 'test@example.com', organization: 'dev' };
          }
          return { error: 'Invalid credentials' };
        })
      }
    };

    // Dynamically import to ensure it picks up the mocked window object
    const authModule = await import('./auth.js');
    auth = authModule.default;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('should successfully sign up a new user', async () => {
    const result = await auth.signup('new@example.com', 'password123', 'MyOrg');
    expect(result.error).toBeUndefined();
    expect(result.id).toBeDefined();
    expect(result.email).toBe('new@example.com');
  });

  it('should return an error for duplicate email on signup', async () => {
    const result = await auth.signup('duplicate@example.com', 'password123', 'MyOrg');
    expect(result.error).toBe('Email already in use');
  });

  it('should successfully log in with correct credentials', async () => {
    const result = await auth.login('test@example.com', 'correct');
    expect(result.error).toBeUndefined();
    expect(result.email).toBe('test@example.com');
  });

  it('should return an error for invalid login credentials', async () => {
    const result = await auth.login('test@example.com', 'wrong');
    expect(result.error).toBe('Invalid credentials');
  });
});
