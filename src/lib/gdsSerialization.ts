import type { BoundingBox, Cell, GDSDocument, Layer } from "../types/gds";

export interface SerializedGDSDocument {
  name: string;
  cells: [string, Cell][];
  layers: [string, Layer][];
  topCells: string[];
  boundingBox: BoundingBox;
  units: { database: number; user: number };
}

export function serializeGDSDocument(document: GDSDocument): SerializedGDSDocument {
  return {
    name: document.name,
    cells: Array.from(document.cells.entries()),
    layers: Array.from(document.layers.entries()),
    topCells: document.topCells,
    boundingBox: document.boundingBox,
    units: document.units,
  };
}

export function deserializeGDSDocument(data: SerializedGDSDocument): GDSDocument {
  return {
    name: data.name,
    cells: new Map(data.cells),
    layers: new Map(data.layers),
    topCells: data.topCells,
    boundingBox: data.boundingBox,
    units: data.units,
  };
}
