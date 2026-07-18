import { Link } from "react-router";

export function Nav() {
  return (
    <nav className="border-b border-gray-800 bg-gray-900 px-6 py-3 flex items-center gap-6">
      <Link to="/" className="font-bold text-lg tracking-tight text-brand">
        APS Web Tools
      </Link>
      <div className="flex gap-4 text-sm text-gray-400">
        <Link to="/data-management" className="hover:text-white transition-colors">
          Data Management
        </Link>
        <Link to="/clash-viewer" className="hover:text-white transition-colors">
          Clash Viewer
        </Link>
      </div>
      <div className="ml-auto text-xs text-gray-600">v0.1.0</div>
    </nav>
  );
}
