import { Outlet } from "react-router";
import { Nav } from "~/lib/components/nav";

export function Layout() {
  return (
    <div className="min-h-screen flex flex-col">
      <Nav />
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
