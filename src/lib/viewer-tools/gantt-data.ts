/**
 * Gantt Data — types and sample data for construction timeline.
 *
 * Data can come from model properties (Phase Created/Phase Demolished),
 * external schedule sources (Primavera, MS Project, JSON API), or manual entry.
 */

export interface GanttTask {
  id: string;
  name: string;
  start: Date;
  end: Date;
  /** 0–100 completion percentage. */
  progress: number;
  /** Bar color (hex). Falls back to palette. */
  color?: string;
  /** Optional dbIds this task relates to — highlighted when task is active. */
  linkedDbIds?: number[];
  /** Parent task id for grouping (optional). */
  parentId?: string;
}

export interface GanttConfig {
  /** Tasks to display in the timeline. */
  tasks: GanttTask[];
  /** Overall project start. Auto-computed if omitted. */
  projectStart?: Date;
  /** Overall project end. Auto-computed if omitted. */
  projectEnd?: Date;
}

// ── Default Sample Data (PoC) ─────────────────────────────────────

/** 8-phase construction project — 12 months, Jan–Dec 2026. */
export const DEFAULT_GANTT_TASKS: GanttTask[] = [
  {
    id: "1-site",
    name: "Site Preparation",
    start: new Date("2026-01-05"),
    end: new Date("2026-02-15"),
    progress: 100,
    color: "#8D9299",
  },
  {
    id: "2-foundation",
    name: "Foundation & Excavation",
    start: new Date("2026-02-01"),
    end: new Date("2026-04-10"),
    progress: 100,
    color: "#34495E",
  },
  {
    id: "3-structure",
    name: "Structural Frame",
    start: new Date("2026-03-15"),
    end: new Date("2026-07-20"),
    progress: 100,
    color: "#4A90D9",
  },
  {
    id: "4-enclosure",
    name: "Building Enclosure",
    start: new Date("2026-05-01"),
    end: new Date("2026-08-30"),
    progress: 85,
    color: "#2ECC71",
  },
  {
    id: "5-mep",
    name: "MEP Rough-in",
    start: new Date("2026-06-01"),
    end: new Date("2026-10-15"),
    progress: 50,
    color: "#F39C12",
  },
  {
    id: "6-interior",
    name: "Interior Finishing",
    start: new Date("2026-08-01"),
    end: new Date("2026-11-30"),
    progress: 20,
    color: "#A32428",
  },
  {
    id: "7-exterior",
    name: "Exterior & Site Work",
    start: new Date("2026-09-01"),
    end: new Date("2026-12-15"),
    progress: 10,
    color: "#9B59B6",
  },
  {
    id: "8-commissioning",
    name: "Commissioning & Handover",
    start: new Date("2026-11-15"),
    end: new Date("2026-12-31"),
    progress: 0,
    color: "#1ABC9C",
  },
];

// ── External Source Support ───────────────────────────────────────

let externalSource: (() => Promise<GanttTask[]>) | null = null;

export function registerGanttSource(fetcher: () => Promise<GanttTask[]>): void {
  externalSource = fetcher;
}

export async function fetchGanttTasks(): Promise<GanttTask[]> {
  if (externalSource) return externalSource();
  return DEFAULT_GANTT_TASKS;
}
