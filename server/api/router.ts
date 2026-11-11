/**
 * HTTP API under `/api/coord/*` for the web UI (contract: ./contract.ts,
 * docs/api.md). Connect-style middleware usable from Vite (`configureServer`)
 * and from ./standalone.ts.
 *
 * Order of checks (./host-guard.ts): exact Host allowlist (anti DNS
 * rebinding, X-Forwarded-* ignored) → exact Origin for every non-GET →
 * Sec-Fetch-Site same-origin when present → for human-only endpoints the CSRF
 * token from `GET /api/coord/csrf` in `X-Coord-CSRF`, matching the HttpOnly
 * SameSite=Strict `coord_csrf` cookie (random per process).
 * These stop other websites, not local non-browser clients: approvals are
 * proven by a WebAuthn user-verified signature (server/approval/webauthn.ts).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { z } from "zod";
import { isFrozen } from "./frozen";
import { ChatService } from "../chat/service";
import { FlowService } from "../flows/service";
import { nextSteps } from "../next-steps";
import { ApsAuth } from "../aps/auth";
import { Coordinator, type CoordinatorOptions } from "../coordinator";
import { CoordinatorUi, type HumanUser } from "../coordinator-ui";
import { loadRules } from "../engine";
import { REASON_CODES } from "../store/types";
import { LiveSource } from "../source/live";
import { CoordError, httpStatusFor, log } from "../util";
import { fetchSiteOk, hostAllowed, originMatches } from "./host-guard";
import { listFeedbackRows, listReportFiles, readReportFile, testHygiene } from "../parity";

export const API_PREFIX = "/api/coord";

type Next = (err?: unknown) => void;
type Handler = (c: RequestCtx) => Promise<unknown>;

const LoginSchema = z.strictObject({
  returnTo: z
    .string()
    .max(300)
    .regex(/^\/(?![/\\])[^\s\\]*$/, "returnTo debe ser una ruta relativa del sitio")
    .optional(),
});

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

/** Responses above this size are compressed when the client accepts it. */
const COMPRESS_MIN_BYTES = 8 * 1024;
/** Serialized / compressed bodies of memoized payload objects (same object → same bytes). */
const encoded = new WeakMap<object, { json?: Buffer; br?: Buffer; gzip?: Buffer }>();

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}, req?: IncomingMessage): void {
  const memo = isFrozen(body) ? (encoded.get(body as object) ?? {}) : {};
  const json = memo.json ?? Buffer.from(JSON.stringify(body));
  const accept = String(req?.headers["accept-encoding"] ?? "");
  let enc: "br" | "gzip" | undefined;
  if (json.length >= COMPRESS_MIN_BYTES) enc = /\bbr\b/.test(accept) ? "br" : /\bgzip\b/.test(accept) ? "gzip" : undefined;
  let out = json;
  if (enc === "br") out = memo.br ??= brotliCompressSync(json, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: json.length } });
  else if (enc === "gzip") out = memo.gzip ??= gzipSync(json, { level: 6 });
  if (isFrozen(body) && status === 200) encoded.set(body as object, { ...memo, json });
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    Vary: "Accept-Encoding",
    ...(enc ? { "Content-Encoding": enc } : {}),
    "Content-Length": String(out.length),
    ...headers,
  });
  res.end(out);
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
/** @deprecated kept for compatibility: exact Origin match (see ./host-guard.ts). */
export function isSameOrigin(req: IncomingMessage): boolean {
  return originMatches(req);
}

const csv = (v: string | null) => (v ? v.split(",").filter(Boolean) : undefined);
const num = (v: string | null) => (v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

// ── body schemas ────────────────────────────────────────────────────────────

const Id = z.string().min(1).max(200);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** humanValue is validated per field (it ends up in ACC request bodies). */
const HumanValue: Record<string, z.ZodType> = {
  validity: z.enum(["real", "false_positive", "tolerated", "needs_info"]),
  priority: z.number().int().min(1).max(4),
  owner: z.string().regex(/^[A-Z]{2,6}$/),
  action: z.strictObject({ createIssue: z.boolean(), setStatus: z.enum(["active", "reviewed", "resolved", "closed"]).nullable() }),
  group: z.strictObject({ type: z.enum(["merge", "split", "move"]), groupIds: z.array(z.string().max(20)).max(20).optional(), clashIds: z.array(z.string().max(30)).max(1000).optional() }),
  issueDraft: z.strictObject({
    title: z.string().max(100).optional(),
    description: z.string().max(1000).optional(),
    ownerDiscipline: z.string().regex(/^[A-Z]{2,6}$/).optional(),
    assigneeRole: z.string().max(60).optional(),
    assigneeId: z.string().max(80).optional(),
    assigneeType: z.enum(["user", "role", "company"]).optional(),
    dueDate: IsoDate.optional(),
    issueType: z.string().max(60).optional(),
    issueSubtype: z.string().max(60).optional(),
    location: z.string().max(120).optional(),
    includeView: z.boolean().optional(),
    linkClashIds: z.array(z.string().max(30)).max(1000).optional(),
    pinnedView: z.unknown().optional(),
  }),
};
const ChangeSchema = z
  .object({
    field: z.enum(["validity", "priority", "owner", "action", "group", "issueDraft"]),
    aiValue: z.unknown(),
    humanValue: z.unknown(),
    aiConfidence: z.number().min(0).max(1).optional(),
    aiSource: z.string().max(40).optional(),
    ruleIds: z.array(z.string().max(20)).max(50).optional(),
  })
  .superRefine((c, ctx) => {
    const r = HumanValue[c.field]!.safeParse(c.humanValue);
    if (!r.success) ctx.addIssue({ code: "custom", path: ["humanValue"], message: `humanValue inválido para ${c.field}: ${r.error.issues[0]?.message ?? ""}` });
  });
const DecisionSchema = z.object({
  id: z.string().min(8).max(80),
  proposalId: Id,
  targetType: z.enum(["group", "clash"]),
  targetId: Id,
  testId: z.string().regex(/^T-[0-9a-f]{8}$/),
  modelSetId: z.string().max(80),
  projectId: z.string().max(80),
  kind: z.enum(["accept", "correct", "reject", "postpone", "note", "undo"]),
  changes: z.array(ChangeSchema).max(10),
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
    issueTypeLabel: z.string().max(120),
    assigneeLabel: z.string().max(120),
  })
  .partial();
const AssertionSchema = z.object({
  id: z.string().max(1024),
  rawId: z.string().max(1024),
  type: z.literal("public-key"),
  response: z.object({ authenticatorData: z.string().max(4096), clientDataJSON: z.string().max(8192), signature: z.string().max(2048), userHandle: z.string().max(1024).optional() }),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  authenticatorAttachment: z.string().max(40).optional(),
});
/** Strict: unknown keys (e.g. the removed `apply`) are rejected. */
const ApproveSchema = z.strictObject({
  confirmWord: z.string().max(20),
  note: z.string().max(500).optional(),
  excludedItemIds: z.array(z.string().max(40)).max(5000).default([]),
  webauthn: z.strictObject({ nonce: z.string().regex(/^[0-9a-f]{32}$/), origin: z.string().max(100), response: AssertionSchema }).optional(),
  demo: z.boolean().optional(),
});
const RegisterSchema = z.strictObject({
  response: z.object({
    id: z.string().max(1024),
    rawId: z.string().max(1024),
    type: z.literal("public-key"),
    response: z.object({ clientDataJSON: z.string().max(8192), attestationObject: z.string().max(65536) }).passthrough(),
    clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
    authenticatorAttachment: z.string().max(40).optional(),
  }),
  label: z.string().max(60).optional(),
  enrollCode: z.string().max(20).optional(),
  stepUp: AssertionSchema.optional(),
});
const enumCsv = <T extends string>(values: readonly [T, ...T[]], v: string | null): T[] | undefined => {
  const list = csv(v);
  return list ? z.array(z.enum(values)).parse(list) : undefined;
};
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
  /** Chat agent timeout (tests). */
  chatTimeoutMs?: number;
  /** Flow timeout override (tests). */
  flowTimeoutMs?: number;
  /** Poll the store for flow runs queued by the chat's MCP process (default true). */
  flowPolling?: boolean;
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
  try {
    loadRules(); // logs CompiledRuleSet.warnings once (stderr)
  } catch (e) {
    log.warn("rules.invalid", { message: (e as Error).message.slice(0, 500) });
  }
  const ui = new CoordinatorUi(coord);
  const csrfToken = randomBytes(24).toString("base64url");
  const routes: Route[] = [];
  let loginInProgress = false;
  /** Authorize URL of the login in progress: re-clicking "sign in" reopens it instead of failing. */
  let pendingAuthorizeUrl: string | undefined;

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
  add("GET", "/csrf", async ({ req, res }) => {
    if (!fetchSiteOk(req)) throw new CoordError("forbidden", "Sec-Fetch-Site distinto de same-origin.");
    res.setHeader("Set-Cookie", `coord_csrf=${csrfToken}; Path=/api/coord; SameSite=Strict; HttpOnly`);
    return { token: csrfToken };
  });
  let lastSession = "";
  add("GET", "/auth/status", async () => {
    const s = await coord.source.authStatus();
    // Session changed (login / logout / refresh elsewhere): drop the cached ACC reads (review fix #12).
    const sk = `${s.loggedIn}:${s.expiresAt ?? ""}`;
    if (sk !== lastSession) {
      if (lastSession) ui.invalidateCaches();
      lastSession = sk;
    }
    const u = s.loggedIn ? await ui.me().catch(() => undefined) : undefined;
    return { loggedIn: s.loggedIn, dataSource: coord.source.kind, ...(u ? { user: u } : {}), ...(s.expiresAt ? { expiresAt: s.expiresAt } : {}), ...(s.scopes ? { scopes: s.scopes } : {}), ...(s.needsReauth ? { needsReauth: true } : {}), loginInProgress };
  });
  add(
    "POST",
    "/auth/login",
    async ({ req, body }) => {
      if (coord.source.kind === "fixtures") return { alreadyLoggedIn: true };
      // Web login returns to the app page it started from. Only a same-site relative path is
      // accepted (no open redirect); the origin is the request's validated Origin header.
      const { returnTo } = LoginSchema.parse(body ?? {});
      ui.invalidateCaches();
      const origin = String(req.headers.origin ?? "");
      const redirectTo = returnTo && origin ? `${origin}${returnTo}` : undefined;
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
      // A login is already waiting for its callback (e.g. the Autodesk tab was closed):
      // hand back the same authorize URL; its state/PKCE pair is still the one being awaited.
      if (loginInProgress) {
        if (pendingAuthorizeUrl) return { authorizeUrl: pendingAuthorizeUrl, alreadyLoggedIn: false };
        throw new CoordError("conflict", "Ya hay un inicio de sesión en curso; inténtalo de nuevo en unos segundos.");
      }
      loginInProgress = true;
      let resolveUrl!: (u: string) => void;
      const urlP = new Promise<string>((r) => (resolveUrl = r));
      const loginAuth = new ApsAuth({ config: auth.config, openBrowser: (u) => resolveUrl(u) });
      void loginAuth
        .loginInteractive({ timeoutMs: 5 * 60_000, redirectTo })
        .then(() => log.info("api.login_ok"))
        .catch((e) => log.warn("api.login_failed", { message: (e as Error).message }))
        .finally(() => {
          loginInProgress = false;
          pendingAuthorizeUrl = undefined;
        });
      const authorizeUrl = await Promise.race([urlP, new Promise<string>((_, rej) => setTimeout(() => rej(new CoordError("internal", "No se pudo iniciar el login")), 10_000))]);
      pendingAuthorizeUrl = authorizeUrl;
      return { authorizeUrl, alreadyLoggedIn: false };
    },
    true,
  );
  add(
    "POST",
    "/auth/logout",
    async () => {
      await apsAuth()?.logout();
      ui.invalidateCaches();
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
      const b = z.object({ refresh: z.boolean().optional(), classify: z.boolean().optional(), wait: z.boolean().optional() }).parse(body ?? {});
      // Default: asynchronous job (phase 1 makes the clash grid available within seconds).
      if (b.wait) return ui.ingestAndClassify(params.projectId, params.modelSetId, params.accTestId, b, await user());
      return ui.startIngest(params.projectId, params.modelSetId, params.accTestId, b, await user());
    },
    true,
  );
  add("GET", "/ingest-jobs/:jobId", async ({ params }) => coord.getIngestJob(params.jobId));
  add("GET", "/projects/:projectId/model-sets/:modelSetId/clash-grid", async ({ params, query }) => ui.clashGrid(params.projectId, params.modelSetId, query.get("test") ?? undefined));
  add("GET", "/projects/:projectId/model-sets/:modelSetId/views", async ({ params }) => ui.modelSetViews(params.projectId, params.modelSetId));

  // ── solution families (writes are human-only, audited, versioned) ─────
  const ValidityZ = z.enum(["real", "false_positive", "tolerated", "needs_info"]);
  const FamilyActionZ = z.enum(["create_issue", "close", "mark_reviewed", "hygiene_issue", "escalate"]);
  const DecisionFieldsZ = z.object({
    validity: ValidityZ.optional(),
    action: FamilyActionZ.optional(),
    responsibleDiscipline: z.string().min(2).max(6).optional(),
    secondaryDiscipline: z.string().min(2).max(6).optional(),
    solutionOption: z.string().max(300).optional(),
    typicalDetail: z.object({ name: z.string().min(1).max(120), note: z.string().max(400).optional() }).optional(),
    issueMode: z.enum(["family", "per_instance"]).optional(),
  });
  const TestIdZ = z.string().min(1).max(64);
  const GroupIdZ = z.string().regex(/^G-[0-9a-f]{6,16}$/);
  const FamilyIdZ = z.string().regex(/^F-[0-9A-Za-z]{6,16}$/);
  add("GET", "/tests/:testId/families", async ({ params }) => ui.families(params.testId));
  add("GET", "/tests/:testId/families/:familyId", async ({ params }) => ui.family(params.testId, params.familyId));
  // Chat panel regroup proposals (move_groups / detach_clashes / merge_families / split_family): human applies or rejects.
  add("POST", "/proposals/:proposalId/regroup", async ({ params, body, user }) => ui.decideRegroup(params.proposalId, z.strictObject({ testId: TestIdZ, decision: z.enum(["apply", "reject"]) }).parse(body), await user()), true);
  add("POST", "/families/merge", async ({ body, user }) => ui.mergeFamilies(z.strictObject({ testId: TestIdZ, from: FamilyIdZ, into: FamilyIdZ }).parse(body), await user()), true);
  add("POST", "/families/:familyId/decision-preview", async ({ params, body }) => ui.familyDecisionPreview(params.familyId, DecisionFieldsZ.extend({ testId: TestIdZ }).parse(body)), true);
  add(
    "POST",
    "/families/:familyId/decision",
    async ({ params, body, user }) =>
      ui.decideFamily(
        params.familyId,
        DecisionFieldsZ.extend({
          testId: TestIdZ,
          decision: z.enum(["approve", "reject"]),
          spotChecked: z.array(GroupIdZ).max(200).optional(),
          acknowledgeValidityChanges: z.boolean().optional(),
          note: z.string().max(1000).optional(),
          proposalId: z.string().max(40).optional(),
        }).strict().parse(body),
        await user(),
      ),
    true,
  );
  add(
    "POST",
    "/families/:familyId/exceptions",
    async ({ params, body, user }) => ui.addFamilyException(params.familyId, z.strictObject({ testId: TestIdZ, groupId: GroupIdZ, fields: DecisionFieldsZ.omit({ typicalDetail: true }), reason: z.string().min(1).max(300), proposalId: z.string().max(40).optional() }).parse(body), await user()),
    true,
  );
  add("DELETE", "/families/:familyId/exceptions/:groupId", async ({ params, query, user }) => ui.removeFamilyException(params.familyId, TestIdZ.parse(query.get("testId")), params.groupId, await user()), true);
  add("POST", "/families/:familyId/detach", async ({ params, body, user }) => ui.detachInstance(params.familyId, z.strictObject({ testId: TestIdZ, groupId: GroupIdZ }).parse(body), await user()), true);
  add("POST", "/families/:familyId/confirm-inherited", async ({ params, body, user }) => ui.confirmInherited(params.familyId, z.strictObject({ testId: TestIdZ, groupIds: z.array(GroupIdZ).max(500).optional() }).parse(body), await user()), true);
  // G7 (ws-C): "Confirmar heredadas sin cambio" (list + bulk confirm, human only, typed count, audited per item).
  add("GET", "/tests/:testId/inherited-confirmations", async ({ params }) => ui.inheritedConfirmList(TestIdZ.parse(params.testId)));
  add(
    "POST",
    "/tests/:testId/inherited-confirmations",
    async ({ params, body, user }) =>
      ui.confirmInheritedBulk(
        { testId: TestIdZ.parse(params.testId), ...z.strictObject({ groupIds: z.array(GroupIdZ).min(1).max(500), typedCount: z.number().int().min(1).max(500), acknowledgeStructural: z.boolean().optional(), acknowledgeLifeSafety: z.boolean().optional(), proposalId: z.string().min(1).max(80).optional() }).parse(body) },
        await user(),
      ),
    true,
  );

  // ── Chat panel (domain agent, propose-only, local `claude -p`) ─────────
  // POST /chat/messages → {messageId}; GET /chat/:messageId/events (SSE, replayable); status; history; cancel.
  // ── WS-N: next steps + domain flows (server/next-steps.ts, server/flows/) ──
  const flows = new FlowService(coord, { ...(opts.flowTimeoutMs ? { timeoutMs: opts.flowTimeoutMs } : {}) });
  if (opts.flowPolling !== false) flows.startPolling();
  const steps = (q: { projectId?: string; testKey?: string }) => nextSteps(coord, q, { harness: () => coord.harnessInstaller.status() });
  const chat = new ChatService(coord, { ...(opts.chatTimeoutMs ? { timeoutMs: opts.chatTimeoutMs } : {}), flows, nextSteps: (q) => nextSteps(coord, q) });
  const FlowRunIdZ = z.string().regex(/^FR-\d{8}-[0-9a-f]{6}$/);
  add("GET", "/next-steps", async ({ query }) =>
    steps({ ...(query.get("projectId") ? { projectId: QueryId.parse(query.get("projectId")) } : {}), ...(query.get("testKey") ? { testKey: TestIdZ.parse(query.get("testKey")) } : {}) }),
  );
  add("GET", "/flows/runs", async ({ query }) => flows.overview(query.get("projectId") ? QueryId.parse(query.get("projectId")) : undefined));
  add("GET", "/flows/runs/:id", async ({ params }) => flows.get(FlowRunIdZ.parse(params.id)));
  add(
    "POST",
    "/flows/:flowId/run",
    async ({ params, body, user }) =>
      flows.start(
        z.enum(["preparar-ciclo", "triage", "acta", "redactar-issues", "informe-semanal", "auditar-modelo", "curar-reglas"]).parse(params.flowId),
        z.strictObject({ projectId: QueryId, testKey: TestIdZ.optional(), reason: z.string().max(300).optional() }).parse(body ?? {}),
        await user(),
      ),
    true,
  );
  add("POST", "/flows/runs/:id/cancel", async ({ params, user }) => {
    const u = await user();
    return flows.cancel(FlowRunIdZ.parse(params.id), { type: "user", id: u.id, name: "Coordinador" });
  }, true);
  // SSE (EventSource cannot send the CSRF header): same-origin checks; replayable with Last-Event-ID.
  add("GET", "/flows/runs/:id/events", async ({ req, res, params }) => {
    const id = FlowRunIdZ.parse(params.id);
    await flows.get(id); // 404 stays a JSON error
    const after = Number(req.headers["last-event-id"] ?? -1);
    let n = -1;
    let open = true;
    const write = (chunk: string) => {
      if (open && !res.writableEnded) res.write(chunk);
    };
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(": ok\n\n");
    const ping = setInterval(() => write(": ping\n\n"), 15_000);
    ping.unref?.();
    const off = await flows.subscribe(id, (e, last) => {
      n++;
      if (n > after) write(`id: ${n}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      if (last) {
        open = false;
        clearInterval(ping);
        if (!res.writableEnded) res.end();
      }
    });
    req.on("close", () => {
      open = false;
      clearInterval(ping);
      off();
    });
    return undefined;
  });
  const ChatContextZ = z.strictObject({
    lens: z.string().max(40).optional(),
    focus: z
      .strictObject({ familyId: z.string().max(40).optional(), groupIds: z.array(z.string().max(40)).max(50).optional(), clashIds: z.array(z.string().max(40)).max(200).optional() })
      .optional(),
    selection: z.array(z.strictObject({ documentId: z.number().int().min(0), dbId: z.number().int().min(0) })).max(200).optional(),
  });
  const MessageIdZ = z.string().regex(/^M-[0-9a-f-]{12}$/);
  add("GET", "/chat/status", async ({ user }) => chat.status(await user()));
  add("GET", "/chat/history", async ({ query, user }) => chat.history(TestIdZ.parse(query.get("testKey") ?? query.get("testId")), await user()));
  add(
    "POST",
    "/chat/messages",
    async ({ body, user }) =>
      chat.send(z.strictObject({ testKey: TestIdZ, message: z.string().min(1).max(4000), context: ChatContextZ.optional(), newSession: z.boolean().optional() }).parse(body), await user()),
    true,
  );
  add("POST", "/chat/:messageId/cancel", async ({ params, user }) => chat.cancel(MessageIdZ.parse(params.messageId), await user()), true);
  // SSE (EventSource cannot send the CSRF header): same-origin checks + the message belongs to the user.
  add("GET", "/chat/:messageId/events", async ({ req, res, params, user }) => {
    const id = MessageIdZ.parse(params.messageId);
    const u = await user();
    const after = Number(req.headers["last-event-id"] ?? -1);
    let n = -1;
    let open = true;
    const write = (chunk: string) => {
      if (open && !res.writableEnded) res.write(chunk);
    };
    const listener = (e: import("./contract").ChatEvent, last: boolean) => {
      n++;
      if (!res.headersSent) return;
      if (n > after) write(`id: ${n}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      if (last) {
        open = false;
        clearInterval(ping);
        if (!res.writableEnded) res.end();
      }
    };
    // Validate ownership before writing headers (a 404 stays a JSON error).
    const unsubscribe = chat.subscribe(id, u, () => undefined);
    unsubscribe();
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(": ok\n\n");
    const ping = setInterval(() => write(": ping\n\n"), 15_000);
    ping.unref?.();
    const off = chat.subscribe(id, u, listener);
    req.on("close", () => {
      open = false;
      clearInterval(ping);
      off();
    });
    return undefined;
  });

  // ── M4 the meeting ────────────────────────────────────────────────────────
  add("GET", "/tests/:testId/agenda", async ({ params, query }) => coord.agendaFor(params.testId, query.get("cap") ? z.coerce.number().int().min(1).max(200).parse(query.get("cap")) : undefined));
  add("GET", "/tests/:testId/notes", async ({ params }) => coord.notesFor((await coord.loadTest(params.testId)).test));
  add(
    "PUT",
    "/tests/:testId/notes/:targetType/:targetId",
    async ({ params, body, user }) => {
      const targetType = z.enum(["family", "group"]).parse(params.targetType);
      const { text } = z.strictObject({ text: z.string().max(2000) }).parse(body);
      return coord.putMeetingNote(params.testId, targetType, params.targetId, text, await user());
    },
    true,
  );
  add("GET", "/tests/:testId/families/:familyId/view", async ({ params }) => coord.getFamilyView(params.testId, params.familyId));
  add("PUT", "/tests/:testId/families/:familyId/view", async ({ params, body, user }) => coord.saveFamilyView(params.testId, params.familyId, z.strictObject({ camera: z.unknown() }).parse(body).camera, await user()), true);

  // ── M3 issue checks (read-only against ACC) ─────────────────────────────
  add("GET", "/tests/:testId/issue-checks", async ({ params }) => ui.issueChecks(params.testId));
  add("GET", "/tests/:testId/reminders", async ({ params }) => ui.reminders(params.testId));
  add(
    "POST",
    "/tests/:testId/issue-checks/:issueId/decision",
    async ({ params, body, user }) =>
      ui.decideIssueVerdict(
        params.testId,
        params.issueId,
        z.strictObject({ decision: z.enum(["accept", "reject"]), reasonCode: z.enum(REASON_CODES).optional(), note: z.string().max(1000).optional() }).parse(body),
        await user(),
      ),
    true,
  );
  const QueryId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/).refine((s) => !s.includes(".."), "id inválido");
  add("GET", "/issue-checks/gate", async ({ query }) => ui.issueGate(QueryId.parse(query.get("projectId")), QueryId.parse(query.get("modelSetId"))));

  // ── X3 coordinator questions ───────────────────────────────────────────
  add("GET", "/tests/:testId/questions", async ({ params }) => ui.questionsOf(params.testId));
  add(
    "POST",
    "/questions/:questionId/answer",
    async ({ params, body, user }) =>
      ui.answerQuestion(
        params.questionId,
        z.strictObject({
          optionIndex: z.number().int().min(0).max(4).optional(),
          answer: z.string().max(1000).optional(),
          reasonCode: z.enum(REASON_CODES).optional(),
          confirmCount: z.number().int().min(0).max(50).optional(),
        }).parse(body),
        await user(),
      ),
    true,
  );

  // ── disciplines (writes are human-only, audited) ───────────────────────
  const RuleIn = z.object({
    id: z.string().max(20).optional(),
    match: z.enum(["contains", "startsWith", "regex"]),
    value: z.string().min(1).max(200),
    field: z.enum(["fileName", "folder", "viewName"]),
    discipline: z.string().min(2).max(6),
  });
  add("GET", "/projects/:projectId/disciplines", async ({ params }) => ui.disciplineConfig(params.projectId));
  add(
    "PUT",
    "/projects/:projectId/model-sets/:modelSetId/documents/:lineageKey/discipline",
    async ({ params, query, body, user }) => {
      const b = z.strictObject({ discipline: z.string().min(2).max(6), createRule: RuleIn.omit({ id: true, discipline: true }).optional() }).parse(body);
      let lineageUrn: string;
      try {
        lineageUrn = Buffer.from(params.lineageKey, "base64url").toString("utf8");
      } catch {
        throw new CoordError("validation_error", "lineageUrn mal codificado (base64url)");
      }
      if (!/^urn:[A-Za-z0-9:._-]+$/.test(lineageUrn)) throw new CoordError("validation_error", "lineageUrn inválido");
      return ui.setDocumentDiscipline(params.projectId, params.modelSetId, lineageUrn, b, await user(), query.get("test") ?? undefined);
    },
    true,
  );
  add("PUT", "/projects/:projectId/disciplines/rules", async ({ params, body, user }) => ui.replaceDisciplineRules(params.projectId, z.object({ rules: z.array(RuleIn).max(200) }).parse(body).rules, await user()), true);
  add("POST", "/projects/:projectId/disciplines/preview", async ({ params, body }) => ui.previewDisciplineRules(params.projectId, z.object({ rules: z.array(RuleIn).max(200) }).parse(body).rules), true);
  add(
    "POST",
    "/projects/:projectId/disciplines/proposals/:proposalId/decision",
    async ({ params, body, user }) => ui.decideDisciplineProposal(params.projectId, params.proposalId, z.object({ decision: z.enum(["accept", "reject"]) }).parse(body).decision, await user()),
    true,
  );

  // ── G4/G5: project ACC issue settings (GET-only toward ACC; writes are local, human-only, audited) ──
  add("GET", "/projects/:projectId/issue-types", async ({ params }) => ui.issueTypes(params.projectId));
  add("GET", "/projects/:projectId/issue-settings", async ({ params }) => ui.issueSettings(params.projectId));
  add(
    "PUT",
    "/projects/:projectId/issue-settings/issue-type",
    async ({ params, body, user }) => {
      const b = z.union([z.strictObject({ clear: z.literal(true) }), z.strictObject({ typeId: z.string().max(60), subtypeId: z.string().max(60), label: z.string().max(120).default("") })]).parse(body);
      return ui.setIssueType(params.projectId, b, await user());
    },
    true,
  );
  add(
    "PUT",
    "/projects/:projectId/issue-settings/assignees/:discipline",
    async ({ params, body, user }) => {
      const b = z.strictObject({ assignee: z.strictObject({ id: z.string().min(1).max(80), type: z.enum(["user", "role", "company"]), label: z.string().max(120).default("") }).nullable() }).parse(body);
      return ui.setIssueAssignee(params.projectId, params.discipline, b.assignee, await user());
    },
    true,
  );
  add(
    "POST",
    "/projects/:projectId/issue-settings/proposals/:proposalId/decision",
    async ({ params, body, user }) => ui.decideIssueSettingsProposal(params.projectId, params.proposalId, z.object({ decision: z.enum(["accept", "reject"]) }).parse(body).decision, await user()),
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
        priority: enumCsv(["1", "2", "3", "4"], query.get("priority"))?.map(Number) as (1 | 2 | 3 | 4)[] | undefined,
        validity: enumCsv(["real", "false_positive", "tolerated", "needs_info"], query.get("validity")),
        level: csv(query.get("level"))?.map((l) => z.string().max(60).parse(l)),
        accStatus: enumCsv(["active", "reviewed", "resolved", "closed"], query.get("accStatus")),
        delta: enumCsv(["new", "persisting", "reappeared", "modified", "resolved"], query.get("delta")),
      },
      sort: z.enum(["priority", "confidence_asc", "count_desc", "distance", "level"]).optional().parse(query.get("sort") ?? undefined),
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
  add("GET", "/batches", async ({ query }) => ui.listBatches({ state: enumCsv(["draft", "ready", "approved", "applied", "partial", "discarded"], query.get("state")), projectId: query.get("projectId") ?? undefined }));
  add("GET", "/batches/:batchId", async ({ params }) => ui.getBatch(params.batchId));
  add("POST", "/batches/:batchId/preflight", async ({ params, user }) => ui.preflight(params.batchId, await user()), true);
  add("PATCH", "/batches/:batchId/items", async ({ params, body }) => {
    const b = z.object({ itemIds: z.array(z.string().max(40)).min(1).max(5000), excluded: z.boolean() }).parse(body);
    return ui.setItemsExcluded(params.batchId, b.itemIds, b.excluded);
  }, true);
  add("PATCH", "/batches/:batchId/items/:itemId/issue", async ({ params, body }) => ui.updateIssue(params.batchId, params.itemId, IssuePatch.parse(body ?? {}) as never), true);
  add("POST", "/batches/:batchId/return", async ({ params, user }) => ui.returnToReview(params.batchId, await user()), true);
  add("POST", "/batches/:batchId/discard", async ({ params, user }) => ui.discard(params.batchId, await user()), true);
  // G3 "Llevar decisiones a vN": human only (no MCP tool); the new batch still needs a fresh approval.
  add("POST", "/batches/:batchId/rebase", async ({ params, user }) => ui.rebaseBatch(params.batchId, await user()), true);
  add(
    "POST",
    "/batches/:batchId/approve",
    async ({ req, params, body, user }) => {
      const b = ApproveSchema.parse(body);
      // The WebAuthn origin is the request origin, never a client claim.
      if (b.webauthn) b.webauthn.origin = String(req.headers.origin ?? "");
      if (b.demo && coord.source.kind !== "fixtures") throw new CoordError("forbidden", "La aprobación de demostración solo existe en modo fixtures.");
      return ui.approve(params.batchId, b as never, await user());
    },
    true,
  );
  add("GET", "/webauthn/approve-options", async ({ query }) => {
    const batch = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/).parse(query.get("batch") ?? "");
    return ui.approveOptions(batch, csv(query.get("exclude")) ?? []);
  }, true);
  add("GET", "/webauthn/register-options", async ({ user }) => ui.webauthnRegisterOptions(await user()), true);
  add(
    "POST",
    "/webauthn/register",
    async ({ req, body, user }) => {
      const b = RegisterSchema.parse(body);
      return ui.webauthnRegister({ ...b, origin: String(req.headers.origin ?? "") }, await user());
    },
    true,
  );
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
  // Reglas: human rule changes (calibrate · edit · retire · restore) → the same suggestion the agent
  // creates. New rules come from the agent (propose_rule_change); a human never publishes here.
  const RuleIdZ = z.string().regex(/^[A-Z]{2,4}-\d{3}$/);
  const RuleChangeZ = z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("calibrate"),
      ruleId: RuleIdZ,
      then: z
        .strictObject({
          validity: z.enum(["real", "false_positive", "tolerated", "needs_info"]),
          responsibleDiscipline: z.string().regex(/^(\$a|\$b|@mover|@other|[A-Z]{2,6})$/),
          secondaryDiscipline: z.string().regex(/^(\$a|\$b|@mover|@other|[A-Z]{2,6})$/).nullable(),
          severity: z.enum(["critical", "high", "medium", "low", "none"]),
          suggestedAction: z.enum(["close_not_issue", "mark_reviewed", "create_issue", "hygiene_issue", "request_info", "escalate"]),
          humanReview: z.boolean(),
          confidence: z.number().min(0).max(1),
        })
        .partial()
        .optional(),
      thresholds: z.array(z.strictObject({ path: z.string().max(80), value: z.number().finite() })).max(20).optional(),
      nameEs: z.string().min(1).max(120).optional(),
    }),
    z.strictObject({ kind: z.literal("edit"), ruleId: RuleIdZ, rule: z.union([z.string().max(6000), z.record(z.string(), z.unknown())]) }),
    z.strictObject({ kind: z.literal("retire"), ruleIds: z.array(RuleIdZ).min(1).max(200), reason: z.string().max(300).optional() }),
    z.strictObject({ kind: z.literal("restore"), ruleIds: z.array(RuleIdZ).min(1).max(200) }),
  ]);
  const TestKeyZ = z.string().max(300).optional();
  add("GET", "/rules/overview", async ({ query }) => ui.rulesOverview(query.get("testKey") ?? undefined));
  add(
    "POST",
    "/rule-suggestions/preview",
    async ({ body }) => {
      const b = z.strictObject({ change: RuleChangeZ, testKey: TestKeyZ }).parse(body);
      return ui.previewRuleChange(b.change as never, b.testKey);
    },
    true,
  );
  add(
    "POST",
    "/rule-suggestions",
    async ({ body, user }) => {
      const b = z.strictObject({ change: RuleChangeZ, rationale: z.string().min(1).max(1500), title: z.string().max(120).optional(), testKey: TestKeyZ }).parse(body);
      return ui.createRuleSuggestion(b as never, await user());
    },
    true,
  );
  add("GET", "/rules/:ruleId", async ({ params }) => ui.rule(params.ruleId));
  add("GET", "/rule-suggestions", async () => ui.ruleSuggestions());
  add(
    "POST",
    "/rule-suggestions/:id/decision",
    async ({ params, body, user }) => ui.decideRuleSuggestion(params.id, z.object({ decision: z.enum(["approve", "reject"]) }).parse(body).decision, await user()),
    true,
  );
  // G15 Publicar / Revertir (human-only, CSRF; passkey over the exact files written; demo only in fixtures).
  const RuleSuggestionIdZ = z.string().regex(/^P-\d{8}-\d{4}$/);
  const RulePublishSchema = z.strictObject({
    webauthn: z.strictObject({ nonce: z.string().regex(/^[0-9a-f]{32}$/), origin: z.string().max(100), response: AssertionSchema }).optional(),
    demo: z.boolean().optional(),
  });
  add("GET", "/rule-suggestions/:id/publish-options", async ({ params, query }) => ui.rulePublishOptions(RuleSuggestionIdZ.parse(params.id), z.enum(["publish", "revert"]).parse(query.get("op") ?? "publish")), true);
  for (const op of ["publish", "revert"] as const) {
    add(
      "POST",
      `/rule-suggestions/:id/${op}`,
      async ({ req, params, body, user }) => {
        const b = RulePublishSchema.parse(body ?? {});
        // The WebAuthn origin is the request origin, never a client claim.
        if (b.webauthn) b.webauthn.origin = String(req.headers.origin ?? "");
        if (b.demo && coord.source.kind !== "fixtures") throw new CoordError("forbidden", "La publicación de demostración solo existe en modo fixtures.");
        const id = RuleSuggestionIdZ.parse(params.id);
        return op === "publish" ? ui.publishRuleSuggestion(id, b, await user()) : ui.revertRuleSuggestion(id, b, await user());
      },
      true,
    );
  }
  // ── agent harness update (human-only; server/harness-install.ts; NO MCP / chat tool) ──
  add("GET", "/harness/status", async () => coord.harnessInstaller.status());
  const HarnessPathZ = z.string().min(1).max(300).regex(/^(CLAUDE\.md|\.claude\/[A-Za-z0-9._\-/]+)$/);
  add("GET", "/harness/diff", async ({ query }) => coord.harnessInstaller.diff(HarnessPathZ.parse(query.get("path") ?? "")), true);
  add("GET", "/harness/install-options", async () => coord.harnessInstaller.options(), true);
  const HarnessInstallSchema = z.strictObject({
    webauthn: z.strictObject({ nonce: z.string().regex(/^[0-9a-f]{32}$/), origin: z.string().max(100), response: AssertionSchema }).optional(),
  });
  add(
    "POST",
    "/harness/install",
    async ({ req, body, user }) => {
      // Browser-only: fetch metadata must be present and same-origin (curl/agents do not send it by default).
      if (req.headers["sec-fetch-site"] !== "same-origin") throw new CoordError("forbidden", "La actualización del agente solo se instala desde la UI web (navegador).");
      const b = HarnessInstallSchema.parse(body ?? {});
      // The WebAuthn origin is the request origin, never a client claim.
      if (b.webauthn) b.webauthn.origin = String(req.headers.origin ?? "");
      return coord.harnessInstaller.install(b, await user());
    },
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
  // ── human-side parity reads (server/parity.ts; docs/ai/agent-human-parity.md) ──
  add("GET", "/tests/:testId/hygiene", async ({ params }) => testHygiene(coord, params.testId));
  add("GET", "/reports/files", async ({ query }) => listReportFiles(coord, QueryId.parse(query.get("projectId"))));
  add("GET", "/reports/files/:name", async ({ params, query }) => readReportFile(coord, QueryId.parse(query.get("projectId")), params.name));
  add("GET", "/learning/feedback", async ({ query }) =>
    listFeedbackRows(coord, { projectId: query.get("projectId") ?? undefined, source: enumCsv(["ui", "agent", "decision"], query.get("source")), limit: num(query.get("limit")), cursor: query.get("cursor") ?? undefined }),
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
        // 1. Exact Host allowlist FIRST (anti DNS rebinding). X-Forwarded-* ignored.
        if (!hostAllowed(req)) throw new CoordError("forbidden", "Host no permitido.");
        // 2. Mutations: exact Origin. Human-only GETs: fetch metadata same-origin.
        if (method !== "GET" && !originMatches(req)) throw new CoordError("forbidden", "Solicitud de otro origen rechazada.");
        if (!fetchSiteOk(req)) throw new CoordError("forbidden", "Sec-Fetch-Site distinto de same-origin.");
        if (route.human) {
          const header = String(req.headers["x-coord-csrf"] ?? "");
          const ck = cookie(req, "coord_csrf") ?? "";
          if (!header || !safeEq(header, csrfToken) || !safeEq(ck, csrfToken)) throw new CoordError("forbidden", "Token CSRF ausente o inválido (GET /api/coord/csrf).");
        }
        const m = route.re.exec(url.pathname)!;
        const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
        const body = method === "GET" ? undefined : await readBody(req);
        const result = await route.handler({ req, res, params, query: url.searchParams, body, user: userOf });
        // Streaming handlers (SSE) write the response themselves.
        if (!res.headersSent) send(res, 200, result ?? { ok: true }, {}, req);
      } catch (err) {
        const { status, body } = errorBody(err);
        if (status >= 500) log.warn("api.error", { path: url.pathname, message: (err as Error).message });
        if (res.headersSent) {
          if (!res.writableEnded) res.end();
        } else send(res, status, body);
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
