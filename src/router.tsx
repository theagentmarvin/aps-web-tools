import type { ComponentType } from "react";
import { createBrowserRouter } from "react-router";
import { AuthGate } from "./lib/components/AuthGate";
import { Layout } from "./routes/layout";
import { HomePage } from "./routes/home";
import { Callback } from "./routes/callback";
import { DataManagement } from "./routes/data-management";
import { ProjectsPage } from "./routes/projects";
import { ProjectPage } from "./routes/project";
import { TriageWorkspace } from "./routes/triage";
import { ApprovalsPage } from "./routes/approvals";
import { BatchPage } from "./routes/batch";
import { RulesPage } from "./routes/rules";
import { RulePage } from "./routes/rule";
import { ReportsPage } from "./routes/reports";
import { AuditPage } from "./routes/audit";
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

export const router = createBrowserRouter([
  {
    path: "/",
    Component: Layout,
    children: [
      { index: true, Component: HomePage },
      { path: "auth/callback", Component: Callback },
      { path: "proyectos", Component: gated(ProjectsPage) },
      { path: "proyectos/:projectId", Component: gated(ProjectPage) },
      { path: "coordinacion/:projectId/:modelSetId", Component: gated(TriageWorkspace) },
      { path: "aprobaciones", Component: gated(ApprovalsPage) },
      { path: "aprobaciones/:batchId", Component: gated(BatchPage) },
      { path: "reglas", Component: gated(RulesPage) },
      { path: "reglas/:ruleId", Component: gated(RulePage) },
      { path: "reportes", Component: gated(ReportsPage) },
      { path: "reportes/:projectId", Component: gated(ReportsPage) },
      { path: "auditoria", Component: gated(AuditPage) },
      { path: "ajustes", Component: gated(SettingsPage) },
      { path: "ajustes/passkey", Component: gated(PasskeyPage) },
      { path: "data-management", Component: DataManagement },
      { path: "*", Component: NotFoundPage },
    ],
  },
]);
