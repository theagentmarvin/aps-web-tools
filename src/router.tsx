import { createBrowserRouter } from "react-router";
import { Layout } from "./routes/layout";
import { Home } from "./routes/home";
import { Callback } from "./routes/callback";
import { DataManagement } from "./routes/data-management";

export const router = createBrowserRouter([
  {
    path: "/",
    Component: Layout,
    children: [
      { index: true, Component: Home },
      { path: "auth/callback", Component: Callback },
      { path: "data-management", Component: DataManagement },
    ],
  },
]);
