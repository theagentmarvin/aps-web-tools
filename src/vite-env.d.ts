/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Coordinator data source: "mock" (in-memory demo data) or "http" (/api/coord/*). */
  readonly VITE_COORD_API?: "mock" | "http";
  readonly VITE_APS_CLIENT_ID?: string;
  readonly VITE_APS_CALLBACK_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
