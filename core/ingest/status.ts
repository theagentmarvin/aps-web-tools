/**
 * Raw clash `status` → {@link ClashStatus}.
 *
 * research §3.2 / §8.7: numeric codes 1–4 (Active/Reviewed/Resolved/Closed) come
 * from the legacy client and are UNVERIFIED; grouped data shows the string "New".
 * Real triage state must come from clash groups (see ./triage.ts).
 */
import type { ClashStatus } from "../types";

const NUMERIC: Record<number, ClashStatus> = { 1: "active", 2: "reviewed", 3: "resolved", 4: "closed" };

const TEXT: Record<string, ClashStatus> = {
  new: "active",
  active: "active",
  open: "active",
  reviewed: "reviewed",
  resolved: "resolved",
  closed: "closed",
};

export function mapClashStatus(raw: unknown): ClashStatus {
  if (typeof raw === "number") return NUMERIC[raw] ?? "unknown";
  if (typeof raw === "string") {
    const t = raw.trim().toLowerCase();
    if (/^\d+$/.test(t)) return NUMERIC[Number(t)] ?? "unknown";
    return TEXT[t] ?? "unknown";
  }
  return "unknown";
}
