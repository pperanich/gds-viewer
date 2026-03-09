import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import earcut from "earcut";
import GeometryWorker from "./geometry.worker.ts?worker&inline";
import { getUnitScale, type GeometryLayerPayload } from "./GeometryCommon";
import { buildGeometryPayload } from "./GeometryPayloadBuilder";
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
  flatMode?: boolean;
  flatModeThresholdBytes?: number;
}

export type { GeometryLayerPayload } from "./GeometryCommon";

interface LayerBuildData {
  geometries: THREE.BufferGeometry[];
  entry: LayerStackEntry;
  classification: ReturnType<typeof classifyLayer>;
  extentUm?: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
}

export function buildGeometry(
  document: GDSDocument,
  layerStack: LayerStackConfig,
  options: BuildGeometryOptions = {}
): THREE.Group {
  if (options.flatMode || options.flatModeThresholdBytes !== undefined) {
    return buildGeometryFromPayload(
      buildGeometryPayload(document, layerStack, {
        zScale: options.zScale,
        mode: options.flatMode ? "flat" : "auto",
        flatModeThresholdBytes: options.flatModeThresholdBytes,
      }).layers,
    );
  }

  const root = new THREE.Group();
  const entriesBySourceKey = buildEntriesBySourceKey(layerStack);
  const unitScale = getUnitScale(layerStack.units ?? "um");
  const dbToUm = document.units.database / 1e-6;
  const zScale = options.zScale ?? 1;

  const layerData = new Map<string, LayerBuildData>();
  const defaultThickness = layerStack.defaultThickness ?? 0.1;
  let maxConfiguredZOffset = -defaultThickness * 1.1;
  for (const layerEntry of layerStack.layers) {
    const zOffset = layerEntry.zOffset ?? 0;
    if (zOffset > maxConfiguredZOffset) {
      maxConfiguredZOffset = zOffset;
    }
  }
  let nextFallbackZOffset = maxConfiguredZOffset + defaultThickness * 1.1;
  const fallbackEntries = new Map<
    string,
    {
      renderKey: string;
      entry: LayerStackEntry;
    }
  >();

  for (const cell of document.cells.values()) {
    for (const polygon of cell.polygons) {
      const sourceKey = `${polygon.layer}:${polygon.datatype}`;
      const renderEntries = entriesBySourceKey.get(sourceKey);
      const entries =
        renderEntries && renderEntries.length > 0
          ? renderEntries
          : [
              (() => {
                const existingFallback = fallbackEntries.get(sourceKey);
                if (existingFallback) return existingFallback;

                const layerName =
                  document.layers.get(sourceKey)?.name ||
                  `Layer ${polygon.layer}/${polygon.datatype}`;
                const classification = classifyLayer(
                  polygon.layer,
                  polygon.datatype,
                  layerName,
                );
                const fallbackColor = classification.isAnnotation
                  ? "#333333"
                  : (layerStack.defaultColor ??
                    generateLayerColor(polygon.layer, polygon.datatype));

                const entry: LayerStackEntry = {
                  layer: polygon.layer,
                  datatype: polygon.datatype,
                  name: layerName,
                  thickness: defaultThickness,
                  zOffset: nextFallbackZOffset,
                  color: fallbackColor,
                };
                nextFallbackZOffset += defaultThickness * 1.1;

                const fallback = { renderKey: sourceKey, entry };
                fallbackEntries.set(sourceKey, fallback);
                return fallback;
              })(),
            ];

      for (const { renderKey, entry } of entries) {
        let data = layerData.get(renderKey);
        if (!data) {
          const layerName =
            document.layers.get(sourceKey)?.name ||
            `Layer ${polygon.layer}/${polygon.datatype}`;
          const displayName = entry.name ?? layerName;
          const classification = classifyLayer(
            polygon.layer,
            polygon.datatype,
            displayName,
          );
          data = { geometries: [], entry, classification };
          layerData.set(renderKey, data);
        }

        const isOutlineLayer =
          data.classification.type === "boundary" ||
          data.entry.material?.lypOutline === true;
        if (isOutlineLayer) {
          data.extentUm = expandExtentFromPolygon(data.extentUm, polygon, dbToUm);
          continue;
        }

        const geometry = createExtrudedGeometry(
          polygon,
          data.entry,
          dbToUm,
          unitScale,
          zScale,
        );
        if (geometry) {
          data.geometries.push(geometry);
        }
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
    const isOutlineLayer =
      data.classification.type === "boundary" ||
      data.entry.material?.lypOutline === true;
    const geometry = isOutlineLayer
      ? createLayerExtentGeometry(data.extentUm, data.entry, unitScale, zScale)
      : data.geometries.length === 1
        ? data.geometries[0]!
        : mergeGeometries(data.geometries, false);

    if (!geometry) {
      for (const geom of data.geometries) {
        geom.dispose();
      }
      continue;
    }

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

    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData = {
      layerKey: key,
      layer: data.entry.layer,
      datatype: data.entry.datatype,
      layerType: data.classification.type,
      lypTransparent: data.entry.material?.lypTransparent === true,
      lypOutline: isOutlineLayer,
      lypDitherPattern: data.entry.material?.lypDitherPattern,
      lypWidth: data.entry.material?.lypWidth,
      lypXfill: data.entry.material?.lypXfill,
    };
    mesh.visible = data.entry.visible ?? data.classification.defaultVisible;
    mesh.renderOrder = i;
    root.add(mesh);

    for (const geom of data.geometries) {
      if (geom !== geometry) {
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
      options: {
        zScale: options.zScale,
        mode: options.flatMode ? "flat" : "auto",
        flatModeThresholdBytes: options.flatModeThresholdBytes,
      },
    });
  });
}

export function buildGeometryFromPayload(layers: GeometryLayerPayload[]): THREE.Group {
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
      lypTransparent: layer.lypTransparent,
      lypOutline: layer.layerType === "boundary" || layer.lypOutline,
      lypDitherPattern: layer.lypDitherPattern,
      lypWidth: layer.lypWidth,
      lypXfill: layer.lypXfill,
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
    const sourceLayer = entry.source?.layer ?? entry.layer;
    const sourceDatatype = entry.source?.datatype ?? entry.datatype;
    const key = `${sourceLayer}:${sourceDatatype}`;
    const existing = map.get(key);
    if (!existing || entry.zOffset >= existing.zOffset) {
      map.set(key, entry);
    }
  }
  return map;
}

function buildEntriesBySourceKey(
  config: LayerStackConfig,
): Map<string, Array<{ renderKey: string; entry: LayerStackEntry }>> {
  const bySource = new Map<
    string,
    Array<{ renderKey: string; entry: LayerStackEntry }>
  >();
  const usedKeys = new Set<string>();

  function uniqueKey(base: string): string {
    if (!usedKeys.has(base)) {
      usedKeys.add(base);
      return base;
    }
    let i = 2;
    while (usedKeys.has(`${base}#${i}`)) i++;
    const key = `${base}#${i}`;
    usedKeys.add(key);
    return key;
  }

  for (const entry of config.layers) {
    const sourceLayer = entry.source?.layer ?? entry.layer;
    const sourceDatatype = entry.source?.datatype ?? entry.datatype;
    const sourceKey = `${sourceLayer}:${sourceDatatype}`;
    const baseRenderKey = (entry.id && entry.id.trim()) || sourceKey;
    const renderKey = uniqueKey(baseRenderKey);
    const list = bySource.get(sourceKey) ?? [];
    list.push({ renderKey, entry });
    bySource.set(sourceKey, list);
  }

  return bySource;
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

function expandExtentFromPolygon(
  current:
    | {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
      }
    | undefined,
  polygon: Polygon,
  dbToUm: number,
): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const bounds = polygon.boundingBox;
  const minX = bounds.minX * dbToUm;
  const minY = bounds.minY * dbToUm;
  const maxX = bounds.maxX * dbToUm;
  const maxY = bounds.maxY * dbToUm;

  if (!current) {
    return { minX, minY, maxX, maxY };
  }

  return {
    minX: Math.min(current.minX, minX),
    minY: Math.min(current.minY, minY),
    maxX: Math.max(current.maxX, maxX),
    maxY: Math.max(current.maxY, maxY),
  };
}

function createLayerExtentGeometry(
  extent:
    | {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
      }
    | undefined,
  entry: LayerStackEntry,
  unitScale: number,
  zScale: number
): THREE.BufferGeometry | null {
  if (!extent) return null;

  const width = extent.maxX - extent.minX;
  const height = extent.maxY - extent.minY;
  if (width <= 1e-12 || height <= 1e-12) return null;

  const z = (entry.zOffset + entry.thickness) * unitScale * zScale + 1e-4;

  const geometry = new THREE.BufferGeometry();
  const positions = [
    extent.minX,
    extent.minY,
    z,
    extent.maxX,
    extent.minY,
    z,
    extent.maxX,
    extent.maxY,
    z,
    extent.minX,
    extent.maxY,
    z,
  ];
  const normals = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
  const indices = [0, 1, 2, 0, 2, 3];

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
