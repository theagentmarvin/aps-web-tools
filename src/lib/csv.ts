/** Build and download a CSV file (UTF-8 with BOM so Excel reads accents). */
export function toCsv(rows: (string | number | boolean | null | undefined)[][]): string {
  return rows
    .map((r) =>
      r
        .map((v) => {
          const s = v === null || v === undefined ? "" : String(v);
          return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(","),
    )
    .join("\n");
}

export function downloadCsv(filename: string, rows: (string | number | boolean | null | undefined)[][]): void {
  const blob = new Blob(["﻿" + toCsv(rows)], { type: "text/csv;charset=utf-8" });
  downloadBlob(filename, blob);
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
