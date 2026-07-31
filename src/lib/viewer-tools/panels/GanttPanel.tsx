/**
 * GanttPanel — Floating construction timeline over the viewer.
 *
 * Tandem-style: horizontal Gantt bar chart with playhead, task bars colored
 * by phase, progress fill, and click-to-highlight. Positioned as a floating
 * window at the bottom of the viewer.
 */
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { fetchGanttTasks } from "../gantt-data";
import type { GanttTask } from "../gantt-data";

interface Props {
  hasModel: boolean;
}

// ── SalfaCorp palette for task bar fallback colors
const TASK_PALETTE = [
  "#A32428", "#4A90D9", "#2ECC71", "#F39C12",
  "#9B59B6", "#34495E", "#1ABC9C", "#8D9299",
  "#E74C3C", "#D4AC0D",
];

// ── Helpers
const DAY_MS = 86400000;

function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / DAY_MS;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("es-CL", { month: "short", day: "numeric" });
}

const MONTHS_SHORT = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];

export function GanttPanel({ hasModel }: Props) {
  const [tasks, setTasks] = useState<GanttTask[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [playheadDate, setPlayheadDate] = useState<Date>(new Date());
  const [dragging, setDragging] = useState(false);
  const [hoveredTask, setHoveredTask] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // Load tasks
  useEffect(() => {
    if (hasModel) {
      fetchGanttTasks().then(setTasks);
    }
  }, [hasModel]);

  // Compute bounds
  const { start, end, totalDays } = useMemo(() => {
    if (tasks.length === 0) return { start: new Date(), end: new Date(), totalDays: 1 };
    let s = tasks[0].start;
    let e = tasks[0].end;
    for (const t of tasks) {
      if (t.start < s) s = t.start;
      if (t.end > e) e = t.end;
    }
    // Add 1 week padding
    s = new Date(s.getTime() - 7 * DAY_MS);
    e = new Date(e.getTime() + 7 * DAY_MS);
    return { start: s, end: e, totalDays: Math.max(1, daysBetween(s, e)) };
  }, [tasks]);

  // Month ticks
  const monthTicks = useMemo(() => {
    const ticks: { label: string; left: number }[] = [];
    const d = new Date(start.getFullYear(), start.getMonth(), 1);
    while (d <= end) {
      const left = (daysBetween(start, d) / totalDays) * 100;
      ticks.push({ label: `${MONTHS_SHORT[d.getMonth()]}`, left });
      d.setMonth(d.getMonth() + 1);
    }
    return ticks;
  }, [start, end, totalDays]);

  // Playhead position
  const playheadPct = useMemo(() => {
    const pct = (daysBetween(start, playheadDate) / totalDays) * 100;
    return Math.max(0, Math.min(100, pct));
  }, [start, playheadDate, totalDays]);

  // Today marker
  const todayPct = useMemo(() => {
    const now = new Date();
    if (now < start || now > end) return null;
    return (daysBetween(start, now) / totalDays) * 100;
  }, [start, end, totalDays]);

  // ── Playhead drag handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const handleMove = (e: MouseEvent) => {
      const bar = barRef.current;
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const pct = (x / rect.width) * 100;
      const clamped = Math.max(0, Math.min(100, pct));
      const days = (clamped / 100) * totalDays;
      const date = new Date(start.getTime() + days * DAY_MS);
      setPlayheadDate(date);
    };
    const handleUp = () => setDragging(false);
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [dragging, start, totalDays]);

  // Jump to today
  const goToToday = useCallback(() => setPlayheadDate(new Date()), []);

  if (!hasModel || tasks.length === 0) return null;

  if (collapsed) {
    return (
      <div className="absolute bottom-3 left-3 z-20">
        <button
          onClick={() => setCollapsed(false)}
          className="text-[10px] px-2 py-1 rounded border border-brand-muted/30 bg-white/90 text-brand hover:bg-brand-surface"
        >
          📅 Timeline
        </button>
      </div>
    );
  }

  return (
    <div className="absolute bottom-0 left-0 right-0 z-20 mx-2 mb-2">
      <div className="bg-white/95 backdrop-blur-sm border border-brand-muted/30 rounded-lg shadow-lg overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-brand-muted/20 bg-brand-surface/70">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold text-gray-600">📅 Construction Timeline</span>
            <span className="text-[9px] text-gray-400">
              {formatDate(start)} – {formatDate(end)}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={goToToday}
              className="text-[9px] px-1.5 py-0.5 rounded border border-brand-muted/30 text-gray-400 hover:text-brand hover:border-brand/50"
            >
              Today
            </button>
            <button
              onClick={() => setCollapsed(true)}
              className="text-[9px] text-gray-400 hover:text-gray-600"
            >
              ▾
            </button>
          </div>
        </div>

        {/* Gantt bars */}
        <div className="px-3 py-2" ref={barRef}>
          {/* Month ticks */}
          <div className="relative h-4 mb-1">
            {monthTicks.map((mt, i) => (
              <div
                key={i}
                className="absolute text-[8px] text-gray-400 -translate-x-1/2"
                style={{ left: `${mt.left}%` }}
              >
                <div className="w-px h-1.5 bg-brand-muted/40 mx-auto mb-0.5" />
                {mt.label}
              </div>
            ))}
          </div>

          {/* Task rows */}
          <div className="relative" style={{ minHeight: `${Math.max(tasks.length * 22 + 6, 100)}px` }}>
            {/* Grid lines */}
            {monthTicks.map((mt, i) => (
              <div
                key={i}
                className="absolute top-0 bottom-0 w-px bg-brand-muted/10"
                style={{ left: `${mt.left}%` }}
              />
            ))}

            {/* Today marker */}
            {todayPct !== null && (
              <div
                className="absolute top-0 bottom-0 w-px bg-brand z-10"
                style={{ left: `${todayPct}%` }}
              >
                <div className="absolute -top-1 -translate-x-1/2 text-[7px] text-brand font-semibold">
                  Hoy
                </div>
              </div>
            )}

            {/* Playhead */}
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-20 cursor-ew-resize shadow-md"
              style={{ left: `${playheadPct}%` }}
              onMouseDown={handleMouseDown}
            >
              <div className="absolute -top-3.5 -translate-x-1/2 bg-red-500 text-white text-[8px] px-1 py-0.5 rounded whitespace-nowrap">
                {formatDate(playheadDate)}
              </div>
            </div>

            {/* Task bars */}
            {tasks.map((task, i) => {
              const left = (daysBetween(start, task.start) / totalDays) * 100;
              const width = Math.max((daysBetween(task.start, task.end) / totalDays) * 100, 2);
              const color = task.color ?? TASK_PALETTE[i % TASK_PALETTE.length];
              const isHovered = hoveredTask === task.id;

              return (
                <div
                  key={task.id}
                  className="relative h-[18px] mb-1 cursor-pointer group"
                  style={{ paddingLeft: "60px" }}
                  onMouseEnter={() => setHoveredTask(task.id)}
                  onMouseLeave={() => setHoveredTask(null)}
                >
                  {/* Label */}
                  <span
                    className="absolute left-0 top-0 text-[9px] text-gray-500 truncate w-[56px] leading-[18px]"
                    title={task.name}
                  >
                    {task.name}
                  </span>

                  {/* Bar */}
                  <div className="relative w-full h-full">
                    <div
                      className="absolute h-[14px] top-0.5 rounded-sm transition-shadow"
                      style={{
                        left: `${left}%`,
                        width: `${width}%`,
                        backgroundColor: color,
                        opacity: isHovered ? 1 : 0.85,
                        boxShadow: isHovered ? `0 0 8px ${color}60` : "none",
                      }}
                    >
                      {/* Progress fill */}
                      <div
                        className="absolute inset-y-0 left-0 rounded-l-sm"
                        style={{
                          width: `${task.progress}%`,
                          backgroundColor: "rgba(255,255,255,0.3)",
                        }}
                      />
                      {/* Label inside bar */}
                      {width > 15 && (
                        <span className="absolute inset-0 flex items-center justify-center text-[8px] text-white font-medium truncate px-1">
                          {task.progress}%
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="px-3 py-1 border-t border-brand-muted/20 bg-brand-surface/50 flex items-center gap-3 text-[9px] text-gray-400">
          <span>Playhead: {formatDate(playheadDate)}</span>
          <span className="text-brand-muted">|</span>
          <span>{tasks.length} phases</span>
          <span className="text-brand-muted">|</span>
          <span>Drag red cursor to scrub timeline</span>
        </div>
      </div>
    </div>
  );
}
