import { useAuth } from "~/lib/auth-context";

export function Home() {
  const { login, logout, isAuthenticated } = useAuth();

  return (
    <div className="max-w-3xl mx-auto mt-12">
      <h1 className="text-3xl font-bold mb-2">APS Viewer Toolkit</h1>
      <p className="text-gray-500 mb-2">
        Autodesk Platform Services viewer with custom visual tools.
      </p>
      <p className="text-xs text-gray-400 mb-8">
        Built on the APS Viewer SDK. Stage 0 — Clean Viewer.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <a
          href="/data-management"
          className="block p-6 rounded-lg border border-brand-muted/20 bg-white hover:border-brand-muted/40 hover:shadow-md transition-all"
        >
          <h2 className="text-lg font-semibold mb-2">📁 Data Management</h2>
          <p className="text-sm text-gray-500">
            Browse hubs, projects, folders, and models. Open any model in the
            3D viewer.
          </p>
        </a>

        <div className="block p-6 rounded-lg border border-brand-muted/20 bg-brand-surface/30 opacity-60">
          <h2 className="text-lg font-semibold mb-2">🎨 Visual Tools</h2>
          <p className="text-sm text-gray-500">
            Coming soon — color by property, filter &amp; isolate, saved views.
          </p>
        </div>
      </div>

      <div className="mt-8 flex justify-center">
        {isAuthenticated ? (
          <button
            onClick={logout}
            className="px-6 py-2 rounded-lg border border-red-200 bg-red-50 text-red-600 hover:bg-red-100 transition-colors text-sm"
          >
            Sign out
          </button>
        ) : (
          <button
            onClick={login}
            className="px-6 py-3 rounded-lg bg-brand hover:bg-brand-light text-white font-medium transition-colors"
          >
            Sign in with Autodesk
          </button>
        )}
      </div>

      <div className="mt-4 text-center">
        {isAuthenticated ? (
          <p className="text-xs text-green-600">✅ Authenticated</p>
        ) : (
          <p className="text-xs text-gray-400">
            Connect your Autodesk account to browse hubs and projects.
          </p>
        )}
      </div>
    </div>
  );
}
