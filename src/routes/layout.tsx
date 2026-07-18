import { Outlet } from "react-router";
import { Nav } from "~/lib/components/nav";

export function Layout() {
  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <Nav />
      <main className="flex-1 min-h-0">
        <Outlet />
      </main>
    </div>
  );
}
