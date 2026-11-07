/**
 * HTTP API under `/api/coord/*` for the web UI (contract: ./contract.ts,
 * docs/api.md). Connect-style middleware usable from Vite (`configureServer`)
 * and from ./standalone.ts.
 *
 * Human-only endpoints require (1) a same-origin request (Origin, else
 * Referer, must equal the request host) and (2) the CSRF token from
 * `GET /api/coord/csrf` in the `X-Coord-CSRF` header, matching the
 * `coord_csrf` SameSite=Strict cookie (double submit). The token is random per
 * server process.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { ApsAuth } from "../aps/auth";
import { Coordinator, type CoordinatorOptions } from "../coordinator";
import { CoordinatorUi, type HumanUser } from "../coordinator-ui";
import { LiveSource } from "../source/live";
import { CoordError, httpStatusFor, log } from "../util";

export const API_PREFIX = "/api/coord";

type Next = (err?: unknown) => void;
type Handler = (c: RequestCtx) => Promise<unknown>;

interface RequestCtx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  user: () => Promise<HumanUser>;
}

interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  human: boolean;
  handler: Handler;
}

const MAX_BODY = 2 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += b.length;
    if (size > MAX_BODY) throw new CoordError("validation_error", "Cuerpo demasiado grande");
    chunks.push(b);
  }
  if (!size) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new CoordError("validation_error", "JSON inválido");
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(JSON.stringify(body));
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Origin (or Referer) must be the same host the request was sent to. */
export function isSameOrigin(req: IncomingMessage): boolean {
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  const src = (req.headers.origin as string | undefined) ?? (req.headers.referer as string | undefined);
  if (!host || !src) return false;
  try {
    return new URL(src).host === host;
  } catch {
    return false;
  }
}

const csv = (v: string | null) => (v ? v.split(",").filter(Boolean) : undefined);
const num = (v: string | null) => (v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

// ── body schemas ────────────────────────────────────────────────────────────

const Id = z.string().min(1).max(200);
const DecisionSchema = z.object({
  id: z.string().min(8).max(80),
  proposalId: Id,
  targetType: z.enum(["group", "clash"]),
  targetId: Id,
  testId: z.string().regex(/^T-[0-9a-f]{8}$/),
  modelSetId: z.string().max(80),
  projectId: z.string().max(80),
  kind: z.enum(["accept", "correct", "reject", "postpone", "note", "undo"]),
  changes: z
    .array(z.object({ field: z.enum(["validity", "priority", "owner", "action", "group", "issueDraft"]), aiValue: z.unknown(), humanValue: z.unknown(), aiConfidence: z.number().optional(), aiSource: z.string().max(40).optional(), ruleIds: z.array(z.string().max(20)).max(50).optional() }))
    .max(10),
  reasonCode: z.enum(["R01", "R02", "R03", "R04", "R05", "R06", "R07", "R08", "R09", "R10", "R11", "R12", "R13", "R99"]).optional(),
  note: z.string().max(1000).optional(),
  suggestRule: z.boolean().optional(),
  viewedInViewerMs: z.number().min(0).max(86_400_000),
  decidedAt: z.string().max(40),
  userId: z.string().max(200).optional().default(""),
  userName: z.string().max(200).optional().default(""),
  bulk: z.object({ size: z.number().int().min(1) }).optional(),
  undoes: z.string().max(80).optional(),
  batchId: z.string().max(80).optional(),
});
const IssuePatch = z
  .object({
    title: z.string().max(100),
    description: z.string().max(1000),
    ownerDiscipline: z.string().max(10),
    assigneeRole: z.string().max(60),
    assigneeId: z.string().max(80),
    assigneeType: z.enum(["user", "role", "company"]),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    issueType: z.string().max(60),
    issueSubtype: z.string().max(60),
    location: z.string().max(120),
    includeView: z.boolean(),
    linkClashIds: z.array(z.string().max(30)).max(1000),
    pinnedView: z.unknown(),
  })
  .partial();
const ApproveSchema = z.object({
  confirmWord: z.string().max(20),
  staleOverride: z.boolean().optional(),
  note: z.string().max(500).optional(),
  excludedItemIds: z.array(z.string().max(40)).max(5000).default([]),
  apply: z.boolean().optional(),
});
const FeedbackSchema = z.object({
  target: z.union([z.object({ proposalId: Id }), z.object({ groupId: Id, testId: z.string().optional() })]),
  verdict: z.enum(["correct", "incorrect", "partially_correct"]),
  corrected: z.record(z.string(), z.unknown()).optional(),
  coordinatorStatement: z.string().min(1).max(500),
  generalizable: z.enum(["yes", "no", "unsure"]).default("unsure"),
  scope: z.enum(["this_group", "project", "company"]).default("this_group"),
});

export interface CoordApiOptions extends CoordinatorOptions {
  coordinator?: Coordinator;
}

export interface CoordApi {
  middleware: (req: IncomingMessage, res: ServerResponse, next?: Next) => void;
  coordinator: Coordinator;
  ui: CoordinatorUi;
  csrfToken: string;
}

/** Create the API (one Coordinator per process). */
export function createCoordApi(opts: CoordApiOptions = {}): CoordApi {
  const coord = opts.coordinator ?? new Coordinator(opts);
  const ui = new CoordinatorUi(coord);
  const csrfToken = randomBytes(24).toString("base64url");
  const routes: Route[] = [];
  let loginInProgress = false;

  const add = (method: string, path: string, handler: Handler, human = false) => {
    const keys: string[] = [];
    const re = new RegExp(`^${API_PREFIX}${path.replace(/:([A-Za-z]+)/g, (_m, k: string) => (keys.push(k), "([^/]+)"))}/?$`);
    routes.push({ method, re, keys, human, handler });
  };
  const userOf = async (): Promise<HumanUser> => {
    const u = await ui.currentUser();
    if (!u) throw new CoordError("not_authenticated", "Inicia sesión con APS (o configura approver.name en coordinator.config.local.json).");
    return u;
  };
  const apsAuth = (): ApsAuth | undefined => (coord.source instanceof LiveSource ? coord.source.auth : undefined);

  // ── session / auth ─────────────────────────────────────────────────────
  add("GET", "/csrf", async ({ res }) => {
    res.setHeader("Set-Cookie", `coord_csrf=${csrfToken}; Path=/api/coord; SameSite=Strict; HttpOnly`);
    return { token: csrfToken };
  });
  add("GET", "/auth/status", async () => {
    const s = await coord.source.authStatus();
    const u = s.loggedIn ? await ui.me().catch(() => undefined) : undefined;
    return { loggedIn: s.loggedIn, dataSource: coord.source.kind, ...(u ? { user: u } : {}), ...(s.expiresAt ? { expiresAt: s.expiresAt } : {}), ...(s.scopes ? { scopes: s.scopes } : {}), loginInProgress };
  });
  add(
    "POST",
    "/auth/login",
    async () => {
      if (coord.source.kind === "fixtures") return { alreadyLoggedIn: true };
      const auth = apsAuth();
      if (!auth) throw new CoordError("not_authenticated", "APS no está configurado en el servidor (client id ausente).");
      const st = await auth.status();
      if (st.loggedIn) {
        try {
          await auth.getAccessToken();
          return { alreadyLoggedIn: true };
        } catch {
          /* refresh failed: fall through to a new login */
        }
      }
      if (loginInProgress) throw new CoordError("conflict", "Ya hay un inicio de sesión en curso.");
      loginInProgress = true;
      let resolveUrl!: (u: string) => void;
      const urlP = new Promise<string>((r) => (resolveUrl = r));
      const loginAuth = new ApsAuth({ config: auth.config, openBrowser: (u) => resolveUrl(u) });
      void loginAuth
        .loginInteractive({ timeoutMs: 5 * 60_000 })
        .then(() => log.info("api.login_ok"))
        .catch((e) => log.warn("api.login_failed", { message: (e as Error).message }))
        .finally(() => (loginInProgress = false));
      const authorizeUrl = await Promise.race([urlP, new Promise<string>((_, rej) => setTimeout(() => rej(new CoordError("internal", "No se pudo iniciar el login")), 10_000))]);
      return { authorizeUrl, alreadyLoggedIn: false };
    },
    true,
  );
  add(
    "POST",
    "/auth/logout",
    async () => {
      await apsAuth()?.logout();
      return { ok: true };
    },
    true,
  );
  add("GET", "/me", async () => ui.me());
  add("GET", "/session", async () => ui.session());
  add("GET", "/agent/status", async () => ui.agentStatus());
  add("GET", "/home", async () => ui.home());

  // ── projects ───────────────────────────────────────────────────────────
  add("GET", "/hubs", async () => ui.hubs());
  add("GET", "/projects", async ({ query }) => ui.projects({ hubId: query.get("hubId") ?? undefined, q: query.get("q") ?? undefined }));
  add("GET", "/projects/:projectId", async ({ params }) => ui.project(params.projectId));
  add("GET", "/projects/:projectId/model-sets", async ({ params }) => ui.modelSets(params.projectId));
  add("GET", "/projects/:projectId/model-sets/:modelSetId/tests", async ({ params }) => ui.tests(params.projectId, params.modelSetId));
  add("GET", "/projects/:projectId/assignees", async ({ params }) => ui.assignees(params.projectId));
  add("GET", "/projects/:projectId/notes", async ({ params }) => ui.notes(params.projectId));
  add(
    "POST",
    "/projects/:projectId/notes",
    async ({ params, body, user }) => {
      const b = z.object({ text: z.string().min(3).max(500), kind: z.string().max(30).optional() }).parse(body);
      return ui.appendNote(params.projectId, b.text, b.kind, await user());
    },
    true,
  );
  add(
    "POST",
    "/projects/:projectId/model-sets/:modelSetId/tests/:accTestId/ingest",
    async ({ params, body, user }) => {
      const b = z.object({ refresh: z.boolean().optional(), classify: z.boolean().optional() }).parse(body ?? {});
      return ui.ingestAndClassify(params.projectId, params.modelSetId, params.accTestId, b, await user());
    },
    true,
  );

  // ── triage ─────────────────────────────────────────────────────────────
  add("GET", "/triage/:projectId/:modelSetId", async ({ params, query }) => ui.triage(params.projectId, params.modelSetId, query.get("test") ?? undefined));
  add("GET", "/triage/:projectId/:modelSetId/changes", async ({ query }) => {
    const test = query.get("test");
    if (!test) throw new CoordError("validation_error", "Falta test");
    return ui.triageChanges(test, query.get("since") ?? "");
  });
  add("GET", "/tests/:testId/groups", async ({ params, query }) =>
    ui.groups({
      testId: params.testId,
      filter: {
        pair: csv(query.get("pair")),
        priority: csv(query.get("priority"))?.map(Number).filter((n) => n >= 1 && n <= 4) as (1 | 2 | 3 | 4)[] | undefined,
        validity: csv(query.get("validity")) as never,
        level: csv(query.get("level")),
        accStatus: csv(query.get("accStatus")) as never,
        delta: csv(query.get("delta")) as never,
      },
      sort: (query.get("sort") ?? undefined) as never,
      limit: num(query.get("limit")),
      cursor: query.get("cursor") ?? undefined,
    }),
  );
  add("GET", "/tests/:testId/groups/:groupId", async ({ params }) => ui.groupDetail(params.testId, params.groupId));
  add("GET", "/tests/:testId/groups/:groupId/clashes", async ({ params, query }) => ui.groupClashes(params.testId, params.groupId, num(query.get("limit")), query.get("cursor") ?? undefined));
  add("POST", "/tests/:testId/elements/properties", async ({ params, body }) => {
    const b = z.object({ refs: z.array(z.string().regex(/^E-\d+:\d+$/)).min(1).max(20) }).parse(body);
    return ui.elementProperties(params.testId, b.refs);
  });
  add("GET", "/tests/:testId/proposals", async ({ params, query }) => ui.proposals(params.testId, csv(query.get("ids")), num(query.get("limit")), query.get("cursor") ?? undefined));
  add("GET", "/projects/:projectId/model-sets/:modelSetId/tests/:testId/triage", async ({ params }) => ui.triage(params.projectId, params.modelSetId, params.testId));

  // ── decisions & batches (human) ────────────────────────────────────────
  add(
    "POST",
    "/triage/decisions",
    async ({ body, user }) => ui.saveDecisions(z.array(DecisionSchema).max(500).parse(body) as never, await user()),
    true,
  );
  add("GET", "/decisions", async ({ query }) => ui.listDecisions({ testId: query.get("testId") ?? undefined, projectId: query.get("projectId") ?? undefined, limit: num(query.get("limit")), cursor: query.get("cursor") ?? undefined }));
  add(
    "POST",
    "/batches",
    async ({ body, user }) => ui.sendToApproval(z.object({ projectId: Id, modelSetId: Id, testId: z.string().regex(/^T-[0-9a-f]{8}$/) }).parse(body), await user()),
    true,
  );
  add("GET", "/batches", async ({ query }) => ui.listBatches({ state: csv(query.get("state")), projectId: query.get("projectId") ?? undefined }));
  add("GET", "/batches/:batchId", async ({ params }) => ui.getBatch(params.batchId));
  add("POST", "/batches/:batchId/preflight", async ({ params, user }) => ui.preflight(params.batchId, await user()), true);
  add("PATCH", "/batches/:batchId/items", async ({ params, body }) => {
    const b = z.object({ itemIds: z.array(z.string().max(40)).min(1).max(5000), excluded: z.boolean() }).parse(body);
    return ui.setItemsExcluded(params.batchId, b.itemIds, b.excluded);
  }, true);
  add("PATCH", "/batches/:batchId/items/:itemId/issue", async ({ params, body }) => ui.updateIssue(params.batchId, params.itemId, IssuePatch.parse(body ?? {}) as never), true);
  add("POST", "/batches/:batchId/return", async ({ params, user }) => ui.returnToReview(params.batchId, await user()), true);
  add("POST", "/batches/:batchId/discard", async ({ params, user }) => ui.discard(params.batchId, await user()), true);
  add("POST", "/batches/:batchId/approve", async ({ params, body, user }) => ui.approve(params.batchId, ApproveSchema.parse(body) as never, await user()), true);
  add(
    "POST",
    "/batches/:batchId/apply",
    async ({ params, body, user }) => {
      const b = z.object({ dryRun: z.boolean().default(true) }).parse(body ?? {});
      const u = await user();
      return ui.apply(params.batchId, b, { type: "user", id: u.id, name: u.name });
    },
    true,
  );
  add("GET", "/batches/:batchId/apply-status", async ({ params }) => ui.applyStatus(params.batchId));

  // ── learning / rules / reports / audit ─────────────────────────────────
  add("POST", "/feedback", async ({ body, user }) => ui.submitFeedback(FeedbackSchema.parse(body) as never, await user()), true);
  add("GET", "/rules", async () => ui.rules());
  add("GET", "/rules/:ruleId", async ({ params }) => ui.rule(params.ruleId));
  add("GET", "/rule-suggestions", async () => ui.ruleSuggestions());
  add(
    "POST",
    "/rule-suggestions/:id/decision",
    async ({ params, body, user }) => ui.decideRuleSuggestion(params.id, z.object({ decision: z.enum(["approve", "reject"]) }).parse(body).decision, await user()),
    true,
  );
  add("GET", "/learning/corrections", async ({ query }) => ui.corrections({ projectId: query.get("projectId") ?? undefined, limit: num(query.get("limit")), cursor: query.get("cursor") ?? undefined }));
  add("GET", "/learning/calibration", async () => ui.calibration());
  add("GET", "/reports", async ({ query }) => ui.report({ projectId: query.get("projectId") ?? undefined, modelSetId: query.get("modelSetId") ?? undefined, from: query.get("from") ?? undefined, to: query.get("to") ?? undefined }));
  add("GET", "/audit", async ({ query }) =>
    ui.audit({
      project: query.get("project") ?? undefined,
      user: query.get("user") ?? undefined,
      action: query.get("action") ?? undefined,
      from: query.get("from") ?? undefined,
      to: query.get("to") ?? undefined,
      batch: query.get("batch") ?? undefined,
      limit: num(query.get("limit")),
      cursor: query.get("cursor") ?? undefined,
    }),
  );

  const middleware = (req: IncomingMessage, res: ServerResponse, next?: Next) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith(API_PREFIX)) {
      if (next) next();
      else send(res, 404, { error: { code: "not_found", message: "Ruta no encontrada" } });
      return;
    }
    void (async () => {
      const method = (req.method ?? "GET").toUpperCase();
      const candidates = routes.filter((r) => r.re.test(url.pathname));
      const route = candidates.find((r) => r.method === method);
      if (!route) {
        send(res, candidates.length ? 405 : 404, { error: { code: "not_found", message: `${method} ${url.pathname} no existe` } });
        return;
      }
      try {
        if (method !== "GET" || route.human) {
          if (!isSameOrigin(req)) throw new CoordError("forbidden", "Solicitud de otro origen rechazada.");
        }
        if (route.human) {
          const header = String(req.headers["x-coord-csrf"] ?? "");
          const ck = cookie(req, "coord_csrf") ?? "";
          if (!header || !safeEq(header, csrfToken) || !safeEq(ck, csrfToken)) throw new CoordError("forbidden", "Token CSRF ausente o inválido (GET /api/coord/csrf).");
        }
        const m = route.re.exec(url.pathname)!;
        const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
        const body = method === "GET" ? undefined : await readBody(req);
        const result = await route.handler({ req, res, params, query: url.searchParams, body, user: userOf });
        send(res, 200, result ?? { ok: true });
      } catch (err) {
        const { status, body } = errorBody(err);
        if (status >= 500) log.warn("api.error", { path: url.pathname, message: (err as Error).message });
        send(res, status, body);
      }
    })();
  };

  return { middleware, coordinator: coord, ui, csrfToken };
}

export function errorBody(err: unknown): { status: number; body: { error: { code: string; message: string; hint?: string } } } {
  if (err instanceof CoordError) return { status: httpStatusFor(err.code), body: { error: { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) } } };
  const e = err as { name?: string; message?: string; status?: number; code?: string };
  if (e?.name === "ZodError") return { status: 400, body: { error: { code: "validation_error", message: String(e.message).slice(0, 1000) } } };
  if (e?.name === "ApsError") {
    const status = e.code === "auth_required" || e.status === 401 ? 401 : e.status === 429 ? 429 : 502;
    return { status, body: { error: { code: status === 401 ? "not_authenticated" : "aps_error", message: String(e.message) } } };
  }
  return { status: 500, body: { error: { code: "internal", message: String(e?.message ?? err).slice(0, 500) } } };
}
