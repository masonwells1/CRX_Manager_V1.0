import { AlertCircle } from 'lucide-react';

export function checkEnvVars() {
  const requiredVars = {
    VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
    VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
  };

  const missing = Object.entries(requiredVars)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  return {
    isValid: missing.length === 0,
    missing,
  };
}

export function EnvErrorScreen({ missing }: { missing: string[] }) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="max-w-2xl w-full bg-white rounded-lg shadow-lg p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center">
            <AlertCircle className="w-6 h-6 text-red-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              Configuration Error
            </h1>
            <p className="text-gray-600">Missing required environment variables</p>
          </div>
        </div>

        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
          <p className="text-sm font-medium text-red-900 mb-2">
            Missing variables:
          </p>
          <ul className="list-disc list-inside space-y-1">
            {missing.map((varName) => (
              <li key={varName} className="text-sm text-red-800 font-mono">
                {varName}
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 mb-2">
              How to fix this:
            </h2>
            <ol className="list-decimal list-inside space-y-2 text-sm text-gray-700">
              <li>
                Create a <code className="bg-gray-100 px-2 py-1 rounded">.env</code> file
                in the root of your project (copy from{' '}
                <code className="bg-gray-100 px-2 py-1 rounded">.env.example</code>)
              </li>
              <li>
                Add your Supabase credentials to the{' '}
                <code className="bg-gray-100 px-2 py-1 rounded">.env</code> file
              </li>
              <li>Restart the development server</li>
            </ol>
          </div>

          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <h3 className="text-sm font-semibold text-blue-900 mb-2">
              Where to get these values:
            </h3>
            <ol className="list-decimal list-inside space-y-1 text-sm text-blue-800">
              <li>Go to your Supabase dashboard</li>
              <li>Select your project</li>
              <li>Go to Settings → API</li>
              <li>Copy the URL and anon/public key</li>
            </ol>
            <a
              href="https://supabase.com/dashboard"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-600 hover:text-blue-700 underline mt-2 inline-block"
            >
              Open Supabase Dashboard →
            </a>
          </div>

          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
            <h3 className="text-sm font-semibold text-gray-900 mb-2">
              Example .env file:
            </h3>
            <pre className="text-xs bg-gray-900 text-gray-100 p-3 rounded overflow-x-auto">
{`VITE_SUPABASE_URL=https://xxxxxxxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key-here`}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
