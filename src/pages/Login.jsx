import React, { useEffect, useState } from 'react';
import { Shield, Lock, Mail, User, AlertTriangle, CheckCircle, Eye, EyeOff, Sun, Moon } from 'lucide-react';
import auth from '../auth';
import passwordPolicy from '../../shared/passwordPolicyContract.json';
import TraceMark from '../components/TraceMark';
import { buildPublicExampleUrl } from '../examples/publicExampleRoute';

export default function Login({ onLogin, notice = '', theme = 'light', setTheme, allowDemo = true, submitLabel = 'Open Workbench', pendingLabel = 'Opening workbench…' }) {
  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
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
  const passwordMeetsLength = Array.from(password).length >= passwordPolicy.minLength;
  const passwordsMatch = passwordConfirmation.length > 0 && passwordConfirmation === password;
  const isDark = theme === 'dark';
  const publicExampleUrl = buildPublicExampleUrl(window.location.href);

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

    if (mode === 'signup' && !passwordMeetsLength) {
      setError(`Password must be at least ${passwordPolicy.minLength} characters.`);
      return;
    }

    if (mode === 'signup' && !passwordsMatch) {
      setError('The passwords do not match.');
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
    'w-full rounded-md border bg-surface py-3 pl-11 pr-4 text-sm text-text placeholder:text-textMuted/60 focus:outline-none focus:ring-2 focus:ring-primary/25 transition-colors';
  const tabBase =
    'py-2 rounded text-sm font-medium transition-colors';

  return (
    <div className="login-bg h-dvh w-full flex flex-col lg:flex-row relative overflow-y-auto custom-scrollbar">
      {/* Theme toggle — lets users pick the dark theme before signing in */}
      <button
        type="button"
        aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        onClick={() => setTheme?.(isDark ? 'light' : 'dark')}
        className="absolute top-4 right-4 z-20 w-10 h-10 rounded-md border border-border bg-surface text-textMuted hover:text-text transition-colors flex items-center justify-center"
      >
        {isDark ? <Sun size={18} /> : <Moon size={18} />}
      </button>

      {/* Plate: the wordmark and the analysis trace every result keeps */}
      <section className="login-plate shrink-0 px-6 py-8 sm:px-10 lg:flex lg:w-[46%] lg:max-w-[44rem] lg:flex-col lg:justify-between lg:px-14 lg:py-14">
        <div className="flex items-center gap-3">
          <TraceMark size={36} className="text-[#eceaff]" />
          <h1 className="wordmark text-[2rem] leading-none sm:text-[2.5rem]">TraceOmics</h1>
        </div>
        <div className="hidden lg:block">
          <p className="wordmark max-w-[20ch] text-[2.75rem] leading-[1.1]">Every cluster, traced back to its counts.</p>
          <p className="mt-5 max-w-[46ch] text-[0.9375rem] leading-relaxed text-[#c9c6ef]">
            Run Seurat analyses of single-cell and spatial data. Each saved result keeps the settings and the earlier steps it came from.
          </p>
          <svg className="trace-figure mt-12 w-full max-w-[34rem]" viewBox="0 0 520 96" role="img" aria-label="Analysis stages: counts, quality control, normalization, PCA, clusters, UMAP">
            <line x1="14" y1="30" x2="506" y2="30" strokeWidth="1.5" />
            {['Counts', 'QC', 'Normalize', 'PCA', 'Clusters', 'UMAP'].map((stage, index) => {
              const x = 14 + index * 98.4;
              return <g key={stage}>
                <circle cx={x} cy="30" r={index === 5 ? 8 : 6.5} strokeWidth="1.5" className={index === 5 ? 'now' : 'done'} />
                <text x={x} y="66" textAnchor={index === 0 ? 'start' : index === 5 ? 'end' : 'middle'}>{stage}</text>
              </g>;
            })}
          </svg>
        </div>
        <p className="mt-2 text-sm text-[#c9c6ef] lg:mt-0">Reproducible single-cell analysis workbench</p>
      </section>

      <div className="flex flex-1 items-start justify-center p-4 sm:p-8 lg:items-center">
      <div className="w-full max-w-sm relative z-10 shrink-0 py-6 lg:my-auto">
        <h2 className="mb-6 font-[family-name:var(--font-display)] text-[1.75rem] font-normal leading-tight text-text">
          {mode === 'signup' ? 'Create your account' : 'Sign in to your workbench'}
        </h2>
        {/* Card */}
        <div>
          {/* Mode Toggle — segmented control */}
          {registrationEnabled && <div className="grid grid-cols-2 gap-1 p-1 mb-6 bg-surface border border-border rounded-md">
            <button
              onClick={() => { setMode('login'); setPasswordConfirmation(''); setError(''); setSuccess(''); }}
              className={`${tabBase} ${mode === 'login' ? 'bg-primary/10 text-text' : 'text-textMuted hover:text-text'}`}
            >
              Log In
            </button>
              <button
                onClick={() => { setMode('signup'); setError(''); setSuccess(''); }}
                className={`${tabBase} ${mode === 'signup' ? 'bg-primary/10 text-text' : 'text-textMuted hover:text-text'}`}
              >
                Sign Up
              </button>
          </div>}

          {!registrationEnabled && (!demoMode || !allowDemo) && (
            <p className="mb-5 text-center text-xs text-textMuted">
              Accounts are provisioned by your deployment administrator.
            </p>
          )}

          {demoMode && allowDemo && (
            <div className="mb-5 rounded-md border border-primary/25 bg-primary/5 p-4">
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

          <form onSubmit={handleSubmit} aria-busy={loading} className="space-y-4">
            {mode === 'signup' && (
              <div className="space-y-1.5">
                <label htmlFor="signup-name" className="text-[13px] font-medium text-textMuted ml-0.5">Full name</label>
                <div className="relative group">
                  <User className="absolute left-3.5 top-1/2 -translate-y-1/2 text-textMuted group-focus-within:text-primary transition-colors" size={17} />
                  <input
                  id="signup-name"
                  type="text"
                  autoComplete="name"
                  maxLength={200}
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
                  autoComplete="email"
                  maxLength={320}
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
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  maxLength={passwordPolicy.maxLength}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className={`${inputBase} pr-11 ${(mode === 'signup' && password && !passwordMeetsLength) ? 'border-danger focus:border-danger' : 'border-border focus:border-primary'}`}
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
              {mode === 'signup' && (
                <p className={`mt-2 ml-0.5 text-xs ${password && !passwordMeetsLength ? 'text-danger' : 'text-textMuted'}`}>
                  Use at least {passwordPolicy.minLength} characters. Long passphrases are supported; no symbol or capitalization rule is imposed.
                </p>
              )}
            </div>

            {mode === 'signup' && (
              <div className="space-y-1.5">
                <label htmlFor="signup-password-confirmation" className="text-[13px] font-medium text-textMuted ml-0.5">
                  Confirm password
                </label>
                <div className="relative group">
                  <Shield className="absolute left-3.5 top-1/2 -translate-y-1/2 text-textMuted group-focus-within:text-primary transition-colors" size={17} />
                  <input
                    id="signup-password-confirmation"
                    type={showPassword ? 'text' : 'password'}
                    required
                    autoComplete="new-password"
                    maxLength={passwordPolicy.maxLength}
                    value={passwordConfirmation}
                    onChange={event => setPasswordConfirmation(event.target.value)}
                    className={`${inputBase} ${passwordConfirmation && !passwordsMatch ? 'border-danger focus:border-danger' : 'border-border focus:border-primary'}`}
                    placeholder="Re-enter your password"
                  />
                </div>
                {passwordConfirmation && !passwordsMatch && (
                  <p className="mt-2 ml-0.5 text-xs text-danger">The passwords do not match.</p>
                )}
              </div>
            )}

            {error && (
              <div role="alert" className="flex items-center gap-2 p-3 bg-danger/10 border border-danger/30 rounded-xl text-xs text-danger">
                <AlertTriangle size={15} className="flex-shrink-0" />
                {error}
              </div>
            )}

            {success && (
              <div role="status" className="flex items-center gap-2 p-3 bg-success/10 border border-success/30 rounded-xl text-xs text-success">
                <CheckCircle size={15} className="flex-shrink-0" />
                {success}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !emailValid || !password || (mode === 'signup' && (!passwordMeetsLength || !passwordsMatch))}
              className="btn btn-primary w-full py-3"
            >
              {loading ? <>
                <div aria-hidden="true" className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                {mode === 'signup' ? 'Creating account…' : pendingLabel}
              </> : (
                <>
                  {mode === 'login' ? submitLabel : 'Create Account'}
                </>
              )}
            </button>
          </form>
          {publicExampleUrl && <div className="mt-5 border-t border-border pt-4 text-center">
            <a href={publicExampleUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-primary underline">Inspect a public saved example</a>
            <p className="mt-1 text-xs text-textMuted">Synthetic findings · No sign-in or compute session · Opens a new tab</p>
          </div>}

        </div>
      </div>
      </div>
    </div>
  );
}
