import { useState, type FormEvent } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { ChevronRight, Loader2 } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import logoWhite from '../../assets/logo_3-01_(3).png';
import logoDark from '../../assets/logo_3-02_(2).png';

export default function LoginPage() {
  const { signIn, session } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (session) {
    return <Navigate to="/" replace />;
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const { error: err } = await signIn(email, password);
    if (err) {
      setError(err);
      setLoading(false);
      return;
    }
    navigate('/', { replace: true });
  };

  return (
    <div className="min-h-screen bg-cream flex">
      <div className="hidden lg:flex lg:flex-1 bg-nav-dark relative overflow-hidden items-center justify-center">
        <div className="relative z-10 px-16">
          <img src={logoWhite} alt="Crop RX Solutions" className="h-14 w-auto mb-8" />
          <h2 className="text-3xl font-heading font-semibold text-white leading-tight mb-4">
            Business Management
            <br />
            <span className="text-crx-green">Platform</span>
          </h2>
          <p className="text-gray-400 max-w-sm leading-relaxed">
            Manage your products, customers, quotes, inventory, and deliveries -- all in one place.
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

          <h2 className="text-2xl font-semibold font-heading text-nav-dark mb-1">
            Welcome <span className="split-heading-accent">Back</span>
          </h2>
          <p className="text-secondary text-sm mb-8">Sign in to your account to continue</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">
                {error}
              </div>
            )}

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-secondary mb-1">
                Email Address
              </label>
              <input
                id="email"
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

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-secondary mb-1">
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg
                  focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green
                  transition-colors"
                placeholder="Enter your password"
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
                <>
                  Sign In
                  <ChevronRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          <p className="mt-8 text-center text-xs text-gray-400">
            Contact your administrator if you need an account
          </p>
        </div>
      </div>
    </div>
  );
}
