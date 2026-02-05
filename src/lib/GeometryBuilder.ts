import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import earcut from "earcut";
import GeometryWorker from "./geometry.worker.ts?worker&inline";
import type {
  GDSDocument,
  Polygon,
  LayerStackConfig,
  LayerStackEntry,
} from "../types/gds";
import { classifyLayer } from "./LayerClassifier";
import { serializeGDSDocument } from "./gdsSerialization";

export interface BuildGeometryOptions {
  zScale?: number;
}

export interface GeometryLayerPayload {
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
  geometries: THREE.BufferGeometry[];
  entry: LayerStackEntry;
  classification: ReturnType<typeof classifyLayer>;
}

export function buildGeometry(
  document: GDSDocument,
  layerStack: LayerStackConfig,
  options: BuildGeometryOptions = {}
): THREE.Group {
  const root = new THREE.Group();
  const layerMap = buildLayerMap(layerStack);
  const unitScale = getUnitScale(layerStack.units ?? "um");
  const dbToUm = document.units.database / 1e-6;
  const zScale = options.zScale ?? 1;

  const layerData = new Map<string, LayerBuildData>();

  for (const cell of document.cells.values()) {
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
        
        data = { geometries: [], entry, classification };
        layerData.set(key, data);
      }

      const geometry = createExtrudedGeometry(polygon, data.entry, dbToUm, unitScale, zScale);
      if (geometry) {
        data.geometries.push(geometry);
      }
    }

  }

  const sortedLayers = Array.from(layerData.entries()).sort((a, b) => {
    const zA = a[1].entry.zOffset ?? 0;
    const zB = b[1].entry.zOffset ?? 0;
    return zA - zB;
  });

  for (let i = 0; i < sortedLayers.length; i++) {
    const [key, data] = sortedLayers[i]!;
    if (data.geometries.length === 0) continue;

    const mergedGeometry = data.geometries.length === 1
      ? data.geometries[0]!
      : mergeGeometries(data.geometries, false);

    if (!mergedGeometry) continue;

    const color = new THREE.Color(data.entry.color);
    const opacity = data.entry.material?.opacity ?? data.classification.defaultOpacity;
    const isTransparent = opacity < 1;
    
    const material = new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      transparent: isTransparent,
      opacity,
      depthWrite: !isTransparent,
      polygonOffset: true,
      polygonOffsetFactor: -i * 0.1,
      polygonOffsetUnits: -i,
    });

    const mesh = new THREE.Mesh(mergedGeometry, material);
    mesh.userData = {
      layerKey: key,
      layer: data.entry.layer,
      datatype: data.entry.datatype,
      layerType: data.classification.type,
    };
    mesh.visible = data.classification.defaultVisible;
    mesh.renderOrder = isTransparent ? 1000 + i : i;
    root.add(mesh);

    for (const geom of data.geometries) {
      if (geom !== mergedGeometry) {
        geom.dispose();
      }
    }
  }

  return root;
}

export async function buildGeometryAsync(
  document: GDSDocument,
  layerStack: LayerStackConfig,
  options: BuildGeometryOptions = {}
): Promise<THREE.Group> {
  if (typeof Worker === "undefined") {
    return buildGeometry(document, layerStack, options);
  }

  return new Promise((resolve) => {
    const worker = new GeometryWorker();

    worker.onmessage = (event: MessageEvent) => {
      const { type, layers, error } = event.data as {
        type: string;
        layers?: GeometryLayerPayload[];
        error?: string;
      };

      if (type === "complete" && layers) {
        worker.terminate();
        resolve(buildGeometryFromPayload(layers));
      } else if (type === "error") {
        worker.terminate();
        console.warn("Geometry worker failed, falling back to main thread:", error);
        resolve(buildGeometry(document, layerStack, options));
      }
    };

    worker.onerror = (event: ErrorEvent) => {
      worker.terminate();
      console.warn(
        "Geometry worker crashed, falling back to main thread:",
        event.message
      );
      resolve(buildGeometry(document, layerStack, options));
    };

    const serialized = serializeGDSDocument(document);
    worker.postMessage({
      type: "build",
      document: serialized,
      layerStack,
      options,
    });
  });
}

function buildGeometryFromPayload(layers: GeometryLayerPayload[]): THREE.Group {
  const root = new THREE.Group();

  for (const layer of layers) {
    if (layer.indices.length === 0) continue;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(layer.positions, 3),
    );
    geometry.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute(layer.normals, 3),
    );
    geometry.setIndex(new THREE.Uint32BufferAttribute(layer.indices, 1));

    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(layer.color),
      side: THREE.DoubleSide,
      transparent: layer.isTransparent,
      opacity: layer.opacity,
      depthWrite: !layer.isTransparent,
      polygonOffset: true,
      polygonOffsetFactor: layer.polygonOffsetFactor,
      polygonOffsetUnits: layer.polygonOffsetUnits,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData = {
      layerKey: layer.layerKey,
      layer: layer.layer,
      datatype: layer.datatype,
      layerType: layer.layerType,
    };
    mesh.visible = layer.defaultVisible;
    mesh.renderOrder = layer.renderOrder;
    root.add(mesh);
  }

  return root;
}

export function buildLayerMap(config: LayerStackConfig): Map<string, LayerStackEntry> {
  const map = new Map<string, LayerStackEntry>();
  for (const entry of config.layers) {
    const key = `${entry.layer}:${entry.datatype}`;
    map.set(key, entry);
  }
  return map;
}

export function getUnitScale(units: string): number {
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

function createExtrudedGeometry(
  polygon: Polygon,
  entry: LayerStackEntry,
  dbToUm: number,
  unitScale: number,
  zScale: number
): THREE.BufferGeometry | null {
  const points = polygon.points;
  if (points.length < 3) return null;

  const vertices: number[] = [];
  const holes: number[] = [];

  for (const p of points) {
    vertices.push(p.x * dbToUm, p.y * dbToUm);
  }

  const triangles = earcut(vertices, holes, 2);
  if (triangles.length === 0) return null;

  const thickness = entry.thickness * unitScale * zScale;
  const zOffset = entry.zOffset * unitScale * zScale;

  const geometry = new THREE.BufferGeometry();
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  const numPoints = points.length;
  const vertexOffset = {
    bottom: 0,
    top: numPoints,
    sides: numPoints * 2,
  };

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
      vertexOffset.bottom + triangles[i]!
    );
  }

  for (let i = 0; i < triangles.length; i += 3) {
    indices.push(
      vertexOffset.top + triangles[i]!,
      vertexOffset.top + triangles[i + 1]!,
      vertexOffset.top + triangles[i + 2]!
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

  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3)
  );
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);

  return geometry;
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
