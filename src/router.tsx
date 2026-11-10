import type { ComponentType } from "react";
import { Navigate, createBrowserRouter } from "react-router";
import { AuthGate } from "./lib/components/AuthGate";
import { Layout } from "./routes/layout";
import { Callback } from "./routes/callback";
import { DataManagement } from "./routes/data-management";
import { ProjectsPage } from "./routes/projects";
import { ProjectPage } from "./routes/project";
import { TriageWorkspace } from "./routes/triage";
import { ApprovalsPage } from "./routes/approvals";
import { BatchPage } from "./routes/batch";
import { RulesPage } from "./routes/rules";
import { RulePage } from "./routes/rule";
import { SettingsPage } from "./routes/settings";
import { PasskeyPage } from "./routes/passkey";
import { NotFoundPage } from "./routes/not-found";

/** Wrap a route component in AuthGate (all routes except callback and 404). */
function gated(C: ComponentType): ComponentType {
  const Gated = () => (
    <AuthGate>
      <C />
    </AuthGate>
  );
  Gated.displayName = `Gated(${C.displayName ?? C.name})`;
  return Gated;
}

/** Removed pages (Inicio, Reportes, Auditoría): old URLs land on Proyectos. The server audit log is unchanged. */
const ToProjects = () => <Navigate to="/proyectos" replace />;

export const router = createBrowserRouter([
  {
    path: "/",
    Component: Layout,
    children: [
      { index: true, Component: ToProjects },
      { path: "inicio", Component: ToProjects },
      { path: "auth/callback", Component: Callback },
      { path: "proyectos", Component: gated(ProjectsPage) },
      { path: "proyectos/:projectId", Component: gated(ProjectPage) },
      { path: "coordinacion/:projectId/:modelSetId", Component: gated(TriageWorkspace) },
      { path: "aprobaciones", Component: gated(ApprovalsPage) },
      { path: "aprobaciones/:batchId", Component: gated(BatchPage) },
      { path: "reglas", Component: gated(RulesPage) },
      { path: "reglas/:ruleId", Component: gated(RulePage) },
      { path: "reportes/*", Component: ToProjects },
      { path: "auditoria/*", Component: ToProjects },
      { path: "ajustes", Component: gated(SettingsPage) },
      { path: "ajustes/passkey", Component: gated(PasskeyPage) },
      { path: "data-management", Component: DataManagement },
      { path: "*", Component: NotFoundPage },
    ],
  },
]);
