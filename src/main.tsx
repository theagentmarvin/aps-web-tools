import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { I18nProvider } from "./i18n";
import { ApiProvider } from "./lib/api";
import { AuthProvider } from "./lib/auth-context";
import { ToastProvider } from "./lib/components/Toast";
import { SettingsProvider } from "./lib/settings";
import { router } from "./router";
import "./app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <SettingsProvider>
        <AuthProvider>
          <ApiProvider>
            <ToastProvider>
              <RouterProvider router={router} />
            </ToastProvider>
          </ApiProvider>
        </AuthProvider>
      </SettingsProvider>
    </I18nProvider>
  </StrictMode>,
);
