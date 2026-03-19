import { useState, useEffect, type FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, CheckCircle, Loader2 } from 'lucide-react';
import { supabase } from '../../lib/db';
import logoWhite from '../../assets/logo_3-01_(3).png';
import logoDark from '../../assets/logo_3-02_(2).png';

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [hasSession, setHasSession] = useState<boolean | null>(null);

  // Check if the user arrived here via a valid reset link (Supabase sets the session automatically)
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setHasSession(!!session);
    });
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);

    const { error: err } = await supabase.auth.updateUser({ password });

    setLoading(false);

    if (err) {
      setError(err.message);
      return;
    }

    setSuccess(true);

    // Redirect to the app after a short delay
    setTimeout(() => navigate('/', { replace: true }), 2000);
  };

  // Still checking session
  if (hasSession === null) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-crx-green animate-spin" />
      </div>
    );
  }

  // No session = invalid or expired link
  if (!hasSession) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center px-6">
        <div className="w-full max-w-sm text-center">
          <img src={logoDark} alt="Crop RX Solutions" className="h-12 w-auto mb-8 mx-auto" />
          <h2 className="text-2xl font-semibold font-heading text-nav-dark mb-2">
            Link Expired
          </h2>
          <p className="text-secondary text-sm mb-6">
            This password reset link is invalid or has expired. Please request a new one.
          </p>
          <Link
            to="/forgot-password"
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5
              bg-crx-green text-white font-medium rounded-lg
              hover:bg-crx-green-hover transition-all duration-150 shadow-sm"
          >
            Request New Link
          </Link>
          <p className="mt-4">
            <Link
              to="/login"
              className="inline-flex items-center gap-2 text-sm text-crx-green hover:text-crx-green-hover font-medium"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Sign In
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-cream flex">
      <div className="hidden lg:flex lg:flex-1 bg-nav-dark relative overflow-hidden items-center justify-center">
        <div className="relative z-10 px-16">
          <img src={logoWhite} alt="Crop RX Solutions" className="h-14 w-auto mb-8" />
          <h2 className="text-3xl font-heading font-semibold text-white leading-tight mb-4">
            New
            <br />
            <span className="text-crx-green">Password</span>
          </h2>
          <p className="text-gray-400 max-w-sm leading-relaxed">
            Choose a strong password for your account.
          </p>
        </div>
        <div className="absolute inset-0 opacity-5">
          <div className="absolute top-20 -left-10 w-64 h-64 rounded-full border-2 border-crx-green" />
          <div className="absolute bottom-20 right-10 w-96 h-96 rounded-full border border-crx-green" />
          <div className="absolute top-1/2 left-1/3 w-48 h-48 rounded-full border border-crx-green" />
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center px-6">
        <div className="w-full max-w-sm">
          <img src={logoDark} alt="Crop RX Solutions" className="h-12 w-auto mb-8 lg:hidden" />

          {success ? (
            <div className="text-center">
              <div className="mx-auto w-12 h-12 rounded-full bg-crx-green/10 flex items-center justify-center mb-4">
                <CheckCircle className="w-6 h-6 text-crx-green" />
              </div>
              <h2 className="text-2xl font-semibold font-heading text-nav-dark mb-2">
                Password Updated
              </h2>
              <p className="text-secondary text-sm">
                Redirecting you to the app...
              </p>
            </div>
          ) : (
            <>
              <h2 className="text-2xl font-semibold font-heading text-nav-dark mb-1">
                Set New <span className="split-heading-accent">Password</span>
              </h2>
              <p className="text-secondary text-sm mb-8">
                Enter your new password below
              </p>

              <form onSubmit={handleSubmit} className="space-y-4">
                {error && (
                  <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">
                    {error}
                  </div>
                )}

                <div>
                  <label htmlFor="new-password" className="block text-sm font-medium text-secondary mb-1">
                    New Password
                  </label>
                  <input
                    id="new-password"
                    type="password"
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg
                      focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green
                      transition-colors"
                    placeholder="At least 8 characters"
                  />
                </div>

                <div>
                  <label htmlFor="confirm-password" className="block text-sm font-medium text-secondary mb-1">
                    Confirm Password
                  </label>
                  <input
                    id="confirm-password"
                    type="password"
                    required
                    minLength={8}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg
                      focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green
                      transition-colors"
                    placeholder="Re-enter your password"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5
                    bg-crx-green text-white font-medium rounded-lg
                    hover:bg-crx-green-hover active:bg-crx-green-hover
                    disabled:opacity-50 transition-all duration-150 shadow-sm"
                >
                  {loading ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    'Update Password'
                  )}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
