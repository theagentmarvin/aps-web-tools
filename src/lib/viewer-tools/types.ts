/**
 * Viewer Tools — shared types.
 */

/** A property discovered from the model's property database. */
export interface PropertyDef {
  name: string;
  category: string;
  /** Number of elements that have this property. */
  elementCount: number;
  /** Unique values + their frequency across the model. */
  values: PropertyValue[];
}

export interface PropertyValue {
  value: string;
  count: number;
}

/** Viewer API surface exposed by ForgeViewer. */
export interface ApsViewerAPI {
  getViewer(): unknown; // GuiViewer3D
  getModels(): unknown[]; // ModelHandle[]
}
