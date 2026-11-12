/**
 * Mock projects / model sets / tests definition. Test data is generated
 * lazily (see generate.ts) the first time a test is opened.
 */
import type { Hub } from "../types";
import type { GenerateOptions, MockDocDef } from "./generate";

export const HUBS: Hub[] = [
  { id: "b.hub-edificacion", name: "SalfaCorp Edificación" },
  { id: "b.hub-infra", name: "SalfaCorp Infraestructura" },
];

export interface MockModelSet {
  id: string;
  name: string;
  latestVersion: number;
  tests: GenerateOptions[];
}

export interface MockProject {
  id: string;
  name: string;
  code: string;
  hubId: string;
  modelSets: MockModelSet[];
}

const day = (iso: string) => `${iso}T09:30:00.000Z`;

/** Real-looking documents (same names as the ACC sandbox), incl. two MECHANICAL.rvt from different folders. */
export const SANDBOX_DOCS: MockDocDef[] = [
  { documentId: 0, fileName: "MODELING TEST S4.rvt", viewName: "{3D}", folderPath: "Project Files/Estructura", lineageUrn: "urn:adsk.wipprod:dm.lineage:Oxr0uGpdSnWrAXMr4tgTmw", detected: "EST", detectedSource: "elements", confidence: 0.92, suggestedToken: "MODELING TEST", placeAs: "EST" },
  { documentId: 1, fileName: "MECHANICAL.rvt", viewName: "{3D}", folderPath: "Project Files/MEP/Clima", lineageUrn: "urn:adsk.wipprod:dm.lineage:nC7nisk8TqqX0CftkdNzoQ", detected: "CLI", detectedSource: "elements", confidence: 0.81, suggestedToken: "MECHANICAL", placeAs: "CLI" },
  { documentId: 2, fileName: "MECHANICAL.rvt", viewName: "{3D}", folderPath: "Project Files/MEP/Sanitario", lineageUrn: "urn:adsk.wipprod:dm.lineage:AC0eFS4wQ9CXLqKn7UtgXA", detected: "SIN", suggestedToken: "Sanitario", placeAs: "SAN" },
  { documentId: 3, fileName: "MODELING TEST S3.rvt", viewName: "{3D}", folderPath: "Project Files/Arquitectura", lineageUrn: "urn:adsk.wipprod:dm.lineage:ZPRXdB5QQ9uC7bmk4ac_gg", detected: "SIN", suggestedToken: "MODELING TEST S3", placeAs: "ARQ" },
  { documentId: 5, fileName: "STRUCTURAL_VDC.rvt", viewName: "Navis", folderPath: "Project Files/VDC", lineageUrn: "urn:adsk.wipprod:dm.lineage:UcLS_R-USdW58rWNQni_pg", detected: "SIN", suggestedToken: "STRUCTURAL", placeAs: "INC" },
  { documentId: 6, fileName: "Sitio Vol.ifc", viewName: "Scene", folderPath: "Project Files/Sitio", lineageUrn: "urn:adsk.wipprod:dm.lineage:0v6MM94bRYu59LQ897mxjg", detected: "SIN", suggestedToken: "Sitio" },
  { documentId: 9, fileName: "Sitio Vol.rvt", viewName: "VDC", folderPath: "Project Files/Sitio", lineageUrn: "urn:adsk.wipprod:dm.lineage:y-ueC937QOSD5KLpBy8RAA", detected: "SIN", suggestedToken: "Sitio", placeAs: "ELE" },
];

export const SANDBOX_VIEWS = [
  { name: "Coordinación general", documents: [...new Set(SANDBOX_DOCS.map((d) => d.fileName))] },
  { name: "MEP vs Estructura", documents: ["MECHANICAL.rvt", "MODELING TEST S4.rvt", "STRUCTURAL_VDC.rvt"] },
  { name: "Arquitectura vs MEP", documents: ["MODELING TEST S3.rvt", "MECHANICAL.rvt"] },
  { name: "Sitio", documents: ["Sitio Vol.ifc", "Sitio Vol.rvt"] },
];

import type { DisciplineConfig, DisciplineRuleInput } from "../types";

export const SANDBOX_RULES: DisciplineRuleInput[] = [{ id: "DR-1", discipline: "EST", field: "fileName", match: "startsWith", value: "STRUCTURAL" }];

/** Agent discipline_mapping proposals (MCP propose_discipline_mapping), as DisciplineConfig.pendingProposals. */
export const SANDBOX_SUGGESTIONS: DisciplineConfig["pendingProposals"] = [
  {
    id: "P-20261109-0001",
    summary: "Sitio Vol.* → CIV (urbanización)",
    rationale: "Ambos archivos solo contienen topografía, masas y emplazamiento; corresponden a urbanización / obras civiles.",
    createdAt: "2026-11-09T09:12:00.000Z",
    payload: {
      discipline: "CIV",
      lineageUrns: ["urn:adsk.wipprod:dm.lineage:0v6MM94bRYu59LQ897mxjg", "urn:adsk.wipprod:dm.lineage:y-ueC937QOSD5KLpBy8RAA"],
      fileNames: ["Sitio Vol.ifc", "Sitio Vol.rvt"],
      rule: { discipline: "CIV", field: "fileName", match: "startsWith", value: "Sitio" },
      confidence: 0.78,
    },
  },
  {
    id: "P-20261109-0002",
    summary: "MECHANICAL.rvt (MEP/Sanitario) → SAN",
    rationale: "El 88 % de los elementos son tuberías de aguas servidas y aguas lluvias; la carpeta es MEP/Sanitario.",
    createdAt: "2026-11-09T09:14:00.000Z",
    payload: {
      discipline: "SAN",
      lineageUrns: ["urn:adsk.wipprod:dm.lineage:AC0eFS4wQ9CXLqKn7UtgXA"],
      fileNames: ["MECHANICAL.rvt"],
      rule: { discipline: "SAN", field: "folder", match: "contains", value: "Sanitario" },
      confidence: 0.84,
    },
  },
];

const SANDBOX_MS = "71941e30-2f1a-4149-a9b7-35c6d2d162bf";
const sandboxTest = (version: number, date: string, extra: Partial<GenerateOptions>): GenerateOptions => ({
  seed: 7000 + version,
  projectCode: "Sandbox",
  modelSetId: SANDBOX_MS,
  testId: `T-5b${String(version).padStart(2, "0")}c0de`,
  accTestId: `acc-sandbox-v${version}`,
  version,
  completedOn: `${date}T12:35:53.000Z`,
  groups: 60 + version * 5,
  clashes: 500 + version * 55,
  analyzed: false,
  stage: "none",
  documents: SANDBOX_DOCS,
  ...extra,
});

export const PROJECTS: MockProject[] = [
  {
    id: "da524c2d-6e11-4357-a82d-63244776d979",
    name: "Clash API Sandbox project",
    code: "Sandbox",
    hubId: "b.hub-edificacion",
    modelSets: [
      {
        id: SANDBOX_MS,
        name: "ClashAI Clashes",
        latestVersion: 11,
        tests: [
          sandboxTest(11, "2026-09-14", { analyzed: true }),
          sandboxTest(10, "2026-08-25", { stage: "counts" }),
          sandboxTest(9, "2026-08-21", {}),
          sandboxTest(8, "2026-08-14", {}),
          sandboxTest(7, "2026-08-10", { firstTest: true }),
        ],
      },
    ],
  },
  {
    id: "3f2a9c1e-7b4d-4e2a-9f10-5c8e2b7d1a01",
    name: "Torre B — Parque Las Condes",
    code: "TorreB",
    hubId: "b.hub-edificacion",
    modelSets: [
      {
        id: "a1b2c3d4-0001-4000-8000-000000000001",
        name: "Coordinación general",
        latestVersion: 14,
        tests: [
          { seed: 1401, projectCode: "TorreB", modelSetId: "a1b2c3d4-0001-4000-8000-000000000001", testId: "T-3f9a21c0", version: 14, completedOn: day("2026-11-04"), groups: 150, clashes: 1200, analyzed: true },
          { seed: 1301, projectCode: "TorreB", modelSetId: "a1b2c3d4-0001-4000-8000-000000000001", testId: "T-2e8b10af", version: 13, completedOn: day("2026-10-28"), groups: 162, clashes: 1310, analyzed: true },
          { seed: 1201, projectCode: "TorreB", modelSetId: "a1b2c3d4-0001-4000-8000-000000000001", testId: "T-1d7a0f9e", version: 12, completedOn: day("2026-10-21"), groups: 171, clashes: 1490, analyzed: true, firstTest: true },
        ],
      },
      {
        id: "a1b2c3d4-0002-4000-8000-000000000002",
        name: "MEP Subterráneos",
        latestVersion: 7,
        tests: [
          { seed: 601, projectCode: "TorreBSub", modelSetId: "a1b2c3d4-0002-4000-8000-000000000002", testId: "T-5a6b7c8d", version: 6, completedOn: day("2026-11-01"), groups: 24, clashes: 180, analyzed: true },
        ],
      },
    ],
  },
  {
    id: "7c1e4b2a-5d6f-4a8b-9c0d-1e2f3a4b5c02",
    name: "Edificio C — Ñuñoa",
    code: "EdifC",
    hubId: "b.hub-edificacion",
    modelSets: [
      {
        id: "b2c3d4e5-0003-4000-8000-000000000003",
        name: "Coordinación MEP",
        latestVersion: 3,
        tests: [
          { seed: 301, projectCode: "EdifC", modelSetId: "b2c3d4e5-0003-4000-8000-000000000003", testId: "T-7c8d9e0f", version: 3, completedOn: day("2026-11-05"), groups: 30, clashes: 220, analyzed: false, firstTest: true },
        ],
      },
    ],
  },
  {
    id: "9d8c7b6a-1f2e-4d3c-8b4a-6f5e4d3c2b03",
    name: "Hospital Regional de Talca",
    code: "HRT",
    hubId: "b.hub-infra",
    modelSets: [
      {
        id: "c3d4e5f6-0004-4000-8000-000000000004",
        name: "Coordinación general",
        latestVersion: 9,
        tests: [
          { seed: 901, projectCode: "HRT", modelSetId: "c3d4e5f6-0004-4000-8000-000000000004", testId: "T-9e0f1a2b", version: 9, completedOn: day("2026-10-30"), groups: 38, clashes: 260, analyzed: true },
        ],
      },
    ],
  },
];
