/**
 * Ingest (download + classify) with real progress: POST …/ingest → {jobId},
 * then poll GET /api/coord/ingest-jobs/:jobId. Older servers answered with the
 * test key directly; that is treated as "done".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "~/lib/api";
import type { IngestPhase } from "~/lib/api/types";

export interface IngestProgress {
  phase: IngestPhase;
  /** 0..1 */
  progress: number;
  message: string;
  error?: string;
  testKey?: string;
}

interface Callbacks {
  /** Clash grid (counts) available: refresh the grid. */
  onGridReady?: (accTestId: string) => void;
  onDone?: (accTestId: string, testKey: string | undefined) => void;
  onError?: (accTestId: string, error: string) => void;
}

const POLL_MS = 800;

export function useIngest(projectId: string, modelSetId: string, cb: Callbacks = {}) {
  const api = useApi();
  const [jobs, setJobs] = useState<Record<string, IngestProgress>>({});
  const cbRef = useRef(cb);
  cbRef.current = cb;
  const timers = useRef(new Set<number>());

  useEffect(() => {
    const t = timers.current;
    return () => {
      for (const id of t) window.clearTimeout(id);
    };
  }, []);

  const update = (accTestId: string, p: IngestProgress) => setJobs((prev) => ({ ...prev, [accTestId]: p }));

  const start = useCallback(
    async (accTestId: string, opts?: { refresh?: boolean }) => {
      update(accTestId, { phase: "downloading", progress: 0, message: "" });
      let res;
      try {
        res = await api.ingestTest(projectId, modelSetId, accTestId, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        update(accTestId, { phase: "failed", progress: 0, message: msg, error: msg });
        cbRef.current.onError?.(accTestId, msg);
        return;
      }
      if (!res.jobId) {
        update(accTestId, { phase: "done", progress: 1, message: "", testKey: res.testKey });
        cbRef.current.onGridReady?.(accTestId);
        cbRef.current.onDone?.(accTestId, res.testKey);
        return;
      }
      const jobId = res.jobId;
      let gridSignalled = false;
      const poll = async () => {
        try {
          const j = await api.getIngestJob(jobId);
          const progress = j.progress > 1 ? j.progress / 100 : j.progress;
          update(accTestId, { phase: j.phase, progress, message: j.message, error: j.error, testKey: j.testKey });
          const gridReady = j.phase === "clash_grid_ready" || j.phase === "properties" || j.phase === "classifying" || j.phase === "done";
          if (gridReady && !gridSignalled) {
            gridSignalled = true;
            cbRef.current.onGridReady?.(accTestId);
          }
          if (j.phase === "done") return cbRef.current.onDone?.(accTestId, j.testKey);
          if (j.phase === "failed") return cbRef.current.onError?.(accTestId, j.error ?? j.message);
        } catch {
          /* transient: keep polling */
        }
        const id = window.setTimeout(poll, POLL_MS);
        timers.current.add(id);
      };
      void poll();
    },
    [api, projectId, modelSetId],
  );

  const running = Object.values(jobs).some((j) => j.phase !== "done" && j.phase !== "failed");
  return { jobs, start, running };
}
