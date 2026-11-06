/**
 * Mock projects / model sets / tests definition. Test data is generated
 * lazily (see generate.ts) the first time a test is opened.
 */
import type { Hub } from "../types";
import type { GenerateOptions } from "./generate";

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

export const PROJECTS: MockProject[] = [
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
