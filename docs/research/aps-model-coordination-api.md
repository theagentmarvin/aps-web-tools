# APS Model Coordination API — ground truth for the coordinator agent

Owner: researcher. Status: verified against official Autodesk docs on 2026-11-06 unless marked **UNVERIFIED**.
Audience: coders building `server/aps/*` and `core/ingest/*`. Read with `docs/PLAN.md`.

## 0. Sources and how to re-verify

Autodesk's doc site (`aps.autodesk.com/en/docs/...`) is rendered by JavaScript, so WebFetch/curl return an empty shell. The raw page HTML can be fetched directly:

- Table of contents (JSON): `https://developer.doc.config.autodesk.com/bPlouYTd/acc_v1.json` (also `bim360_v1.json`, `oauth_v2.json`). Each node has a `source` path.
- Page HTML: `https://developer.doc.autodesk.com/bPlouYTd/<source>`, for example `.../acs-acs-api-documentation-main-23568/acc/v1/tutorials/mc-tutorial-clash.html`. The `main-23568` build number changes, so read it from the TOC.

Short citation keys used below (public URLs):

| Key | URL |
|---|---|
| R:x | `https://aps.autodesk.com/en/docs/acc/v1/reference/http/x/` (for example R:mc-clash-service-v3-get-clash-test-resources-GET) |
| T:clash | https://aps.autodesk.com/en/docs/acc/v1/tutorials/model-coordination/mc-tutorial-clash/ |
| T:modelset | https://aps.autodesk.com/en/docs/acc/v1/tutorials/model-coordination/mc-tutorial-model-set/ |
| FG:clash | https://aps.autodesk.com/en/docs/acc/v1/overview/field-guide/model-coordination/mcfg-clash/ |
| FG:modelset | https://aps.autodesk.com/en/docs/acc/v1/overview/field-guide/model-coordination/mcfg-model-set/ |
| FG:mp | https://aps.autodesk.com/en/docs/acc/v1/overview/field-guide/model-properties/ |
| T:mpquery | https://aps.autodesk.com/en/docs/acc/v1/tutorials/model-properties/query/ |
| T:mpref | https://aps.autodesk.com/en/docs/acc/v1/tutorials/model-properties/query-ref/ |
| RL:mc | https://aps.autodesk.com/en/docs/acc/v1/overview/rate-limits/model-coordination-rate-limits/ |
| RL:issues | https://aps.autodesk.com/en/docs/acc/v1/overview/rate-limits/issues-rate-limits/ |
| RL:aps | https://aps.autodesk.com/en/docs/acc/v1/overview/rate-limits/forge-rate-limits/ |
| FG:issues | https://aps.autodesk.com/en/docs/acc/v1/overview/field-guide/issues/ |
| O:native | https://aps.autodesk.com/en/docs/oauth/v2/developers_guide/App-types/native/ |
| O:pkce | https://aps.autodesk.com/en/docs/oauth/v2/tutorials/get-3-legged-token-pkce/ |
| O:pkce-private | https://aps.autodesk.com/en/docs/oauth/v2/tutorials/get-3-legged-token-pkce/get-3-legged-token-pkce-private/ |
| O:authorize | https://aps.autodesk.com/en/docs/oauth/v2/reference/http/authorize-GET/ |
| O:token | https://aps.autodesk.com/en/docs/oauth/v2/reference/http/gettoken-POST/ |
| O:fg | https://aps.autodesk.com/en/docs/oauth/v2/developers_guide/field-guide/ |
| O:scopes | https://aps.autodesk.com/en/docs/oauth/v2/developers_guide/scopes/ |
| S:clashview | https://github.com/autodesk-platform-services/aps-clash-data-view (official sample; `server/analyze.js`, `www/js/ForgeViewer.js`) |
| S:pbi | https://github.com/Autodesk-Forge/forge-bim360-clash-powerbi (official sample; `WebSample/server/analyze.js`, `config.js`): joins clash data to the Model Properties index |
| S:mpps | https://github.com/autodesk-platform-services/aps-model-properties.powershell (official query examples) |
| H:faq | https://help.autodesk.com/cloudhelp/ENU/Coord-Clashes/files/Model_Coord_Clash_FAQs.html |
| H:v2 | https://help.autodesk.com/cloudhelp/ENU/BIM360D-Model-Coordination/files/Coordinate-Models/MODEL_COORDINATION_COORD_SPACE_VERSIONS.html |
| H:ci | https://help.autodesk.com/cloudhelp/ENU/Docs-Admin/files/account-administration/Custom_Integrations.html |

Note: the current docs call ACC "Forma" ("Forma Data Management", "Forma Issues"). The APIs and URLs are unchanged.

---

## 1. Auth

### 1.1 Which APIs accept which token type

| API | Auth context (as documented) | 2-legged? | Scopes |
|---|---|---|---|
| Model Set v3 reads | "user context required" | **No** | `data:read` |
| Clash v3 reads (tests, resources, grouped/assigned/closed GETs, POST `clashes/assigned`, POST `clashes/closed` (read), `viewcontext`) | "user context required" | **No** | `data:read` |
| Clash v3 `clashes:assign`, `clashes:close` | user context required | **No** | `data:create data:write` |
| Clash v3 `clashes:reopen` | user context required | **No** | `data:write` |
| Model Properties (Index v2), all endpoints including POST batch-status/queries | user context required | **No** | `data:read` |
| ACC Issues v1 GET | User context required | **No** (SSA allowed, see below) | `data:read` |
| ACC Issues v1 POST issue | User context required | **No** | `data:write` |
| ACC Issues v1 PATCH issue | User context required | **No** | `data:read data:write` |

Sources: the "Resource Information" block of every R: page (for example R:mc-clash-service-v3-add-assigned-clash-group-batch-POST, R:index-v2-index-jobs-batch-status-post, R:issues-issues-POST). The MC tutorial asks for `data:read data:write data:create` (T:clash).

- **Request scope set:** `data:read data:write data:create`. Scopes are space-delimited in `scope=` (O:pkce). A refresh can request the same scopes or a subset (O:token).
- Issues docs also accept a **Secure Service Account (SSA)** token: "designed for headless server-to-server operations… classified as three-legged because it preserves user context" (R:issues-issues-POST). This is an option for a future L3 autonomy mode. **UNVERIFIED** whether MC and Index accept SSA tokens; their docs only say "three-legged OAuth flow".
- Every call runs with the permissions of the logged-in user. Model set permissions come from Docs folder permissions: View → Model Set Read; View+Upload+Edit+Control → Model Set Edit (FG:modelset). The Index API needs at least View+Download on the folder (FG:mp).
- ACC requires that the APS app (client ID) be added by an Account Admin under **Account Admin → Custom Integrations** (H:ci). If it is not, every call returns 403.

### 1.2 Endpoints and lifetimes

- Authorize: `GET https://developer.api.autodesk.com/authentication/v2/authorize?response_type=code&client_id=…&redirect_uri=…&scope=…&state=…&code_challenge=…&code_challenge_method=S256` (O:authorize).
- Token: `POST https://developer.api.autodesk.com/authentication/v2/token`, `application/x-www-form-urlencoded`. Use `grant_type=authorization_code` (`code`, `redirect_uri`, `code_verifier`) or `grant_type=refresh_token` (`refresh_token`, optional `scope`) (O:token, O:pkce).
- **Access token:** 60 min (`expires_in: 3599`). **Refresh token:** 15 days. **Auth code:** valid 5 min (O:authorize, O:fg).
- Each refresh returns a new `refresh_token` (O:token example). **UNVERIFIED** whether the old refresh token is invalidated at once. Assume rotation: always persist the newest one atomically, and serialize refreshes behind a mutex so that two processes (MCP server and web API) do not race.
- Errors: 400/401 with OAuth error bodies, such as "The refresh token is invalid or expired." When this happens, re-run the browser login.

### 1.3 Client type and how a local Node CLI or MCP server does 3LO

APS app types (O:native, https://aps.autodesk.com/en/docs/oauth/v2/developers_guide/App-types/):

| App type | Secret | PKCE | Notes |
|---|---|---|---|
| Traditional Web App | yes | supported and recommended (O:pkce-private) | Can use Premium APIs. Multiple callback URLs allowed. |
| Desktop, Mobile, Single-Page App | **no** (public client) | **required** | "unable to use any API that can incur Tokens consumption (Premium APIs), such as Model Derivative…" (O:native). No 2-legged. |

**Recommendation:** register a **Traditional Web App** and use **authorization code + PKCE (S256)**, sending `client_secret` together with `code_verifier` on the token call.

- The secret stays in `.env.local` on the coordinator's machine (PLAN governance), and the app keeps the option to call Model Derivative.
- A public PKCE-only client is a fallback if SalfaCorp does not want shared secrets on laptops. **UNVERIFIED** whether the Index v2 API counts as "Premium".

Loopback flow for `server/aps/auth.ts`:
1. Start `http.createServer` on `127.0.0.1:<fixed port>` (for example 8765), path `/callback`.
2. Generate a `code_verifier` (43–128 chars) with `code_challenge = base64url(sha256(verifier))`, plus a random `state` (O:pkce; code-challenge guide https://aps.autodesk.com/en/docs/oauth/v2/tutorials/code-challenge/).
3. Open the system browser (`open`/`start`) to `/authorize`. The callback receives `?code=&state=`; check `state`, exchange the code, and store tokens in `.coordinator/auth/token.json` (gitignored; implemented in `server/aps/auth.ts`).
4. `redirect_uri` "must match the pattern of the callback URL field of the app's registration" (O:authorize). Register exactly `http://localhost:8765/callback` and use exactly that value. **UNVERIFIED:** whether APS accepts arbitrary loopback ports (RFC 8252 style). Do not rely on it; use a fixed port and make it configurable.
5. Optional `prompt=login` forces account choice (O:pkce).

### 1.4 IDs

- Data Management project id `b.<guid>` → MC `containerId`, Index `projectId` and ACC Issues `projectId` are the **GUID without `b.`**. FG:modelset: "The application uses the BIM 360 Docs Project ID as the container GUID". R:issues-issues-POST: "removing the 'b.' prefix".
- Optional header `x-ads-region: US | EMEA` on MC, Index and Issues. If omitted the request is auto-routed with slight latency. Send it if the hub region is known (DM hub `attributes.region`).

---

## 2. Model Set Service v3

Base: `https://developer.api.autodesk.com/bim360/modelset/v3`. All endpoints "compatible with both BIM 360 and Forma projects". Responses use flat wrappers (`modelSets`, `modelSetVersions`, `modelSetViews`) plus `page.continuationToken`.

| Method | Path | Notes |
|---|---|---|
| GET | `/containers/{containerId}/modelsets` | Query: `pageLimit`, `continuationToken`, `name`, `folderUrn`, `includeDisabled`, `includeDeleted`. **Max 20 items/page.** (R:mc-modelset-service-v3-get-model-sets-GET) |
| GET | `/containers/{c}/modelsets/{modelSetId}` | Single model set |
| GET | `/containers/{c}/modelsets/{m}/versions` | Query: `status[]` (Pending, Processing, Successful, Partial, Failed), `pageLimit`, `continuationToken`. Items `{version:int, createTime, status}`. Max 20/page. |
| GET | `/containers/{c}/modelsets/{m}/versions/latest` | Full version object (below) |
| GET | `/containers/{c}/modelsets/{m}/versions/{version}` | Full version object |
| GET | `/containers/{c}/modelsets/{m}/views` | Query: `pageLimit`, `continuationToken`, `createdBy`, `modifiedBy`, `after`, `before`, `isPrivate`, `sortBy[]`, `sortDirection`. Max 20/page. |
| GET | `/containers/{c}/modelsets/{m}/views/{viewId}` | Single view |
| GET | `/containers/{c}/modelsets/{m}/views/{viewId}/versions[/{v}]` | View versions |
| GET | `/containers/{c}/jobs/{jobId}` and `/containers/{c}/modelsets/{m}/jobs/{jobId}` | Async job status |
| POST | `/containers/{c}/modelsets/{m}/issues` | "add model set issue" (not clash-linked); quota 250/h (RL:mc) |

ModelSet item fields (R:…get-model-sets-GET): `modelSetId, containerId, name, description, createdBy, createdTime, modifiedBy, modifiedTime, isDisabled, isDeleted, includedFolderCount, rootFolder (folder URN), hasContentFilters, clashEngineVersion:int32, isDocumentLimitReached`.

Model set version (R:mc-modelset-service-v3-get-model-set-version-GET):
```jsonc
{ "modelSetId": "uuid", "version": 42, "createTime": "iso", "status": "Pending|Processing|Successful|Partial|Failed",
  "documentVersions": [{
    "stableDocumentId": "urn:adsk.wipprod:dm.lineage:XXX#Level 1",
    "unstableDocumentId": "urn:adsk.wipprod:fs.file:vf.YYY?version=1#Level 1",
    "documentLineage": { "lineageUrn": "urn:adsk.wipprod:dm.lineage:XXX", "parentFolderUrn": "…", "isAligned": false, "tipVersionUrn": "…" },
    "alignment": { "transform": [16 doubles], "checksum": "…", "upAxis": [0,0,1], "distanceUnit": "autodesk.unit.unit:meters-2.0.0|…feet…" },
    "isTipVersion": true, "documentStatus": "Succeeded|Failed|Running|Skipped",
    "forgeType": "versions:autodesk.bim360:Document|versions:autodesk.bim360:File",
    "versionUrn": "urn:adsk.wipprod:fs.file:vf.XXX?version=1", "displayName": "{3D}_Audubon_Structure.rvt",
    "revision": 1, "viewableName": "{3D}", "createUserId": "…", "createTime": "…",
    "viewableGuid": "uuid", "viewableId": "…", "viewableMime": "application/autodesk-svf",
    "bubbleUrn": "urn:adsk.wipprod:fs.file:vf.ZZZ?version=1", "isSvf2Supported": false,
    "originalSeedFileVersionSize": 0, "originalSeedFileVersionUrn": "urn:…vf.ZZZ?version=1",
    "originalSeedFileVersionName": "Audubon_Structure.rvt" }] }
```
- **One seed file (RVT) gives N documentVersions**, one per 3D viewable (`{3D}`, `New Construction`, …). The `versionUrn` can be a per-viewable "Document" URN that differs from `originalSeedFileVersionUrn` (T:modelset example: `versionUrn …vf.9IeFYnYxTB…` vs seed `…vf.NKGUU8CLQ8WP…`). In V2 coordination spaces Revit clashes use the master model view (H:v2).
- Filter on `documentStatus === "Succeeded"`; S:clashview does this.
- **Viewer URN mapping** (S:clashview `buildDocsMap`): derivative URN = `base64url(bubbleUrn)` without padding; select the viewable by `viewableGuid` (or `viewableId`). Clash `scope-version-document.documents[].urn` **equals** `documentVersions[].versionUrn`; S:clashview matches them exactly.
- Views (`modelSetViews[]`): `{viewId, name, description, isPrivate, screenshotId, definition:[{lineageUrn, viewableName}] (1..50), createdBy, createdTime, modifiedBy, modifiedTime, published:{name,time,folderUrn,versionUrn}}`. Views are **saved model subsets for the viewer, not clash tests**. Clash tests cover the whole model set version (see §3).
- Limits: max 1,000 documents per model set version; past that, no new versions are created (`isDocumentLimitReached`) (RL:mc).

---

## 3. Clash Service v3

Base: `https://developer.api.autodesk.com/bim360/clash/v3`. All endpoints are BIM 360 + ACC compatible and need a 3LO token. Error body: `{type,title,detail,errors:[{field,title,detail,type}]}`. Status codes: 400, 401, 403, 404, 413 (request too large), 429 (`Retry-After`), 500.

### 3.1 Tests and resources

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/containers/{c}/modelsets/{m}/tests` | `status` (Pending, Processing, Success, Failed), `pageLimit`, `continuationToken` | `{page:{continuationToken?}, tests:[{id, modelSetId, modelSetVersion:int, status, completedOn}]}` |
| GET | `/containers/{c}/modelsets/{m}/versions/{v}/tests` | same | same |
| GET | `/containers/{c}/tests/{testId}` | – | `{id, completedOn, modelSetId, modelSetVersion, status}` |
| GET | `/containers/{c}/tests/{testId}/resources` | – | `{page, resources:[{type, extension:"json.gz"\|"sqlite", url, headers:{}, validUntil}]}` |

Sources: R:mc-clash-service-v3-get-model-set-clash-tests-GET, R:…-get-model-set-version-clash-tests-GET, R:…-get-clash-test-GET, R:…-get-clash-test-resources-GET, T:clash.

- Only `status === "Success"` tests have results. A test is created automatically for every model set version (FG:clash). The official sample assumes "one model set version with one clash test" (S:clashview). **UNVERIFIED** whether more than one test per version can exist. If it does, pick `Success` with the latest `completedOn`.
- `backendType` (used in legacy code) is **not documented**. Treat it as optional.
- Resource types (T:clash): `scope-version-clash.2.0.0`, `scope-version-clash-instance.2.0.0`, `scope-version-document.2.0.0`. The reference example also shows `scope-version-clash.1.0.0`, so **match on the prefix** and log the version. Ignore `sqlite` resources unless needed.
- **Download:** plain `GET url` with **the returned `headers` object added**. S:clashview passes `{ method:'GET', headers }`. Do **not** send the APS `Authorization` header to this URL. "The individual resource URLs… are time limited; use `validUntil`… If the lease expires… subsequent calls to the resources endpoint yield a new set of URLs" (T:clash). Re-call `/resources` when `now > validUntil - 60s` or on 403.
- **Compression:** "a set of gzip compressed JSON documents" (T:clash). S:clashview pipes the body to `*.json.gz` and then does `JSON.parse(readFileSync)`. That only works if the HTTP layer already decoded `Content-Encoding: gzip`, so **UNVERIFIED** which is the case. Robust approach: read the bytes; if the first bytes are `1f 8b`, gunzip; else parse as-is. Stream with `zlib.createGunzip()` for large files.
- **CORS:** **UNVERIFIED** (not documented). It does not matter, because PLAN puts all fetching in `server/` (Node, no CORS). Never hand presigned URLs to the browser.

### 3.2 Resource file schemas

Field names are documented in T:clash prose and in the `clashData` schema of R:mc-clash-service-v3-get-assigned-clash-group-batch-POST. Envelope fields `scope` and `version` come from legacy observation and are **UNVERIFIED**.

```ts
// scope-version-clash.2.0.0
{ clashes: Array<{ id: number;            // STABLE clash id across model set versions (T:clash)
                   clash: [number, number]; // the two STABLE object ids (= loid, roid)
                   dist: number;            // see units note
                   status: string|number }> } // grouped-data example shows "New"; raw file type UNVERIFIED
// scope-version-clash-instance.2.0.0
{ instances: Array<{ cid: number;  // FK -> clashes[].id
                     ldid: number; rdid: number;   // FK -> documents[].id (left/right document)
                     loid: number; roid: number;   // STABLE object ids (NOT viewer ids)
                     lvid: number; rvid: number }> } // viewer object ids (dbId) in that document version
// scope-version-document.2.0.0
{ documents: Array<{ id: number; urn: string /* == documentVersions[].versionUrn */; viewableName: string }> }
```

Semantics (T:clash, verbatim points):
- `id` is stable across successive model set versions, so it is the key for de-duplication and history.
- `loid`/`roid` are **stable object IDs**, maintained per seed-file lineage.
- `lvid`/`rvid` are "the Viewer object identities associated with these specific versions of the document… not stable between successive seed file versions".
- S:clashview uses `lvid`/`rvid` as `dbId` (`setThemingColor(Lvid, …, Lmodel)`), with the model resolved via `ldid → clashDocId`.
- Red/green left/right colouring is arbitrary. The A∩B matrix in grouping is directional (FG:clash).
- **Units of `dist`: UNVERIFIED.** Legacy says metres with negative meaning penetration. Supporting evidence: the MC tolerance is "fixed … 0.5 mm (0.0005 m)" (H:faq). The doc example shows `dist: 114.1678` (placeholder). Validate against the ACC UI on a real clash before shipping severity rules.
- **Numeric status codes 1–4 ("Active/Reviewed/Resolved/Closed") in legacy: UNVERIFIED.** No source found. The documented grouped data uses string `"New"`. Real MC clash state is derived from groups: assigned (issue), closed (not-an-issue), or neither (open). Compute it from the group endpoints (§3.3) rather than trusting `status`.
- Clash IDs can be large (legacy observed `41299469560661`, about 4e13 < 2^53, so safe as a JS number). Assert `Number.isSafeInteger` on ingest; if this fails, switch to a lossless JSON parser.

### 3.3 Clash groups (assigned = issue, closed = not an issue)

All writes are **POST with a JSON array body** and return **202 + a job**. Legacy used GET with no body and wrong paths (see §8).

| Method | Path | Body | Response | Scope |
|---|---|---|---|---|
| POST | `/containers/{c}/tests/{testId}/clashes:assign` | `AssignedGroupCreate[]` | 202 `ClashGroupJob` | data:create data:write |
| POST | `/containers/{c}/tests/{testId}/clashes:close` | `ClosedGroupCreate[]` | 202 `ClashGroupJob` | data:create data:write |
| POST | `/containers/{c}/modelsets/{m}/clashes:reopen` | `string[]` closed group ids (1..20) | 202 `ClashGroupJob` | data:write |
| GET | `/containers/{c}/clashes/jobs/{jobId}` | – | `ClashGroupJob` | data:read |
| GET | `/containers/{c}/modelsets/{m}/clashes/grouped` | – | `{clashes:number[]}`: every clash id in any assigned or closed group | data:read |
| GET | `/containers/{c}/modelsets/{m}/clashes/assigned` | query `pageLimit, continuationToken, clashTestId, issueId, createdBy, after, before, sort(Asc\|Desc)` | `{page, groups:[{id, clashTestId, issueId, createdBy, createdOn, clashes:number[]}]}` | data:read |
| GET | `/containers/{c}/modelsets/{m}/clashes/closed` | query `… , reason, …` | `{page, groups:[{id, clashTestId, title, description, reason, screenShots, createdBy, createdOn, clashes}]}` | data:read |
| GET | `/containers/{c}/tests/{testId}/clashes/assigned` | `pageLimit, continuationToken` | `{page, modelSetId, modelSetVersion, groups:[{id, originalClashTestId, createdAtVersion, existing:number[], resolved:number[]}]}` | data:read |
| GET | `/containers/{c}/tests/{testId}/clashes/closed` | same | same shape | data:read |
| POST | `/containers/{c}/tests/{testId}/clashes/assigned[?issues=true]` | `string[]` group ids **or** issue ids (1..20) | `[{id, clashTestId, issueId, createdBy, createdOn, clashData:{documents[], clashes[], clashInstances[]}}]` | data:read |
| POST | `/containers/{c}/tests/{testId}/clashes/closed` | `string[]` group ids (1..20) | `[{…closed group…, clashData}]` | data:read |
| POST | `/containers/{c}/clashes/assigned/viewcontext` | `string[]` **issue** ids (1..5) | `[{issueId, modelSetId, clashGroup:{…}, documents:[{lineageUrn, viewableName}]}]` | data:read |
| POST | `/containers/{c}/modelsets/{m}/screenshots` | raw PNG, `Content-Type: image/png` | screenshot `{id, …, size}` | – |
| GET | `/containers/{c}/modelsets/{m}/screenshots/{id}` | – | PNG | – |

Sources: R:mc-clash-service-v3-add-assigned-clash-group-batch-POST, …-add-closed-clash-group-batch-POST, …-reopen-closed-clash-group-batch-POST, …-get-clash-group-job-GET, …-get-grouped-clashes-GET, …-search-container-issue-clash-groups-GET, …-search-container-model-set-closed-clash-groups-GET, …-get-clash-test-assigned-clash-group-intersection-GET, …-get-clash-test-closed-clash-group-intersection-GET, …-get-assigned-clash-group-batch-POST, …-get-closed-clash-group-data-batch-POST, …-get-assigned-clash-group-view-context-POST, …-add-screen-shot-POST.

```ts
interface ClosedGroupCreate {           // body is ClosedGroupCreate[]
  id?: string;                          // uuid, optional client-chosen id
  title: string;                        // required, max 128
  description?: string;                 // max 1024
  reason: 'OTHER'|'VALID_INTERFACE'|'VALID_PENETRATION'|'MINIMAL_OVERLAP'|'ITEM_CAN_FLEX'|'MODEL_INACCURACY'|'FIELD_FIX'; // required
  screenShots?: string[];               // uuid, max 5
  clashes: number[];                    // required, 1..1000 stable clash ids
}
interface AssignedGroupCreate {         // body is AssignedGroupCreate[]; creates an ISSUE per group
  id?: string;
  title: string;                        // required, 1..4200 (but ACC issue title max 100, see §5; keep <=100)
  description?: string;                 // max 10000 (ACC issue description max 1000; keep <=1000)
  assignedTo?: string;                  // Autodesk user id / role id / company id
  assignedToType?: 'User'|'Role'|'Company';   // NOTE capitalised here; Issues API uses lowercase
  dueDate?: string;                     // ISO 8601
  locationId?: string; locationDescription?: string;
  owner?: string;
  status?: 'Open'|'Draft';
  pushpin: {                            // required
    location: { x: number; y: number; z: number };   // doc says int; example uses floats -> send numbers
    objectId: number;                   // viewer object id to link (use lvid/rvid of the doc below)
    externalId?: string;                // e.g. Revit UniqueId (index row externalId)
    attributesVersion?: number;
    type?: 'TwoDVectorPushpin';
    viewerState?: object;
  };
  clashes: number[];                    // required, 1..1000
  issueTypeId: string;                  // required uuid
  issueSubTypeId: string;               // required uuid (capital T here; Issues API spells issueSubtypeId)
  rootCauseId?: string;
  customAttributes?: { id: string; value: string }[];  // max 64
  screenShots?: string[];               // max 5
  documentVersionUrn: string;           // required, 1..80 chars: the document the issue/pushpin is placed on
  viewableName?: string;                // 1..430
  viewContext?: { urn: string; viewableName: string }[]; // 1..50 docs visible when viewing the issue
}
interface ClashGroupJob { jobId: string; groups: string[]; createdIssueIds?: string[];
  status: 'Failed'|'Running'|'Succeeded'|'Archived'; job?: { operation?: string; seed?: object } }
```
Official example body for `clashes:assign` (verbatim, trimmed): `[{"title":"Ceiling 2' x 2' grid and 411 other objects.","description":"Objects expected in ceiling.","assignedTo":"PD23PXGV8V3V","assignedToType":"User","pushpin":{"location":{"x":426.77023,"y":176.68831,"z":682.2887},"objectId":22,"type":"TwoDVectorPushpin","viewerState":{}},"clashes":[2019963136],"issueTypeId":"9f2b…","issueSubTypeId":"7bc1…","customAttributes":[{"id":"74b7…","value":"Coordination"}],"screenShots":["d98c…"],"documentVersionUrn":"urn:adsk.wipprod:vf.file:vf.jvMF7mrHR7OwG_DToKsJUA?version=1","viewableName":"Level 1","viewContext":[{"urn":"urn:adsk.wipprod:fs.file:vf.jvMF7mrHR7OwG_DToKsJUA?version=1","viewableName":"Level 1"}]}]`.

Behaviour:
- "Clash groups that need resolving via a design change are stored as assigned clash groups. In addition, a BIM 360 issue is created and associated with the assigned clash group." For ACC projects this creates a Forma/ACC issue. The issue id comes back in `createdIssueIds` on the job once it is `Succeeded`.
- Closed groups "are not presented should they occur in subsequent clash tests."
- Reopen "essentially deletes the specified closed clash groups… cannot be undone."
- Apply flow: POST, then poll `GET clashes/jobs/{jobId}` until `Succeeded` or `Failed`, then record `groups[]` and `createdIssueIds[]` in the audit log.
- **Pushpin coordinates: UNVERIFIED frame.** Use the clash location in viewer (aligned) coordinates. The index `bboxMin/bboxMax` centre (§4) is in model units and may not match the aligned model set frame (`alignment.transform`, `distanceUnit`). Validate on a real project; fall back to the centre of the left element's bbox transformed by `alignment.transform`.
- **Triage state per clash** for the current test: `assigned` if in an assigned group's `existing`; `closed` if in a closed group's `existing`; else `open`. Clashes in a group's `resolved` list are gone from the model. `GET modelsets/{m}/clashes/grouped` is the cheap "already handled" set.

---

## 4. Model Properties API (Index v2): element metadata without a viewer

Base: `https://developer.api.autodesk.com/construction/index/v2`. Works for ACC and BIM 360 Docs files. 3LO only, `data:read`. Needs View+Download on the folder; permission changes take minutes to propagate (FG:mp).

| Method | Path | Notes |
|---|---|---|
| POST | `/projects/{projectId}/indexes:batch-status` | Body `{versions:[{versionUrn, query?, columns?}]}` (1..1000). Lazy: starts missing index jobs. Idempotent: same input gives the same `indexId`. Optional header `x-ads-force-regenerate-cache: true`. |
| GET | `/projects/{p}/indexes/{indexId}` | Status `{projectId, indexId, type:"INDEX", state:"PROCESSING"\|"FINISHED"\|"FAILED", selfUrl, versionUrns[], updatedAt, retryAt, stats:{objects}, manifestUrl, fieldsUrl, propertiesUrl, errors?}` |
| GET | `/projects/{p}/indexes/{i}/manifest` | JSON manifest |
| GET | `/projects/{p}/indexes/{i}/fields` | NDJSON (gzip) |
| GET | `/projects/{p}/indexes/{i}/properties` | NDJSON (gzip). May answer **303** redirect (immutable, long cache headers). |
| POST | `/projects/{p}/indexes/{i}/queries` | Body `{query, columns?}` gives a status with `queryId` (+ `queryResultsUrl` when finished) |
| GET | `/projects/{p}/indexes/{i}/queries/{queryId}` | Poll |
| GET | `/projects/{p}/indexes/{i}/queries/{q}/properties` | NDJSON (gzip) result rows |
| (diff) | `/projects/{p}/diffs:batch-status`, `/diffs/{id}/…` | Same pattern with `prevVersionUrn` pairs. Rows add `type: OBJECT_ADDED\|OBJECT_CHANGED\|OBJECT_REMOVED`, `changeType`, `prev`. |

Sources: R:index-v2-index-jobs-batch-status-post, R:index-v2-index-status-get, R:index-v2-index-query-post, R:index-v2-index-query-job-status-get, R:index-v2-index-properties-get, T:mpquery, FG:mp; S:pbi `config.js` uses exactly `…/indexes:batch-status`.

Gotchas:
- The reference example URL says `indexes:batchStatus`, but the path header and tutorial say `indexes:batch-status`. **Use `batch-status`**: S:pbi uses it. Accept a `502/404` here as a configuration bug.
- The tutorial shows the batch-status response as a **bare array**; the reference shows `{indexes:[…]}`. Handle both.
- Poll using `retryAt`. The tutorial shows `state: "RUNNING"` for queries even though the enum lists only PROCESSING, FINISHED and FAILED. Treat any non-terminal state as pending.
- Indexes are cached 30 days on a rolling window, refreshed on access. The first build waits for SVF2 translation (FG:mp).
- Download with `Authorization` and follow redirects. Node `fetch` (undici) drops `Authorization` on cross-origin redirects; keep it that way. Always gunzip NDJSON (check magic bytes) and stream line by line.
- **What to index:** the **seed file version URN**, as in manifest `seedFiles[].versionUrn = urn:adsk.wipprod:fs.file:vf.…?version=N`. From the model set this is `documentVersions[].originalSeedFileVersionUrn`. Deduplicate: several documentVersions share one seed. S:pbi passes `documentVersions[].versionUrn`, which equals the seed URN for ACC `File` items. **UNVERIFIED** for BIM 360 `Document` items, so prefer `originalSeedFileVersionUrn`.

Manifest (FG:mp): `{schema:"2.0.0", projectId, status, createdAt, seedFiles:[{lineageId, lineageUrn, versionUrn, databases:[{id, offsets, attributes, values, mapping, ids}], views:[{id, urn, is3d, viewableName, viewableId, viewableGuid}]}], errors, stats:{objects, contentLength}}`.

Field line (NDJSON): `{"key":"p5eddc473","category":"__category__","type":"String","name":"Category","uom":null}`. Types include String, Integer, Double, Boolean, DbKey.

Property row (NDJSON):
```json
{"svf2Id":68,"lineageId":"a19f7db","externalId":"b5c4b31f-…-0003f740","lmvId":2388,"databaseId":"3747dccf",
 "props":{"p153cb174":"HSS-Hollow Structural Section-Column [259904]","p20d8441e":"Structural Columns",
          "p30db51f9":"HSS-Hollow Structural Section-Column","p13b6b3a0":"HSS7X7X.250","p5eddc473":"Revit Structural Columns",
          "pa7275c45":-2001330,"pbadfe721":"BEARING","pddd761c6":"FOUNDATION PLAN"},
 "propsHash":"bcde34b3","propsIgnored":{"p6a81eafd":2386,"p93e93af5":2387},"geomHash":"…",
 "bboxMin":{"x":-141.35,"y":-54.10,"z":100.0},"bboxMax":{"x":-140.63,"y":-53.38,"z":111.02},"views":["e7fda9d5","12fcb372"]}
```
- `lmvId` = "The SVF ID for this row in the Viewer"; `svf2Id` = SVF2 id; `externalId` = Revit UniqueId; `views:null/[]` means not viewable (FG:mp).

### 4.1 Mapping a clash to index rows (critical)

**Join key: `lvid`/`rvid` == index `lmvId` (SVF1 dbId)**, within the seed file of `ldid`/`rdid`.
- S:pbi `analyze.js`: "Model Coordination (clash) API still uses SVF(1) id, use this id to map clash data", with columns `svfId: "s.lmvId", svf2Id: "s.svf2Id"` and filter `data.svfId == doc0.lvid`.
- S:clashview loads the viewer with `env: 'AutodeskProduction'` (SVF) and themes `lvid`.
- **Not** `loid`/`roid`: those are stable ids with no index column.
- **Not** `svf2Id`: use `svf2Id` only to highlight in an SVF2 viewer.
- Residual risk (**UNVERIFIED** for V2 spaces with `clashEngineVersion` > 1 or `isSvf2Supported: true`): implement a self-check. For a sample of 50 instances, verify that the `lmvId` match exists and has non-empty `views` with a 3D category. If the match rate is below 90%, try `svf2Id` and log loudly.

Resolution chain per clash instance:
`cid` → instance → `ldid` → `documents[ldid].urn` → modelset `documentVersions[versionUrn == urn]` (gives `viewableName`, `viewableGuid`, `originalSeedFileVersionUrn`, `displayName`, `bubbleUrn`) → index for that seed → row where `lmvId == lvid` (optionally `views` contains the manifest view whose `viewableGuid` matches) → props.

Recommended query, one index per seed file, run once per model set version and cached in `.coordinator/`:
```json
{ "query": { "$gt": [{ "$count": "s.views" }, 0] },
  "columns": { "lmvId": "s.lmvId", "svf2Id": "s.svf2Id", "externalId": "s.externalId",
               "name": "s.props.<__name__/name>", "category": "s.props.<__category__/_RC>",
               "family": "s.props.<__category__/_RFN>", "type": "s.props.<__category__/_RFT>",
               "level": "s.props.<Constraints/Level|Reference Level|Base Constraint>",
               "system": "s.props.<Mechanical|Plumbing/System Type|System Name|System Classification>",
               "bboxMin": "s.bboxMin", "bboxMax": "s.bboxMax" } }
```
Pass it inside `indexes:batch-status` (`versions[].query/columns`) to build and query in one call. The `$in` filter over `s.lmvId` is supported if you want only the clashing ids (T:mpref: `{"$in": {"s.lmvId": [..]}}`), but the result cache key changes per id set, so prefer the full viewable table per seed.

- **Field keys:** resolve `<…>` placeholders from the `fields` NDJSON by `(category, name)` at runtime. T:mpref documents the Revit pseudo-fields `__category__/_RC` (Revit category), `_RFN` (family), `_RFT` (type), and `__name__/name`. `__category__/Category` holds values like "Revit Structural Columns", and `__categoryId__/CategoryId` the BuiltInCategory int (for example -2001330).
- Keys look like deterministic hashes (identical across all doc examples; S:pbi hard-codes them), but this is **UNVERIFIED**. Never hard-code them.
- **Level, system, workset** are ordinary Revit parameters, so their names vary by category (Level, Reference Level, Base Constraint, Schedule Level; System Type, System Name, System Classification; Workset). The BIM specialist should supply the precedence list in `rules/`.
- **Discipline** is not a property. Derive it from the seed file (`originalSeedFileVersionName`, folder) plus category, per the rules.
- Query language (T:mpref): conditions `$and $or $not $eq $ne $lt $le $gt $ge $like $between $in $contains $isnull $notnull`; expressions `$count $add $sub $mul $div $cat $coalesce $lower $upper $case $cast $to_string`. String constants are single-quoted inside JSON (`"'%Steel%'"`). Property paths look like `s.props.pXXXX`, `s.views`, `s.lmvId`. Rows in `columns` mode come back as the projected object. More examples: S:mpps `doc/examples`.
- Fallback without the index: Model Derivative `GET /modelderivative/v2/designdata/{base64urn}/metadata/{guid}/properties?objectid=` keyed by SVF dbId (**UNVERIFIED**: not researched here; it is a Premium API).

---

## 5. ACC Issues API v1

Base: `https://developer.api.autodesk.com/construction/issues/v1/projects/{projectId}` (projectId without `b.`). **Not compatible with BIM 360** (FG:issues). Rate limit 500 req/min per user per hub (RL:issues).

| Method | Path | Notes |
|---|---|---|
| GET | `/users/me` | Permissions. `issue.new.permittedStatuses` gives the statuses this user may create with (R:issues-issues-POST). |
| GET | `/issue-types?include=subtypes&filter[isActive]=true&limit&offset` | `{pagination:{limit,offset,totalResults}, results:[{id,title,isActive,subtypes:[{id,issueTypeId,title,code(≤3),isActive}]}]}` |
| GET | `/issue-root-cause-categories?include=rootcauses` | `results:[{id,title,isActive,rootCauses:[…]}]` (`include` param **UNVERIFIED**; the schema shows a `rootCauses` array) |
| GET | `/issue-attribute-definitions`, `/issue-attribute-mappings` | Custom fields |
| GET | `/issues` | `limit` 1..100 (default 100), `offset`, `sortBy`, `fields`, `filter[id\|issueTypeId\|issueSubtypeId\|status\|linkedDocumentUrn\|assignedTo\|rootCauseId\|createdAt\|updatedAt\|search\|displayId\|…]` |
| GET | `/issues/{issueId}` | Full issue incl. `linkedDocuments` |
| POST | `/issues` | Create (data:write) |
| PATCH | `/issues/{issueId}` | Update (data:read data:write) |
| GET/POST | `/issues/{issueId}/comments` | Comments |

POST body (R:issues-issues-POST): `title*` (max 100), `description` (max 1000), `issueSubtypeId*` (uuid), `status*`, `assignedTo`, `assignedToType` (`user|company|role`), `dueDate`, `startDate`, `locationId`, `locationDetails` (max 250), `rootCauseId`, `published` (**default false = unpublished**), `watchers[]`, `customAttributes:[{attributeDefinitionId, value: string|number|null}]`, `gpsCoordinates`, `snapshotHasMarkups`.
- Status values: `draft, open, pending, in_progress, completed, in_review, not_approved, in_dispute, closed`.
- Response adds `id, displayId, issueTypeId, linkedDocuments[], permittedStatuses, permittedActions, …`.
- `linkedDocuments[]` (read): `{type:"TwoDVectorPushpin"(3D)|"TwoDRasterPushpin"(2D), urn (lineage), createdAtVersion, closedAtVersion, details:{viewable:{id,guid,viewableId,name,is3D}, position:{x,y,z}, objectId, externalId, viewerState}}`.
- **"Placement issues are currently read-only in the Issues API — they can be retrieved… but cannot be created or updated via the API"** (FG:issues). **Therefore a clash-linked issue with a 3D pushpin can only be created via MC `clashes:assign` (§3.3).** Use Issues v1 afterwards to read, comment, PATCH status or assignee, or publish.
- Assignable member, role and company IDs: there is no Issues endpoint for them. The docs recommend Data Connector, or ACC Admin `GET /construction/admin/v1/projects/{projectId}/users` (**UNVERIFIED**, not researched). See https://aps.autodesk.com/en/docs/acc/v1/tutorials/issues/retrieve-available-members-roles-companies/.
- From an issue back to its clash group: `GET …/modelsets/{m}/clashes/assigned?issueId=`, `POST …/tests/{t}/clashes/assigned?issues=true`, or `POST …/clashes/assigned/viewcontext`.

---

## 6. BIM 360 vs ACC differences that matter

| Topic | BIM 360 | ACC |
|---|---|---|
| MC Model Set / Clash v3, Index v2 | same endpoints | same endpoints ("compatible with both") |
| Issues API | `/issues/v2/containers/{issuesContainerId}/…` (container id from the DM project) — https://aps.autodesk.com/en/docs/bim360/v1/tutorials/issuesv2/retrieve-container-id/ | `/construction/issues/v1/projects/{projectId}`; v1 is not BIM 360 compatible |
| Issue status set | two status sets | single set (see §5); issues **unpublished by default** |
| Model set `forgeType` | often `versions:autodesk.bim360:Document` (per-viewable derived URN ≠ seed URN) | typically `versions:autodesk.bim360:File` (**UNVERIFIED**) |
| Coordination space | V1 (older) | V2 for projects created after 2022-10-25 (and spaces created after 2023-08-03, except Plans folder). Incremental clash, Revit master view, object exclusions; counts differ slightly from V1 (H:v2) |
| App provisioning | BIM 360 Account Admin → Apps & Integrations | ACC Account Admin → Custom Integrations (H:ci) |
| Field casing quirk | – | MC assign uses `assignedToType: User`, `issueSubTypeId`; Issues uses `user`, `issueSubtypeId` |

---

## 7. Practical limits

- **Rate:** MC uses 600 req/min per user across all MC endpoints and all apps; 413 if a request is too large (RL:mc). Issues: 500 req/min per user hub (RL:issues). On 429, honour `Retry-After` in seconds; body `{"developerMessage":"Quota limit exceeded."}` (RL:aps).
- **Job quotas per project** (RL:mc), shared with the ACC UI and other integrations; exhaustion gives 429:
  - `clashes:assign` 250/h
  - `clashes:close` 250/h
  - `clashes:reopen` 250/h
  - model set issue 250/h
  - clash test 25/h and 50/12h (automatic)
  - model set version 25/h and 50/12h
  - view create/update/delete 100/h each
  - **Implication:** batch many groups per POST (body is an array; up to 1000 clashes per group) instead of one POST per group, and keep the apply queue below about 200 jobs/h.
- **Batch sizes:** reads by id take 1..20 group ids; viewcontext takes 1..5 issue ids; list pages are 20 items for model sets, views and versions. Index batch-status accepts 1..1000 versions.
- **Model set:** at most 1,000 documents per version. Clash checks fail more often at ≥450 models; more than 10,000 clashes degrades UI performance (H:faq). Tolerance is fixed at 0.5 mm. Same-model clashes are not detected (H:faq).
- **Resource sizes:** no official numbers (**UNVERIFIED**). The index example has 33,097 objects and 1.88 MB raw properties for 3 RVTs (FG:mp). Assume tens of MB gzipped for large projects. Stream (gunzip, then JSON or NDJSON), cache per `{container, modelSet, version, testId}` under `.coordinator/cache/`, and never load into the browser.
- **Tests per version:** normally one (S:clashview); see §3.1.

---

## 8. Corrections to legacy client (`docs/legacy/model-coordination.ts`, `aps-auth-plugin.ts`)

1. **`closeClashes` / `assignClashes`: wrong method, path and body.** Legacy sends GET with no body to `/containers/{c}/modelsets/{m}/tests/{t}/clashes:close|assign`. Correct: `POST /bim360/clash/v3/containers/{c}/tests/{t}/clashes:close|assign` (no `modelsets` segment), `Content-Type: application/json`, body = array of `ClosedGroupCreate` / `AssignedGroupCreate`, response 202 job that must be polled.
2. **Viewer id bug:** `leftDbId: inst.loid` / `rightDbId: inst.roid` is wrong. `loid`/`roid` are stable object ids; the viewer dbId is `lvid`/`rvid` (T:clash, S:clashview). Keep both: stable ids are needed for cross-version tracking.
3. **`processClashes` drops most clashes:** it keeps only instances with `ldid === projectDocs[0].id`, so only the first document's left side survives. It should keep all instances and resolve both `ldid` and `rdid`.
4. **Clash views misused as clash tests:** model set views are saved viewer subsets. Filtering clash results by a view name is a UI filter at most. Ingest must not depend on it.
5. **No pagination:** `getModelSets`, `getClashViews`, `getClashTests` and `getClashResources` ignore `page.continuationToken`. Model sets, views and versions return at most 20 per page.
6. **Resource download ignores `headers` and `validUntil`,** and assumes JSON. It must send the returned `headers`, refresh URLs after expiry, and gunzip when the body starts with `1f 8b`.
7. **Status labels 1–4 ("Active/Reviewed/Resolved/Closed") and `dist` units are undocumented assumptions.** Mark them as such. Derive triage state from assigned/closed groups (§3.3). Validate `dist` units on real data.
8. **Document matching strips `?version=`** (`split("?")[0]`). The official sample matches `documents[].urn === documentVersions[].versionUrn` exactly. Stripping can match the wrong version.
9. Type gaps: `DocumentVersion` lacks `bubbleUrn, viewableGuid, viewableId, documentStatus, originalSeedFileVersionUrn, originalSeedFileVersionName, forgeType`. `ClashTest.backendType` is undocumented. `ClashResource` lacks `extension, headers, validUntil`. `ModelSet` lacks `isDisabled, isDeleted, rootFolder, clashEngineVersion, isDocumentLimitReached`.
10. `apsFetch` has no 429/`Retry-After` handling, no `x-ads-region`, no token refresh on 401, and puts only 200 chars of the error in the thrown message. Parse the `{type,title,detail,errors}` body instead.
11. `aps-auth-plugin.ts`: `/api/s3-proxy` fetches **any URL** POSTed to it, which is an open proxy (SSRF). Remove it: downloads happen server-side by resource type, never by caller-supplied URL. The token exchange has no PKCE and no `state` check. Refresh does not persist the rotated refresh token.
12. `processClashes` returns `modelUrns` as raw `fs.file` URNs. The viewer needs `base64url(bubbleUrn)` plus `viewableGuid` (S:clashview).

---

## 9. Recommended client design (`server/aps/`)

All functions take a `ctx: ApsCtx = { getToken(): Promise<string>; region?: 'US'|'EMEA'; fetch?: typeof fetch; log }`. One `apsRequest()` handles base URL, auth, 401 → refresh-once, 429 → `Retry-After` (cap and jitter), 5xx retry ×3, error-body parsing into `ApsError {status, type, title, detail, errors}`, and `x-ads-region`. All IDs are plain GUIDs; normalise `b.` at the boundary.

```ts
// auth.ts
loginInteractive(opts: { clientId: string; clientSecret?: string; port: number; scopes: string[] }): Promise<TokenSet>
getAccessToken(): Promise<string>              // cached, refresh with mutex, persists rotated refresh_token
logout(): Promise<void>

// http.ts
apsRequest<T>(ctx, method: 'GET'|'POST'|'PATCH', path: string, opts?: { query?: Record<string,unknown>; body?: unknown; contentType?: string }): Promise<T>
paginateContinuation<T>(ctx, path, itemsKey: string, query?): AsyncIterable<T>   // MC: page.continuationToken
paginateOffset<T>(ctx, path, query?): AsyncIterable<T>                          // Issues: limit/offset/pagination.totalResults
downloadMaybeGzip(url: string, headers?: Record<string,string>): Promise<Buffer>  // no APS auth; sniff 1f8b
streamNdjson<T>(ctx, apsUrl: string): AsyncIterable<T>                           // index resources (auth + 303 follow + gunzip)

// modelset.ts
listModelSets(ctx, containerId, opts?: { includeDisabled?: boolean }): Promise<ModelSet[]>
getModelSet(ctx, containerId, modelSetId): Promise<ModelSet>
listModelSetVersions(ctx, containerId, modelSetId, status?: MsvStatus[]): Promise<ModelSetVersionSummary[]>
getModelSetVersion(ctx, containerId, modelSetId, version: number | 'latest'): Promise<ModelSetVersion>
listModelSetViews(ctx, containerId, modelSetId): Promise<ModelSetView[]>

// clash.ts
listClashTests(ctx, containerId, modelSetId, version?: number, status?: TestStatus): Promise<ClashTest[]>
getClashTest(ctx, containerId, testId): Promise<ClashTest>
getClashResources(ctx, containerId, testId): Promise<ClashResource[]>
fetchClashResults(ctx, containerId, testId): Promise<{ clashes: RawClash[]; instances: RawClashInstance[]; documents: RawClashDocument[] }> // re-lease on expiry, cache to disk
listGroupedClashIds(ctx, containerId, modelSetId): Promise<number[]>
listAssignedGroups(ctx, containerId, modelSetId, filter?: { clashTestId?: string; issueId?: string; after?: string }): Promise<AssignedGroup[]>
listClosedGroups(ctx, containerId, modelSetId, filter?: { clashTestId?: string; reason?: CloseReason; after?: string }): Promise<ClosedGroup[]>
intersectAssignedGroups(ctx, containerId, testId): Promise<GroupIntersection>   // existing/resolved per group
intersectClosedGroups(ctx, containerId, testId): Promise<GroupIntersection>
getAssignedGroupsDetail(ctx, containerId, testId, ids: string[], byIssueId?: boolean): Promise<AssignedGroupDetail[]> // chunks of 20
getClosedGroupsDetail(ctx, containerId, testId, ids: string[]): Promise<ClosedGroupDetail[]>                       // chunks of 20
// --- write (only called by the approval/apply path, never by MCP tools directly) ---
closeClashGroups(ctx, containerId, testId, groups: ClosedGroupCreate[]): Promise<ClashGroupJob>
assignClashGroups(ctx, containerId, testId, groups: AssignedGroupCreate[]): Promise<ClashGroupJob>
reopenClosedGroups(ctx, containerId, modelSetId, groupIds: string[]): Promise<ClashGroupJob>
waitClashJob(ctx, containerId, jobId, opts?: { timeoutMs?: number }): Promise<ClashGroupJob>
uploadScreenshot(ctx, containerId, modelSetId, png: Buffer): Promise<{ id: string }>

// properties.ts (Index v2)
ensureIndexes(ctx, projectId, seedVersionUrns: string[], q?: { query: object; columns?: object }): Promise<IndexStatus[]> // batch-status + poll retryAt
getIndexFields(ctx, projectId, indexId): Promise<IndexField[]>
resolveFieldKeys(fields: IndexField[], wanted: Array<{ category: string; name: string }[]>): Record<string, string|undefined>
queryIndex(ctx, projectId, indexId, q: { query: object; columns?: object }): AsyncIterable<Record<string, unknown>>
buildElementTable(ctx, projectId, seedVersionUrn): Promise<Map<number /*lmvId*/, ElementProps>> // cached per seed version
verifyIdMapping(sample: RawClashInstance[], tables: Map<string, Map<number, ElementProps>>): { key: 'lmvId'|'svf2Id'; matchRate: number }

// issues.ts (ACC v1)
getIssuesMe(ctx, projectId): Promise<IssuesUserMe>
listIssueTypes(ctx, projectId): Promise<IssueType[]>         // include=subtypes, filter[isActive]=true
listRootCauses(ctx, projectId): Promise<RootCauseCategory[]>
listIssues(ctx, projectId, filter?: IssueFilter): Promise<Issue[]>
getIssue(ctx, projectId, issueId): Promise<Issue>
updateIssue(ctx, projectId, issueId, patch: IssuePatch): Promise<Issue>   // apply path only
addIssueComment(ctx, projectId, issueId, body: string): Promise<IssueComment> // apply path only

// join.ts (pure, lives in core/ingest)
buildDocIndex(msv: ModelSetVersion, docs: RawClashDocument[]): Map<number /*clash doc id*/, { versionUrn; seedUrn; viewableName; viewableGuid; viewerUrn: string /*base64url(bubbleUrn)*/; fileName }>
normalizeClashes(raw, docIndex, elementTables, groupState): Clash[]  // left/right {docId, stableId(loid), viewerId(lvid), props}
```

### Open risks and unknowns (to close with one real ACC project)

1. Units and sign of `dist`; raw `status` type and values.
2. `lvid`↔`lmvId` holds for V2 spaces / `clashEngineVersion` ≥ 2 (sample-verified only on older spaces). Ship `verifyIdMapping`.
3. Pushpin coordinate frame for `clashes:assign`.
4. Whether presigned clash URLs need gzip handling, and their typical size.
5. Loopback redirect port flexibility; refresh-token rotation semantics; SSA acceptance by MC/Index.
6. Whether Index v2 is a Premium API (only matters for a public PKCE client).

Capture anonymised payloads into `tests/fixtures/` on the first live run to settle items 1–4.
