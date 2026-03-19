import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Loader2, Mail } from 'lucide-react';
import { supabase } from '../../lib/db';
import logoWhite from '../../assets/logo_3-01_(3).png';
import logoDark from '../../assets/logo_3-02_(2).png';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });

    setLoading(false);

    if (err) {
      setError(err.message);
      return;
    }

    setSent(true);
  };

  return (
    <div className="min-h-screen bg-cream flex">
      <div className="hidden lg:flex lg:flex-1 bg-nav-dark relative overflow-hidden items-center justify-center">
        <div className="relative z-10 px-16">
          <img src={logoWhite} alt="Crop RX Solutions" className="h-14 w-auto mb-8" />
          <h2 className="text-3xl font-heading font-semibold text-white leading-tight mb-4">
            Password
            <br />
            <span className="text-crx-green">Reset</span>
          </h2>
          <p className="text-gray-400 max-w-sm leading-relaxed">
            We&apos;ll send you a link to reset your password.
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

          {sent ? (
            <div className="text-center">
              <div className="mx-auto w-12 h-12 rounded-full bg-crx-green/10 flex items-center justify-center mb-4">
                <Mail className="w-6 h-6 text-crx-green" />
              </div>
              <h2 className="text-2xl font-semibold font-heading text-nav-dark mb-2">
                Check Your Email
              </h2>
              <p className="text-secondary text-sm mb-6">
                We sent a password reset link to <strong>{email}</strong>.
                Click the link in the email to set a new password.
              </p>
              <p className="text-secondary text-xs mb-6">
                Don&apos;t see it? Check your spam folder.
              </p>
              <Link
                to="/login"
                className="inline-flex items-center gap-2 text-sm text-crx-green hover:text-crx-green-hover font-medium"
              >
                <ArrowLeft className="w-4 h-4" />
                Back to Sign In
              </Link>
            </div>
          ) : (
            <>
              <h2 className="text-2xl font-semibold font-heading text-nav-dark mb-1">
                Forgot Your <span className="split-heading-accent">Password?</span>
              </h2>
              <p className="text-secondary text-sm mb-8">
                Enter your email and we&apos;ll send you a reset link
              </p>

              <form onSubmit={handleSubmit} className="space-y-4">
                {error && (
                  <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">
                    {error}
                  </div>
                )}

                <div>
                  <label htmlFor="reset-email" className="block text-sm font-medium text-secondary mb-1">
                    Email Address
                  </label>
                  <input
                    id="reset-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg
                      focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green
                      transition-colors"
                    placeholder="you@croprx.com"
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
                    'Send Reset Link'
                  )}
                </button>
              </form>

              <p className="mt-6 text-center">
                <Link
                  to="/login"
                  className="inline-flex items-center gap-2 text-sm text-crx-green hover:text-crx-green-hover font-medium"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Back to Sign In
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
