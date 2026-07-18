import { createBrowserRouter } from "react-router";
import { Layout } from "./routes/layout";
import { Home } from "./routes/home";
import { Callback } from "./routes/callback";
import { DataManagement } from "./routes/data-management";
import { ClashViewer } from "./routes/clash-viewer";

export const router = createBrowserRouter([
  {
    path: "/",
    Component: Layout,
    children: [
      { index: true, Component: Home },
      { path: "auth/callback", Component: Callback },
      { path: "data-management", Component: DataManagement },
      { path: "clash-viewer", Component: ClashViewer },
    ],
  },
]);
