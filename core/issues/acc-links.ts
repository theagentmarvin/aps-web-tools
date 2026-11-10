/**
 * Browser deep links into Autodesk Construction Cloud (Build › Issues). Pure (no node deps):
 * shared by the server (IssueCheck.accUrl) and the UI (batch page after apply).
 *
 * Format (UNVERIFIED against official docs: Autodesk documents only the REST route
 * /construction/issues/v1/projects/{projectId}/issues/{issueId}; the browser URL below is the
 * one ACC itself uses in issue notification e-mails and in the Issues list):
 *   {ACC_HOST}/build/issues/projects/{projectId}/issues?issueId={issueId}&preview=true
 * `projectId` is the ACC project id WITHOUT the Data Management "b." prefix; `issueId` is the
 * issue UUID (not the displayId "#103"). Since the May 2025 "deep linking" release ACC sends the
 * user on to the product where the issue was created (Build / Docs / Model Coordination).
 */
export const ACC_HOST = "https://acc.autodesk.com";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ACC Build issue URL, or undefined when the ids are not ACC UUIDs (fixtures, mock ids). */
export function accIssueUrl(projectId: string | undefined, issueId: string | undefined): string | undefined {
  if (!projectId || !issueId) return undefined;
  const p = projectId.startsWith("b.") ? projectId.slice(2) : projectId;
  if (!UUID.test(p) || !UUID.test(issueId)) return undefined;
  return `${ACC_HOST}/build/issues/projects/${p}/issues?issueId=${issueId}&preview=true`;
}
