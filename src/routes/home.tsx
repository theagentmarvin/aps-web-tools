import { useAuth } from "~/lib/auth-context";

export function Home() {
  const { login, logout, isAuthenticated } = useAuth();

  return (
    <div className="max-w-3xl mx-auto mt-12">
      <h1 className="text-3xl font-bold mb-4">APS Web Tools</h1>
      <p className="text-gray-400 mb-8">
        Autodesk Platform Services tool suite. Data Management, ACC Docs, and
        Model Coordination clash viewer.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <a
          href="/data-management"
          className="block p-6 rounded-lg border border-gray-800 bg-gray-900 hover:border-gray-700 transition-colors"
        >
          <h2 className="text-lg font-semibold mb-2">📁 Data Management</h2>
          <p className="text-sm text-gray-500">
            Browse hubs, projects, folders, and files. Upload and manage ACC
            Docs content.
          </p>
        </a>

        <a
          href="/clash-viewer"
          className="block p-6 rounded-lg border border-gray-800 bg-gray-900 hover:border-gray-700 transition-colors"
        >
          <h2 className="text-lg font-semibold mb-2">🔍 Clash Viewer</h2>
          <p className="text-sm text-gray-500">
            3D clash detection viewer. Load models, inspect clash instances, and
            navigate results.
          </p>
        </a>
      </div>

      <div className="mt-8 flex justify-center">
        {isAuthenticated ? (
          <button
            onClick={logout}
            className="px-6 py-2 rounded-lg border border-red-800 bg-red-950/50 text-red-400 hover:bg-red-900/50 transition-colors text-sm"
          >
            Sign out
          </button>
        ) : (
          <button
            onClick={login}
            className="px-6 py-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors"
          >
            Sign in with Autodesk
          </button>
        )}
      </div>

      <div className="mt-4 text-center">
        {isAuthenticated ? (
          <p className="text-xs text-green-600">✅ Authenticated</p>
        ) : (
          <p className="text-xs text-gray-600">
            Connect your Autodesk account to browse hubs and projects.
          </p>
        )}
      </div>
    </div>
  );
}
