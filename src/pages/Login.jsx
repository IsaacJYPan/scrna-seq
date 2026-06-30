import React, { useState } from 'react';
import { Shield, Lock, Fingerprint, Microscope, UserPlus, AlertTriangle, CheckCircle, Eye, EyeOff } from 'lucide-react';
import auth from '../auth';

export default function Login({ onLogin }) {
  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const passwordStrong = password.length >= 8;

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
    } catch (err) {
      setError('An unexpected error occurred. Please try again.');
      setLoading(false);
    }
  };

  return (
    <div className="h-screen w-screen bg-[#0f172a] flex items-center justify-center p-4 relative overflow-hidden">
      {/* Decorative Blur Orbs */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-600/20 rounded-full blur-[100px]" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-600/20 rounded-full blur-[100px]" />

      <div className="max-w-md w-full z-10">
        <div className="text-center mb-8 group">
          <div className="inline-flex p-4 rounded-2xl bg-slate-800/50 border border-slate-700/50 mb-5 group-hover:scale-110 transition-transform">
            <Microscope size={40} className="text-primary" />
          </div>
          <h1 className="text-3xl font-black text-white tracking-tighter mb-1">BenchOne</h1>
          <p className="text-slate-400 text-sm">Local Development Research Workbench</p>
        </div>

        <div className="bg-slate-800/40 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-6 shadow-2xl">
          {/* Mode Toggle */}
          <div className="flex bg-black/30 rounded-lg p-1 mb-6">
            <button
              onClick={() => { setMode('login'); setError(''); setSuccess(''); }}
              className={`flex-1 py-2 rounded-md text-xs font-bold uppercase tracking-widest transition-all ${mode === 'login' ? 'bg-primary text-white shadow' : 'text-slate-400 hover:text-white'}`}
            >
              Log In
            </button>
            <button
              onClick={() => { setMode('signup'); setError(''); setSuccess(''); }}
              className={`flex-1 py-2 rounded-md text-xs font-bold uppercase tracking-widest transition-all ${mode === 'signup' ? 'bg-primary text-white shadow' : 'text-slate-400 hover:text-white'}`}
            >
              Sign Up
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'signup' && (
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">Full Name</label>
                <div className="relative group">
                   <UserPlus className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-primary transition-colors" size={16} />
                   <input 
                     type="text"
                     value={displayName}
                     onChange={e => setDisplayName(e.target.value)}
                     className="w-full bg-black/40 border border-slate-700 rounded-xl py-3 pl-10 pr-4 text-sm text-white focus:outline-none focus:border-primary transition-all placeholder:text-slate-400"
                     placeholder="Dr. Jane Doe"
                   />
                </div>
              </div>
            )}

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">Email</label>
              <div className="relative group">
                 <Fingerprint className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-primary transition-colors" size={16} />
                 <input 
                   type="email" 
                   required
                   value={email}
                   onChange={e => setEmail(e.target.value)}
                   className={`w-full bg-black/40 border rounded-xl py-3 pl-10 pr-4 text-sm text-white focus:outline-none transition-all placeholder:text-slate-400 ${email && !emailValid ? 'border-danger' : 'border-slate-700 focus:border-primary'}`}
                   placeholder="researcher@lab.edu"
                 />
                 {email && emailValid && <CheckCircle size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-success" />}
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">Password</label>
              <div className="relative group">
                 <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-primary transition-colors" size={16} />
                 <input 
                   type={showPassword ? 'text' : 'password'} 
                   required
                   value={password}
                   onChange={e => setPassword(e.target.value)}
                   className={`w-full bg-black/40 border rounded-xl py-3 pl-10 pr-10 text-sm text-white focus:outline-none transition-all placeholder:text-slate-400 ${(mode === 'signup' && password && !passwordStrong) ? 'border-danger' : 'border-slate-700 focus:border-primary'}`}
                   placeholder="••••••••••••"
                 />
                 <button 
                   type="button"
                   onClick={() => setShowPassword(!showPassword)}
                   aria-label={showPassword ? 'Hide password' : 'Show password'}
                   className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white transition-colors"
                 >
                   {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                 </button>
              </div>
              {mode === 'signup' && password && (
                <div className="flex items-center gap-2 mt-1 ml-1">
                  <div className="flex gap-0.5 flex-1">
                    <div className={`h-1 flex-1 rounded-full transition-colors ${password.length >= 4 ? 'bg-danger' : 'bg-slate-700'}`} />
                    <div className={`h-1 flex-1 rounded-full transition-colors ${password.length >= 8 ? 'bg-yellow-500' : 'bg-slate-700'}`} />
                    <div className={`h-1 flex-1 rounded-full transition-colors ${password.length >= 12 ? 'bg-success' : 'bg-slate-700'}`} />
                  </div>
                  <span className={`text-[9px] font-bold uppercase ${passwordStrong ? 'text-success' : 'text-slate-400'}`}>
                    {password.length < 4 ? 'Weak' : password.length < 8 ? 'Short' : password.length < 12 ? 'Good' : 'Strong'}
                  </span>
                </div>
              )}
            </div>

            {error && (
              <div className="flex items-center gap-2 p-3 bg-danger/10 border border-danger/30 rounded-xl text-xs text-danger">
                <AlertTriangle size={14} className="flex-shrink-0" />
                {error}
              </div>
            )}

            {success && (
              <div className="flex items-center gap-2 p-3 bg-success/10 border border-success/30 rounded-xl text-xs text-success">
                <CheckCircle size={14} className="flex-shrink-0" />
                {success}
              </div>
            )}

            <button 
              type="submit"
              disabled={loading || !emailValid || !password || (mode === 'signup' && !passwordStrong)}
              className="w-full bg-primary hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold py-3.5 rounded-xl shadow-lg shadow-blue-500/20 active:scale-[0.98] transition-all flex items-center justify-center gap-3"
            >
              {loading ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : (
                <>
                  {mode === 'login' ? 'Open Workbench' : 'Create Account'} <Shield size={18} />
                </>
              )}
            </button>
          </form>

          <div className="mt-6 pt-4 border-t border-slate-700/50 text-center">
             <p className="text-[10px] text-slate-400 uppercase font-bold tracking-[0.15em]">
               {mode === 'login' 
                 ? 'Credentials verified via PBKDF2-SHA512' 
                 : 'Passwords hashed with 100k PBKDF2 iterations'}
             </p>
          </div>
        </div>
        
        <p className="text-center mt-6 text-slate-400 text-[10px] uppercase tracking-widest font-bold">
          BenchOne experimental workflow
        </p>
      </div>
    </div>
  );
}
