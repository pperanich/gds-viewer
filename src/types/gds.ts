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
  layer: number;
  datatype: number;
  name?: string;
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
 * Create a layer key from layer and datatype
 */
export function layerKey(layer: number, datatype: number): string {
  return `${layer}:${datatype}`;
}
