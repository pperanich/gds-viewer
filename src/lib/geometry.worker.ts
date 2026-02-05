import earcut from "earcut";
import type {
  LayerStackConfig,
  LayerStackEntry,
  Polygon,
} from "../types/gds";
import type { SerializedGDSDocument } from "./gdsSerialization";
import { classifyLayer } from "./LayerClassifier";

interface BuildGeometryOptions {
  zScale?: number;
}

interface GeometryLayerPayload {
  layerKey: string;
  layer: number;
  datatype: number;
  layerType: string;
  defaultVisible: boolean;
  color: string;
  opacity: number;
  isTransparent: boolean;
  renderOrder: number;
  polygonOffsetFactor: number;
  polygonOffsetUnits: number;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

interface LayerBuildData {
  entry: LayerStackEntry;
  classification: ReturnType<typeof classifyLayer>;
  positions: number[];
  normals: number[];
  indices: number[];
}

function buildLayerMap(config: LayerStackConfig): Map<string, LayerStackEntry> {
  const map = new Map<string, LayerStackEntry>();
  for (const entry of config.layers) {
    const key = `${entry.layer}:${entry.datatype}`;
    map.set(key, entry);
  }
  return map;
}

function getUnitScale(units: string): number {
  switch (units) {
    case "nm":
      return 0.001;
    case "mm":
      return 1000;
    case "um":
    default:
      return 1;
  }
}

function generateLayerColor(layer: number, datatype: number): string {
  const hue = (layer * 137 + datatype * 53) % 360;
  const saturation = 70;
  const lightness = 60;

  const h = hue / 360;
  const s = saturation / 100;
  const l = lightness / 100;

  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  const r = Math.round(hue2rgb(p, q, h + 1 / 3) * 255);
  const g = Math.round(hue2rgb(p, q, h) * 255);
  const b = Math.round(hue2rgb(p, q, h - 1 / 3) * 255);

  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function addExtrudedPolygon(
  polygon: Polygon,
  entry: LayerStackEntry,
  dbToUm: number,
  unitScale: number,
  zScale: number,
  target: LayerBuildData,
) {
  const points = polygon.points;
  if (points.length < 3) return;

  const vertices: number[] = [];
  for (const p of points) {
    vertices.push(p.x * dbToUm, p.y * dbToUm);
  }

  const triangles = earcut(vertices, [], 2);
  if (triangles.length === 0) return;

  const thickness = entry.thickness * unitScale * zScale;
  const zOffset = entry.zOffset * unitScale * zScale;

  const numPoints = points.length;
  const vertexOffset = {
    bottom: 0,
    top: numPoints,
  };

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < numPoints; i++) {
    const p = points[i]!;
    const x = p.x * dbToUm;
    const y = p.y * dbToUm;
    positions.push(x, y, zOffset);
    normals.push(0, 0, -1);
  }

  for (let i = 0; i < numPoints; i++) {
    const p = points[i]!;
    const x = p.x * dbToUm;
    const y = p.y * dbToUm;
    positions.push(x, y, zOffset + thickness);
    normals.push(0, 0, 1);
  }

  for (let i = 0; i < triangles.length; i += 3) {
    indices.push(
      vertexOffset.bottom + triangles[i + 2]!,
      vertexOffset.bottom + triangles[i + 1]!,
      vertexOffset.bottom + triangles[i]!,
    );
  }

  for (let i = 0; i < triangles.length; i += 3) {
    indices.push(
      vertexOffset.top + triangles[i]!,
      vertexOffset.top + triangles[i + 1]!,
      vertexOffset.top + triangles[i + 2]!,
    );
  }

  for (let i = 0; i < numPoints; i++) {
    const i0 = i;
    const i1 = (i + 1) % numPoints;
    const p0 = points[i0]!;
    const p1 = points[i1]!;

    const x0 = p0.x * dbToUm;
    const y0 = p0.y * dbToUm;
    const x1 = p1.x * dbToUm;
    const y1 = p1.y * dbToUm;

    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy);
    const nx = len > 0 ? dy / len : 0;
    const ny = len > 0 ? -dx / len : 0;

    const baseIdx = positions.length / 3;

    positions.push(x0, y0, zOffset);
    positions.push(x1, y1, zOffset);
    positions.push(x1, y1, zOffset + thickness);
    positions.push(x0, y0, zOffset + thickness);

    for (let j = 0; j < 4; j++) {
      normals.push(nx, ny, 0);
    }

    indices.push(baseIdx, baseIdx + 1, baseIdx + 2);
    indices.push(baseIdx, baseIdx + 2, baseIdx + 3);
  }

  const baseIndex = target.positions.length / 3;
  target.positions.push(...positions);
  target.normals.push(...normals);
  for (const index of indices) {
    target.indices.push(index + baseIndex);
  }
}

self.onmessage = (event: MessageEvent) => {
  const { type, document, layerStack, options } = event.data as {
    type: string;
    document: SerializedGDSDocument;
    layerStack: LayerStackConfig;
    options?: BuildGeometryOptions;
  };

  if (type !== "build") return;

  try {
    const layerMap = buildLayerMap(layerStack);
    const unitScale = getUnitScale(layerStack.units ?? "um");
    const dbToUm = document.units.database / 1e-6;
    const zScale = options?.zScale ?? 1;

    const layerData = new Map<string, LayerBuildData>();

    for (const [, cell] of document.cells) {
      for (const polygon of cell.polygons) {
        const key = `${polygon.layer}:${polygon.datatype}`;
        let entry = layerMap.get(key);
        let data = layerData.get(key);

        if (!data) {
          const layerName = entry?.name ?? `Layer ${polygon.layer}/${polygon.datatype}`;
          const classification = classifyLayer(polygon.layer, polygon.datatype, layerName);

          if (!entry) {
            const fallbackColor = classification.isAnnotation
              ? "#333333"
              : (layerStack.defaultColor ?? generateLayerColor(polygon.layer, polygon.datatype));

            const baseZOffset = classification.zOrder * 0.01;

            entry = {
              layer: polygon.layer,
              datatype: polygon.datatype,
              name: layerName,
              thickness: layerStack.defaultThickness ?? 0.1,
              zOffset: baseZOffset,
              color: fallbackColor,
            };
          }

          data = {
            entry,
            classification,
            positions: [],
            normals: [],
            indices: [],
          };
          layerData.set(key, data);
        }

        addExtrudedPolygon(polygon, data.entry, dbToUm, unitScale, zScale, data);
      }
    }

    const sortedLayers = Array.from(layerData.entries()).sort((a, b) => {
      const zA = a[1].entry.zOffset ?? 0;
      const zB = b[1].entry.zOffset ?? 0;
      return zA - zB;
    });

    const payloads: GeometryLayerPayload[] = [];

    for (let i = 0; i < sortedLayers.length; i++) {
      const [key, data] = sortedLayers[i]!;
      if (data.indices.length === 0) continue;

      const opacity = data.entry.material?.opacity ?? data.classification.defaultOpacity;
      const isTransparent = opacity < 1;

      payloads.push({
        layerKey: key,
        layer: data.entry.layer,
        datatype: data.entry.datatype,
        layerType: data.classification.type,
        defaultVisible: data.classification.defaultVisible,
        color: data.entry.color,
        opacity,
        isTransparent,
        renderOrder: isTransparent ? 1000 + i : i,
        polygonOffsetFactor: -i * 0.1,
        polygonOffsetUnits: -i,
        positions: new Float32Array(data.positions),
        normals: new Float32Array(data.normals),
        indices: new Uint32Array(data.indices),
      });
    }

    const transferables: Transferable[] = [];
    for (const payload of payloads) {
      const positionBuffer = payload.positions.buffer;
      const normalBuffer = payload.normals.buffer;
      const indexBuffer = payload.indices.buffer;

      transferables.push(
        positionBuffer instanceof ArrayBuffer ? positionBuffer : payload.positions,
        normalBuffer instanceof ArrayBuffer ? normalBuffer : payload.normals,
        indexBuffer instanceof ArrayBuffer ? indexBuffer : payload.indices,
      );
    }

    self.postMessage({ type: "complete", layers: payloads }, transferables);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    self.postMessage({ type: "error", error: message });
  }
};
