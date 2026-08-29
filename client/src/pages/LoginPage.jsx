import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Button from '../components/ui/Button';
import FormField from '../components/ui/FormField';
import { V25_OFFLINE_CORE } from '../config/features';
import { waitingCount } from '../offline/outbox';

export default function LoginPage() {
  const { login }   = useAuth();
  const navigate    = useNavigate();
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [unsentCount, setUnsentCount] = useState(0);

  useEffect(() => {
    if (!V25_OFFLINE_CORE) return;
    waitingCount()
      .then((count) => setUnsentCount(count))
      .catch(() => {});
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err.message || 'Login failed. Please check your credentials.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-lg p-8">
        <h1 className="text-2xl font-bold text-slate-900 mb-1">Leyble Hub</h1>
        <p className="text-slate-500 text-base mb-8">Sign in to your account</p>

        {V25_OFFLINE_CORE && unsentCount > 0 && (
          <div
            role="status"
            className="mb-6 p-4 rounded-xl bg-amber-50 border border-amber-300 text-amber-900 text-sm font-semibold flex items-start gap-2.5 shadow-sm"
          >
            <span className="text-lg shrink-0">⚠️</span>
            <div>
              <p className="font-bold text-amber-950">
                This device is holding {unsentCount} unsent receipt{unsentCount === 1 ? '' : 's'}.
              </p>
              <p className="mt-0.5 text-xs text-amber-800 font-normal">
                Sales are saved locally and will automatically sync once connected to the server.
              </p>
            </div>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="mb-6 p-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-base font-medium"
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
          <FormField label="Email address" required>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="josie@leyblestore.com"
              className="w-full h-12 px-4 border border-slate-300 rounded-lg text-base text-slate-900
                         focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </FormField>

          <FormField label="Password" required>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full h-12 px-4 border border-slate-300 rounded-lg text-base text-slate-900
                         focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </FormField>

          <Button type="submit" loading={loading} className="w-full mt-2">
            Sign in
          </Button>
        </form>
      </div>
    </div>
  );
}
