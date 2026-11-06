import { Link } from "react-router";
import { useT } from "~/i18n";

export function NotFoundPage() {
  const t = useT();
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center text-center">
      <p className="font-mono text-sm text-gray-400">404</p>
      <h1 className="mt-2 text-2xl font-bold text-brand">{t("common.notFound")}</h1>
      <p className="mt-2 text-sm text-gray-500">{t("common.notFoundBody")}</p>
      <Link to="/" className="mt-6 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-light">
        {t("common.goHome")}
      </Link>
    </div>
  );
}
