/**
 * "Informe del ciclo": Spanish markdown + printable HTML built from the
 * cycle KPIs of GET /reports (ReportData). Pure functions (tested in
 * tests/ui/parity-human.test.ts). Every number comes from the server; this
 * only lays it out. HTML is fully escaped (no raw model text reaches markup).
 */
import type { ReportData } from "~/lib/api/types";

export interface CycleReportMeta {
  projectName: string;
  modelSetName: string;
  /** ISO date of generation (yyyy-mm-dd). */
  date: string;
}

const n = (v: number) => new Intl.NumberFormat("es-CL").format(v);

export function cycleReportMarkdown(r: ReportData, m: CycleReportMeta): string {
  const k = r.kpis;
  const delta = k.activeClashesPrev === null ? "" : ` (${k.activeClashes - k.activeClashesPrev >= 0 ? "+" : ""}${n(k.activeClashes - k.activeClashesPrev)} vs versión anterior)`;
  const L: string[] = [
    "# Informe del ciclo de coordinación",
    "",
    `Proyecto: ${m.projectName} · Conjunto: ${m.modelSetName} · Fecha: ${m.date}`,
    "",
    "## Cifras",
    "",
    "| Indicador | Valor |",
    "|---|---|",
    `| Interferencias activas | ${n(k.activeClashes)}${delta} |`,
    `| Interferencias (total ACC) | ${n(k.rawClashes)} |`,
    `| Grupos | ${n(k.groups)} |`,
    `| Grupos revisados | ${n(k.groupsReviewed)} |`,
    `| Interferencias revisadas | ${n(k.rawClashesReviewed)} |`,
    `| Incidencias creadas en ACC | ${n(k.issuesCreated)} |`,
    `| Propuestas aceptadas / corregidas / rechazadas | ${n(k.aiAccepted)} / ${n(k.aiCorrected)} / ${n(k.aiRejected)} |`,
    `| P1 sin decidir: < 1 sem · 1–2 · 2–4 · > 4 sem | ${n(r.p1Aging.lt1w)} · ${n(r.p1Aging.w1to2)} · ${n(r.p1Aging.w2to4)} · ${n(r.p1Aging.gt4w)} |`,
    "",
  ];
  if (r.newVsResolved.length) {
    L.push("## Evolución por versión", "", "| Versión | Nuevas | Resueltas |", "|---|---|---|", ...r.newVsResolved.map((x) => `| ${x.label} | ${n(x.new)} | ${n(x.resolved)} |`), "");
  }
  if (r.byStatusPair.length) {
    L.push(
      "## Por par de disciplinas (última versión)",
      "",
      "| Par | Activas | Revisadas | Resueltas | Cerradas |",
      "|---|---|---|---|---|",
      ...r.byStatusPair.map((x) => `| ${x.pair} | ${n(x.active)} | ${n(x.reviewed)} | ${n(x.resolved)} | ${n(x.closed)} |`),
      "",
    );
  }
  if (r.reasons.length) {
    L.push("## Motivos de corrección", "", ...r.reasons.map((x) => `- ${x.code}: ${n(x.count)}`), "");
  }
  L.push("Cifras calculadas por el servidor local de coordinación. Uso sujeto al Procedimiento Acceso Herramientas IA de SalfaCorp.");
  return L.join("\n");
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Minimal markdown (headings, tables, bullets, paragraphs) → standalone printable HTML. Everything escaped. */
export function markdownToPrintableHtml(md: string, title: string): string {
  const out: string[] = [];
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.startsWith("|")) {
        if (!/^\|[-| ]+\|$/.test(lines[i]!)) rows.push(lines[i]!.slice(1, -1).split("|").map((c) => c.trim()));
        i++;
      }
      i--;
      out.push("<table>", ...rows.map((r, ri) => `<tr>${r.map((c) => (ri === 0 ? `<th>${escapeHtml(c)}</th>` : `<td>${escapeHtml(c)}</td>`)).join("")}</tr>`), "</table>");
    } else if (l.startsWith("## ")) out.push(`<h2>${escapeHtml(l.slice(3))}</h2>`);
    else if (l.startsWith("# ")) out.push(`<h1>${escapeHtml(l.slice(2))}</h1>`);
    else if (l.startsWith("- ")) out.push(`<li>${escapeHtml(l.slice(2))}</li>`);
    else if (l.trim()) out.push(`<p>${escapeHtml(l)}</p>`);
  }
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 16px;color:#111}h1,h2{color:#A32428}table{border-collapse:collapse;margin:.5rem 0}td,th{border:1px solid #ddd;padding:4px 8px;text-align:left}@media print{body{margin:0}}</style></head><body>${out.join("\n")}</body></html>`;
}

export function reportFileName(m: CycleReportMeta, ext: "md" | "html"): string {
  const slug = m.modelSetName.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "conjunto";
  return `${m.date}-informe-ciclo-${slug}.${ext}`;
}
