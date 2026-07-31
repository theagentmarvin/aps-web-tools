/**
 * Marker Types — type definitions for the 3D marker system.
 *
 * Reference: wallabyway/markupExt (point-cloud + spritesheet),
 *   Petr Broz forge-digital-twin/issues.js (world-coordinate THREE sprites).
 */

/** Base marker — common fields for all marker types. */
export interface MarkerBase {
  id: string;
  type: MarkerType;
  position: { x: number; y: number; z: number };
  /** Tooltip shown on hover. */
  label: string;
  /** When set, clicking the marker navigates to this camera viewpoint. */
  cameraState?: {
    position: { x: number; y: number; z: number };
    target: { x: number; y: number; z: number };
    up?: { x: number; y: number; z: number };
  };
  /** Timestamp when the marker was created. */
  createdAt: number;
  /** Optional user-assigned color override. */
  color?: string;
}

// ── Marker Types ─────────────────────────────────────────────────

export type MarkerType =
  | "camera"    // Photo/camera capture viewpoint
  | "issue"     // Issue/RFI flag
  | "object"    // Object representation marker
  | "sonar";    // Animated sonar/radar pulse

export interface CameraMarker extends MarkerBase {
  type: "camera";
  /** Base64 thumbnail or URL to the captured screenshot. */
  screenshotUrl?: string;
  /** What this camera was capturing. */
  caption?: string;
}

/** Issue status colors (matching APS/BIM360 convention). */
export type IssueStatus = "open" | "answered" | "closed" | "void" | "draft";

export interface IssueMarker extends MarkerBase {
  type: "issue";
  /** Issue/RFI identifier string. */
  issueId: string;
  status: IssueStatus;
  /** Optional dbId this issue is attached to. */
  linkedDbId?: number;
  description?: string;
  /** Snapshot URN if the issue has a linked screenshot. */
  snapshotUrn?: string;
}

export interface ObjectMarker extends MarkerBase {
  type: "object";
  /** The dbId this marker represents/highlights. */
  dbId: number;
  /** Optional property to display in the tooltip. */
  displayProperty?: { name: string; value: string };
}

export interface SonarMarker extends MarkerBase {
  type: "sonar";
  /** Pulse radius in model units (max extent of the animation). */
  radius: number;
  /** Pulse speed: full cycle duration in seconds. */
  speed: number;
  /** Ring color (hex). */
  ringColor: string;
}

/** Union type for all marker variants. */
export type Marker = CameraMarker | IssueMarker | ObjectMarker | SonarMarker;

// ── Callbacks ────────────────────────────────────────────────────

export interface MarkerCallbacks {
  /** Called when a marker is clicked. Return false to prevent default behavior. */
  onMarkerClick?: (marker: Marker) => boolean | void;
  /** Called when a marker is hovered. */
  onMarkerHover?: (marker: Marker | null) => void;
  /** Custom info card renderer — if provided, overrides default tooltip. */
  renderInfoCard?: (marker: Marker, screenX: number, screenY: number) => HTMLElement | null;
}

// ── Status Color Map ─────────────────────────────────────────────

export const ISSUE_STATUS_COLORS: Record<IssueStatus, string> = {
  open: "#e74c3c",     // red
  answered: "#f39c12",  // orange
  closed: "#27ae60",    // green
  void: "#95a5a6",      // gray
  draft: "#9b59b6",     // purple
};

// ── Default Icons (emoji sprites rendered as THREE.Sprite via canvas) ─

export const MARKER_ICONS: Record<MarkerType, string> = {
  camera: "📷",
  issue: "🚩",
  object: "📦",
  sonar: "📡",
};
