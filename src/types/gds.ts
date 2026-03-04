/**
 * GDSII Type Definitions
 * Coordinate system: Database units (converted to micrometers for display)
 */

export interface Point {
  x: number;
  y: number;
}

export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Polygon {
  id: string;
  layer: number;
  datatype: number;
  points: Point[];
  boundingBox: BoundingBox;
}

export interface TextElement {
  id: string;
  layer: number;
  texttype: number;
  position: Point;
  string: string;
  width?: number;
  mag?: number;
}

export interface Cell {
  name: string;
  polygons: Polygon[];
  texts: TextElement[];
  boundingBox: BoundingBox;
}

export interface Layer {
  layer: number;
  datatype: number;
  name?: string;
  color: string;
  visible: boolean;
}

export interface GDSDocument {
  name: string;
  cells: Map<string, Cell>;
  layers: Map<string, Layer>; // Key: "layer:datatype"
  topCells: string[];
  boundingBox: BoundingBox;
  units: {
    database: number; // Database unit in meters (e.g., 1e-9 for nm)
    user: number; // User unit in meters (e.g., 1e-6 for um)
  };
}

/**
 * Layer Stack Configuration for 3D extrusion
 */
export interface LayerStackEntry {
  /**
   * Optional stable identifier for a render entry.
   * When absent, the viewer uses `${layer}:${datatype}` (or an auto-generated
   * suffix when multiple entries share the same source).
   */
  id?: string;
  layer: number;
  datatype: number;
  name?: string;
  /**
   * Optional initial visibility override. If unset, layer classification defaults apply.
   */
  visible?: boolean;
  /**
   * Optional grouping hint for UI organization (e.g. "METALS", "DIEL").
   */
  group?: string;
  /**
   * Optional source selector. When unset, the entry source defaults to `layer/datatype`.
   * This enables multiple render entries to reference the same CAD layer.
   */
  source?: {
    layer: number;
    datatype: number;
  };
  /** Thickness in micrometers */
  thickness: number;
  /** Z offset from substrate in micrometers */
  zOffset: number;
  /** Hex color (e.g., "#ff9d9d") */
  color: string;
  /** Material properties (optional, for future use) */
  material?: {
    opacity?: number;
    metallic?: boolean;
    lypTransparent?: boolean;
    lypOutline?: boolean;
    lypDitherPattern?: string;
    lypWidth?: number;
    lypXfill?: boolean;
  };
}

export interface LayerStackConfig {
  /** Layer definitions with 3D extrusion parameters */
  layers: LayerStackEntry[];
  /** Unit for thickness/zOffset values (default: "um") */
  units?: "um" | "nm" | "mm";
  /** Default thickness for layers not in config */
  defaultThickness?: number;
  /** Default color for layers not in config */
  defaultColor?: string;
}

/**
 * Process stack format for physical layer definitions.
 * This can be converted to LayerStackConfig for rendering.
 */
export interface ProcessStackLayer {
  /** Optional stable identifier (e.g., "metal1") */
  id?: string;
  /** GDS layer number */
  layer: number;
  /** GDS datatype */
  datatype: number;
  /** Human-readable name */
  name: string;
  /** Layer bottom (z-min) in stack units */
  zMin: number;
  /** Physical thickness in stack units */
  thickness: number;
  /** Optional display color */
  color?: string;
  /** Optional initial visibility */
  visible?: boolean;
  /** Optional material properties */
  material?: LayerStackEntry["material"];
}

export interface ProcessStackConfig {
  /** Optional format marker for forward compatibility */
  format?: "gds-viewer-process-stack@1";
  /** Unit for zMin/thickness values (default: "um") */
  units?: "um" | "nm" | "mm";
  /** Default thickness for missing entries */
  defaultThickness?: number;
  /** Default color for layers without explicit color */
  defaultColor?: string;
  /** Physical layer definitions */
  layers: ProcessStackLayer[];
}

export interface DerivedGeometryLayerRef {
  layer: number;
  datatype: number;
}

export interface DerivedGeometryCadLayer {
  gds: DerivedGeometryLayerRef;
  role?: string;
}

export interface DerivedGeometryMaterialDisplay {
  color?: string;
  opacity?: number;
  metallic?: boolean;
}

export interface DerivedGeometryMaterial {
  display?: DerivedGeometryMaterialDisplay;
}

export interface DerivedGeometryParam {
  nominal: number;
  pm?: number;
  units: "nm" | "um" | "mm" | "deg";
}

export interface DerivedGeometryMaskRef {
  cad: string;
  alignment?: string;
}

export type DerivedGeometryMask =
  | DerivedGeometryMaskRef
  | { ref: string }
  | { op: "and" | "or"; args: DerivedGeometryMask[] }
  | { op: "not"; arg: DerivedGeometryMask };

export interface DerivedGeometryThicknessRef {
  ref: string;
}

export type DerivedGeometryThickness = number | DerivedGeometryThicknessRef;

export interface DerivedGeometryBaseSlab {
  id: string;
  type: "slab";
  material: string;
  thickness: DerivedGeometryThickness;
}

export interface DerivedGeometryDepositStep {
  id: string;
  type: "deposit";
  material: string;
  thickness: DerivedGeometryThickness;
  pattern?: {
    mask: DerivedGeometryMask;
  };
}

export interface DerivedGeometryEtchStep {
  id: string;
  type: "etch";
  targetMaterial: string;
  depth: "through" | DerivedGeometryThickness;
  sidewallAngleDeg?: DerivedGeometryThickness;
  stopOn?: {
    material: string;
  };
  mask: DerivedGeometryMask;
}

export type DerivedGeometryProcessStep =
  | DerivedGeometryDepositStep
  | DerivedGeometryEtchStep;

export interface DerivedGeometryAlignmentRule {
  reference: string;
  typicalOverlay?: number;
  maxOverlay?: number;
  units: "nm" | "um" | "mm";
}

export interface DerivedGeometryUiGroup {
  id: string;
  label: string;
}

export interface DerivedGeometryRenderSolid {
  id: string;
  uiGroup?: string;
  from: { material: string } | { steps: string[] };
}

export interface DerivedGeometryOutputs {
  uiGroups?: DerivedGeometryUiGroup[];
  renderSolids?: DerivedGeometryRenderSolid[];
}

export interface DerivedGeometrySchema {
  format: "gds-viewer-derived-geometry@1";
  units?: {
    xy?: "um" | "nm" | "mm";
    z?: "um" | "nm" | "mm";
  };
  cadLayers: Record<string, DerivedGeometryCadLayer>;
  masks?: Record<string, DerivedGeometryMask>;
  materials?: Record<string, DerivedGeometryMaterial>;
  params?: Record<string, DerivedGeometryParam>;
  alignment?: Record<string, DerivedGeometryAlignmentRule>;
  process: {
    baseStack?: DerivedGeometryBaseSlab[];
    steps?: DerivedGeometryProcessStep[];
  };
  outputs?: DerivedGeometryOutputs;
}

/**
 * Create a layer key from layer and datatype
 */
export function layerKey(layer: number, datatype: number): string {
  return `${layer}:${datatype}`;
}
