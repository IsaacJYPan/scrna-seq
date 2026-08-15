import React, { useEffect, useState } from 'react';
import { Shield, Lock, Mail, User, Microscope, AlertTriangle, CheckCircle, Eye, EyeOff, Sun, Moon } from 'lucide-react';
import auth from '../auth';

export default function Login({ onLogin, notice = '', theme = 'light', setTheme }) {
  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [demoMode, setDemoMode] = useState(false);

  useEffect(() => {
    let active = true;
    auth.registrationPolicy()
      .then((policy) => {
        if (!active) return;
        const enabled = policy?.registrationEnabled === true;
        setRegistrationEnabled(enabled);
        setDemoMode(policy?.demoMode === true);
        if (!enabled) setMode('login');
      })
      .catch(() => {
        if (active) {
          setRegistrationEnabled(false);
          setMode('login');
        }
      });
    return () => { active = false; };
  }, []);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const passwordStrong = password.length >= 8;
  const isDark = theme === 'dark';

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!emailValid) {
      setError('Please enter a valid email address.');
      return;
    }

    if (!password) {
      setError('Please enter a password.');
      return;
    }

    if (mode === 'signup' && !passwordStrong) {
      setError('Password must be at least 8 characters.');
      return;
    }

    if (mode === 'signup' && !displayName.trim()) {
      setError('Please enter your name.');
      return;
    }

    setLoading(true);

    try {
      let result;
      if (mode === 'signup') {
        result = await auth.signup(email, password, displayName);
        if (result.error) {
          setError(result.error);
          setLoading(false);
          return;
        }
        setSuccess('Account created! Logging you in...');
        setTimeout(() => onLogin(result), 800);
      } else {
        result = await auth.login(email, password);
        if (result.error) {
          setError(result.error);
          setLoading(false);
          return;
        }
        onLogin(result);
      }
    } catch {
      setError('An unexpected error occurred. Please try again.');
      setLoading(false);
    }
  };

  const startDemo = async () => {
    setLoading(true);
    setError('');
    const result = await auth.startDemoGuest();
    if (result?.error) {
      setError(result.error);
      setLoading(false);
      return;
    }
    onLogin(result);
  };

  const inputBase =
    'w-full rounded-xl border bg-background py-3 pl-11 pr-4 text-sm text-text placeholder:text-textMuted/60 focus:outline-none focus:ring-2 focus:ring-primary/25 transition-colors';
  const tabBase =
    'py-2 rounded-lg text-sm font-medium transition-colors';

  return (
    <div className="login-bg min-h-screen w-full flex items-center justify-center p-4 sm:p-6 relative overflow-hidden">
      {/* Theme toggle — lets users pick the previous dark theme before signing in */}
      <button
        type="button"
        aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        onClick={() => setTheme?.(isDark ? 'light' : 'dark')}
        className="absolute top-5 right-5 z-20 w-10 h-10 rounded-full border border-border bg-surface/80 backdrop-blur text-textMuted hover:text-text hover:border-primary/40 transition-colors flex items-center justify-center"
      >
        {isDark ? <Sun size={18} /> : <Moon size={18} />}
      </button>

      <div className="w-full max-w-sm relative z-10">
        {/* Brand */}
        <div className="flex flex-col items-center text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 mb-4">
            <Microscope size={30} className="text-primary" />
          </div>
          <h1 className="text-2xl font-bold text-text tracking-tight">TraceOmics</h1>
          <p className="text-textMuted text-sm mt-1.5">Reproducible Single-Cell Analysis Workbench</p>
        </div>

        {/* Card */}
        <div className="bg-surface border border-border rounded-2xl shadow-xl shadow-slate-900/5 p-6 sm:p-7">
          {/* Mode Toggle — segmented control */}
          {registrationEnabled && <div className="grid grid-cols-2 gap-1 p-1 mb-6 bg-background border border-border rounded-xl">
            <button
              onClick={() => { setMode('login'); setError(''); setSuccess(''); }}
              className={`${tabBase} ${mode === 'login' ? 'bg-surface text-text shadow-sm' : 'text-textMuted hover:text-text'}`}
            >
              Log In
            </button>
              <button
                onClick={() => { setMode('signup'); setError(''); setSuccess(''); }}
                className={`${tabBase} ${mode === 'signup' ? 'bg-surface text-text shadow-sm' : 'text-textMuted hover:text-text'}`}
              >
                Sign Up
              </button>
          </div>}

          {!registrationEnabled && !demoMode && (
            <p className="mb-5 text-center text-xs text-textMuted">
              Accounts are provisioned by your deployment administrator.
            </p>
          )}

          {demoMode && (
            <div className="mb-5 rounded-xl border border-primary/25 bg-primary/5 p-4 text-center">
              <p className="text-xs text-textMuted">Explore a curated, temporary single-cell project. Uploads and Expert R are disabled.</p>
              <button
                type="button"
                onClick={startDemo}
                disabled={loading}
                className="btn btn-primary mt-3 w-full"
              >
                {loading ? 'Preparing curated workspace…' : 'Start temporary demo'}
              </button>
            </div>
          )}

          {notice && (
            <div role="status" className="mb-4 flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle size={15} className="flex-shrink-0" />
              {notice}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'signup' && (
              <div className="space-y-1.5">
                <label htmlFor="signup-name" className="text-[13px] font-medium text-textMuted ml-0.5">Full name</label>
                <div className="relative group">
                  <User className="absolute left-3.5 top-1/2 -translate-y-1/2 text-textMuted group-focus-within:text-primary transition-colors" size={17} />
                  <input
                    id="signup-name"
                    type="text"
                    value={displayName}
                    onChange={e => setDisplayName(e.target.value)}
                    className={`${inputBase} border-border focus:border-primary`}
                    placeholder="Dr. Jane Doe"
                  />
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <label htmlFor="login-email" className="text-[13px] font-medium text-textMuted ml-0.5">Email</label>
              <div className="relative group">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 text-textMuted group-focus-within:text-primary transition-colors" size={17} />
                <input
                  id="login-email"
                  type="email"
                  required
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className={`${inputBase} pr-10 ${email && !emailValid ? 'border-danger focus:border-danger' : 'border-border focus:border-primary'}`}
                  placeholder="researcher@lab.edu"
                />
                {email && emailValid && <CheckCircle size={15} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-success" />}
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="login-password" className="text-[13px] font-medium text-textMuted ml-0.5">Password</label>
              <div className="relative group">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-textMuted group-focus-within:text-primary transition-colors" size={17} />
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className={`${inputBase} pr-11 ${(mode === 'signup' && password && !passwordStrong) ? 'border-danger focus:border-danger' : 'border-border focus:border-primary'}`}
                  placeholder="••••••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-textMuted hover:text-text transition-colors"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {mode === 'signup' && password && (
                <div className="flex items-center gap-2 mt-2 ml-0.5">
                  <div className="flex gap-1 flex-1">
                    <div className={`h-1 flex-1 rounded-full transition-colors ${password.length >= 4 ? 'bg-danger' : 'bg-border'}`} />
                    <div className={`h-1 flex-1 rounded-full transition-colors ${password.length >= 8 ? 'bg-yellow-500' : 'bg-border'}`} />
                    <div className={`h-1 flex-1 rounded-full transition-colors ${password.length >= 12 ? 'bg-success' : 'bg-border'}`} />
                  </div>
                  <span className={`text-[10px] font-semibold uppercase tracking-wide ${passwordStrong ? 'text-success' : 'text-textMuted'}`}>
                    {password.length < 4 ? 'Weak' : password.length < 8 ? 'Short' : password.length < 12 ? 'Good' : 'Strong'}
                  </span>
                </div>
              )}
            </div>

            {error && (
              <div className="flex items-center gap-2 p-3 bg-danger/10 border border-danger/30 rounded-xl text-xs text-danger">
                <AlertTriangle size={15} className="flex-shrink-0" />
                {error}
              </div>
            )}

            {success && (
              <div className="flex items-center gap-2 p-3 bg-success/10 border border-success/30 rounded-xl text-xs text-success">
                <CheckCircle size={15} className="flex-shrink-0" />
                {success}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !emailValid || !password || (mode === 'signup' && !passwordStrong)}
              className="w-full bg-primary hover:bg-[#0077ed] disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold py-3.5 rounded-xl transition-colors flex items-center justify-center gap-2.5"
            >
              {loading ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : (
                <>
                  {mode === 'login' ? 'Open Workbench' : 'Create Account'} <Shield size={17} />
                </>
              )}
            </button>
          </form>

        </div>
      </div>
    </div>
  );
}
