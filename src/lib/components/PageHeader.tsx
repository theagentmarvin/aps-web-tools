import type { ReactNode } from "react";
import { Link } from "react-router";

export interface Crumb {
  label: string;
  to?: string;
}

export function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="breadcrumb" className="text-sm text-gray-500">
      <ol className="flex flex-wrap items-center gap-1">
        {crumbs.map((c, i) => (
          <li key={i} className="flex items-center gap-1">
            {i > 0 && <span aria-hidden>/</span>}
            {c.to ? (
              <Link to={c.to} className="hover:text-brand">
                {c.label}
              </Link>
            ) : (
              <span aria-current="page" className="text-gray-700">
                {c.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function PageHeader({ title, crumbs, actions, subtitle }: { title: string; crumbs?: Crumb[]; actions?: ReactNode; subtitle?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {crumbs && crumbs.length > 0 && <Breadcrumbs crumbs={crumbs} />}
        <h1 className="mt-1 text-2xl font-bold text-brand">{title}</h1>
        {subtitle && <div className="mt-1 text-sm text-gray-500">{subtitle}</div>}
      </div>
      {actions && <div className="no-print flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}
