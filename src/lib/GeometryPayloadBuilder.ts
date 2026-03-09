import earcut from "earcut";
import type { GDSDocument, Layer, LayerStackConfig, LayerStackEntry, Polygon } from "../types/gds";
import { classifyLayer, type LayerType } from "./LayerClassifier";
import { generateLayerColor, getDefaultThicknessForType, getUnitScale, type GeometryLayerPayload } from "./GeometryCommon";

export type GeometryRenderMode = "extruded" | "flat";

export interface GeometryComplexityStats {
  polygonCount: number;
  pointCount: number;
  activeLayerCount: number;
  estimated3DBytes: number;
  estimated2DBytes: number;
  chosenMode: GeometryRenderMode;
  modeReason: "explicit-flat" | "explicit-extruded" | "threshold" | "hard-limit";
  exceedsHardLimit: boolean;
}

export interface GeometryPayloadBuildOptions {
  zScale?: number;
  mode?: GeometryRenderMode | "auto";
  flatModeThresholdBytes?: number;
  hardLimitBytes?: number;
  hardLimitPointCount?: number;
  allowExtremeExtruded?: boolean;
  includeRenderKeys?: string[];
  deferHiddenLayers?: boolean;
  progressBase?: number;
  progressSpan?: number;
  onProgress?: (progress: number, message: string, phase?: string) => void;
}

export interface GeometryRenderEntryInfo {
  renderKey: string;
  sourceKey: string;
  layer: number;
  datatype: number;
  name: string;
  zOffset: number;
  color: string;
  defaultVisible: boolean;
  group?: string;
  layerType: LayerType;
  isAnnotation: boolean;
}

export interface GeometryPayloadBuildResult {
  layers: GeometryLayerPayload[];
  layerStack: LayerStackConfig;
  stats: GeometryComplexityStats;
  renderEntries: GeometryRenderEntryInfo[];
  buildableRenderKeys: string[];
  deferredRenderKeys: string[];
}

interface LayerBuildData {
  entry: LayerStackEntry;
  classification: ReturnType<typeof classifyLayer>;
  positions: number[];
  normals: number[];
  indices: number[];
  extentUm?: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
}

const DEFAULT_FLAT_THRESHOLD_BYTES = 256 * 1024 * 1024;
const DEFAULT_HARD_LIMIT_BYTES = 512 * 1024 * 1024;
const DEFAULT_HARD_LIMIT_POINT_COUNT = 4_000_000;

interface ResolvedRenderEntry {
  renderKey: string;
  sourceKey: string;
  layer: number;
  datatype: number;
  entry: LayerStackEntry | null;
  classification: ReturnType<typeof classifyLayer>;
  name: string;
  zOffset: number;
  color: string;
  defaultVisible: boolean;
  group?: string;
}

function report(
  options: GeometryPayloadBuildOptions,
  progress: number,
  message: string,
  phase: string = "building-geometry",
) {
  options.onProgress?.(progress, message, phase);
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

function resolveRenderEntries(
  documentLayers: Iterable<[string, Layer]>,
  config: LayerStackConfig,
): ResolvedRenderEntry[] {
  const entriesBySource = buildEntriesBySourceKey(config);
  const documentLayerMap = new Map(documentLayers);
  const defaultThickness = config.defaultThickness ?? 0.1;
  let maxConfiguredZOffset = -defaultThickness * 1.1;
  for (const entry of config.layers) {
    if (entry.zOffset > maxConfiguredZOffset) {
      maxConfiguredZOffset = entry.zOffset;
    }
  }
  let nextFallbackZOffset = maxConfiguredZOffset + defaultThickness * 1.1;
  const results: ResolvedRenderEntry[] = [];
  const seenSourceKeys = new Set<string>();

  for (const [sourceKey, layer] of documentLayerMap) {
    seenSourceKeys.add(sourceKey);
    const renderEntries = entriesBySource.get(sourceKey);
    if (renderEntries && renderEntries.length > 0) {
      for (const { renderKey, entry } of renderEntries) {
        const name = entry.name ?? layer.name ?? sourceKey;
        const classification = classifyLayer(layer.layer, layer.datatype, name);
        results.push({
          renderKey,
          sourceKey,
          layer: layer.layer,
          datatype: layer.datatype,
          entry,
          classification,
          name,
          zOffset: entry.zOffset,
          color: entry.color,
          defaultVisible: entry.visible ?? classification.defaultVisible,
          group: entry.group,
        });
      }
      continue;
    }

    const name = layer.name ?? sourceKey;
    const classification = classifyLayer(layer.layer, layer.datatype, name);
    const color =
      layer.color ||
      (classification.isAnnotation
        ? "#333333"
        : (config.defaultColor ?? generateLayerColor(layer.layer, layer.datatype)));
    results.push({
      renderKey: sourceKey,
      sourceKey,
      layer: layer.layer,
      datatype: layer.datatype,
      entry: null,
      classification,
      name,
      zOffset: nextFallbackZOffset,
      color,
      defaultVisible: layer.visible ?? classification.defaultVisible,
      group: undefined,
    });
    nextFallbackZOffset += defaultThickness * 1.1;
  }

  for (const [sourceKey, renderEntries] of entriesBySource) {
    if (seenSourceKeys.has(sourceKey)) continue;
    const [layerStr, datatypeStr] = sourceKey.split(":");
    const layer = parseInt(layerStr ?? "0", 10);
    const datatype = parseInt(datatypeStr ?? "0", 10);

    for (const { renderKey, entry } of renderEntries) {
      const name = entry.name ?? renderKey;
      const classification = classifyLayer(layer, datatype, name);
      results.push({
        renderKey,
        sourceKey,
        layer,
        datatype,
        entry,
        classification,
        name,
        zOffset: entry.zOffset,
        color: entry.color,
        defaultVisible: entry.visible ?? classification.defaultVisible,
        group: entry.group,
      });
    }
  }

  return results.sort((a, b) => a.zOffset - b.zOffset);
}

export function buildGeometryRenderEntries(
  documentLayers: Iterable<[string, Layer]>,
  config: LayerStackConfig,
): GeometryRenderEntryInfo[] {
  return resolveRenderEntries(documentLayers, config).map((entry) => ({
    renderKey: entry.renderKey,
    sourceKey: entry.sourceKey,
    layer: entry.layer,
    datatype: entry.datatype,
    name: entry.name,
    zOffset: entry.zOffset,
    color: entry.color,
    defaultVisible: entry.defaultVisible,
    group: entry.group,
    layerType: entry.classification.type,
    isAnnotation: entry.classification.isAnnotation,
  }));
}

export function createDefaultLayerStack(document: GDSDocument): LayerStackConfig {
  const layers: LayerStackEntry[] = [];
  let zOffset = 0;
  const defaultThickness = 0.2;

  for (const layer of document.layers.values()) {
    const classification = classifyLayer(layer.layer, layer.datatype, layer.name);
    const thickness = getDefaultThicknessForType(classification.type, defaultThickness);
    const color =
      layer.color ||
      (classification.isAnnotation ? "#333333" : generateLayerColor(layer.layer, layer.datatype));
    layers.push({
      layer: layer.layer,
      datatype: layer.datatype,
      name: layer.name,
      thickness,
      zOffset,
      color,
      visible: classification.defaultVisible,
    });
    zOffset += thickness * 1.1;
  }

  return {
    layers,
    defaultThickness,
    defaultColor: "#c0c0c0",
    units: "um",
  };
}

export function estimateGeometryComplexity(
  document: GDSDocument,
): Omit<GeometryComplexityStats, "chosenMode" | "modeReason" | "exceedsHardLimit"> {
  let polygonCount = 0;
  let pointCount = 0;

  for (const cell of document.cells.values()) {
    for (const polygon of cell.polygons) {
      polygonCount += 1;
      pointCount += polygon.points.length;
    }
  }

  let estimated3DBytes = 0;
  let estimated2DBytes = 0;
  for (const cell of document.cells.values()) {
    for (const polygon of cell.polygons) {
      const n = polygon.points.length;
      if (n < 3) continue;
      const topTriangles = Math.max(0, n - 2);
      const extrudedVertices = n * 6;
      const flatVertices = n;
      const extrudedIndices = topTriangles * 6 + n * 6;
      const flatIndices = topTriangles * 3;
      estimated3DBytes += extrudedVertices * 24 + extrudedIndices * 4;
      estimated2DBytes += flatVertices * 24 + flatIndices * 4;
    }
  }

  return {
    polygonCount,
    pointCount,
    activeLayerCount: document.layers.size,
    estimated3DBytes,
    estimated2DBytes,
  };
}

function chooseRenderMode(
  stats: Omit<GeometryComplexityStats, "chosenMode" | "modeReason" | "exceedsHardLimit">,
  options: GeometryPayloadBuildOptions,
): Pick<GeometryComplexityStats, "chosenMode" | "modeReason" | "exceedsHardLimit"> {
  const hardLimitBytes = options.hardLimitBytes ?? DEFAULT_HARD_LIMIT_BYTES;
  const hardLimitPointCount = options.hardLimitPointCount ?? DEFAULT_HARD_LIMIT_POINT_COUNT;
  const exceedsHardLimit =
    stats.estimated3DBytes >= hardLimitBytes || stats.pointCount >= hardLimitPointCount;

  if (options.mode === "flat") {
    return {
      chosenMode: "flat",
      modeReason: "explicit-flat",
      exceedsHardLimit,
    };
  }

  if (options.mode === "extruded") {
    if (exceedsHardLimit && !options.allowExtremeExtruded) {
      return {
        chosenMode: "flat",
        modeReason: "hard-limit",
        exceedsHardLimit: true,
      };
    }
    return {
      chosenMode: "extruded",
      modeReason: "explicit-extruded",
      exceedsHardLimit,
    };
  }

  if (exceedsHardLimit) {
    return {
      chosenMode: "flat",
      modeReason: "hard-limit",
      exceedsHardLimit: true,
    };
  }

  const threshold = options.flatModeThresholdBytes ?? DEFAULT_FLAT_THRESHOLD_BYTES;
  return {
    chosenMode: stats.estimated3DBytes >= threshold ? "flat" : "extruded",
    modeReason: "threshold",
    exceedsHardLimit: false,
  };
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
  for (const point of points) {
    vertices.push(point.x * dbToUm, point.y * dbToUm);
  }

  const triangles = earcut(vertices, [], 2);
  if (triangles.length === 0) return;

  const thickness = entry.thickness * unitScale * zScale;
  const zOffset = entry.zOffset * unitScale * zScale;
  const numPoints = points.length;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const vertexOffset = {
    bottom: 0,
    top: numPoints,
  };

  for (let i = 0; i < numPoints; i++) {
    const point = points[i]!;
    const x = point.x * dbToUm;
    const y = point.y * dbToUm;
    positions.push(x, y, zOffset);
    normals.push(0, 0, -1);
  }

  for (let i = 0; i < numPoints; i++) {
    const point = points[i]!;
    const x = point.x * dbToUm;
    const y = point.y * dbToUm;
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
    const p0 = points[i]!;
    const p1 = points[(i + 1) % numPoints]!;
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

function addFlatPolygon(
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
  for (const point of points) {
    vertices.push(point.x * dbToUm, point.y * dbToUm);
  }

  const triangles = earcut(vertices, [], 2);
  if (triangles.length === 0) return;
  const z = (entry.zOffset + entry.thickness) * unitScale * zScale + 1e-4;

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < points.length; i++) {
    const point = points[i]!;
    positions.push(point.x * dbToUm, point.y * dbToUm, z);
    normals.push(0, 0, 1);
  }

  for (let i = 0; i < triangles.length; i += 3) {
    indices.push(triangles[i]!, triangles[i + 1]!, triangles[i + 2]!);
  }

  const baseIndex = target.positions.length / 3;
  target.positions.push(...positions);
  target.normals.push(...normals);
  for (const index of indices) {
    target.indices.push(index + baseIndex);
  }
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
  if (!current) return { minX, minY, maxX, maxY };
  return {
    minX: Math.min(current.minX, minX),
    minY: Math.min(current.minY, minY),
    maxX: Math.max(current.maxX, maxX),
    maxY: Math.max(current.maxY, maxY),
  };
}

function createLayerExtentData(
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
  zScale: number,
): { positions: number[]; normals: number[]; indices: number[] } | null {
  if (!extent) return null;
  const width = extent.maxX - extent.minX;
  const height = extent.maxY - extent.minY;
  if (width <= 1e-12 || height <= 1e-12) return null;
  const z = (entry.zOffset + entry.thickness) * unitScale * zScale + 1e-4;
  return {
    positions: [
      extent.minX, extent.minY, z,
      extent.maxX, extent.minY, z,
      extent.maxX, extent.maxY, z,
      extent.minX, extent.maxY, z,
    ],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2, 0, 2, 3],
  };
}

export function buildGeometryPayload(
  document: GDSDocument,
  config: LayerStackConfig,
  options: GeometryPayloadBuildOptions = {},
): GeometryPayloadBuildResult {
  const base = options.progressBase ?? 0;
  const span = options.progressSpan ?? 100;
  report(options, base, "Starting geometry build");

  const statsBase = estimateGeometryComplexity(document);
  const modeDecision = chooseRenderMode(statsBase, options);
  const stats: GeometryComplexityStats = {
    ...statsBase,
    chosenMode: modeDecision.chosenMode,
    modeReason: modeDecision.modeReason,
    exceedsHardLimit: modeDecision.exceedsHardLimit,
  };

  const resolvedRenderEntries = resolveRenderEntries(document.layers.entries(), config);
  const includeRenderKeys = options.includeRenderKeys
    ? new Set(options.includeRenderKeys)
    : null;
  const deferredRenderKeys: string[] = [];
  const entriesBySourceKey = new Map<string, ResolvedRenderEntry[]>();
  for (const entry of resolvedRenderEntries) {
    const included = includeRenderKeys
      ? includeRenderKeys.has(entry.renderKey)
      : !(options.deferHiddenLayers && !entry.defaultVisible);
    if (!included) {
      deferredRenderKeys.push(entry.renderKey);
      continue;
    }
    const list = entriesBySourceKey.get(entry.sourceKey) ?? [];
    list.push(entry);
    entriesBySourceKey.set(entry.sourceKey, list);
  }

  const unitScale = getUnitScale(config.units ?? "um");
  const dbToUm = document.units.database / 1e-6;
  const zScale = options.zScale ?? 1;
  const layerData = new Map<string, LayerBuildData>();
  const polygonSourceKeys = new Set<string>();

  const totalPolygons = Math.max(1, stats.polygonCount);
  let processedPolygons = 0;

  for (const cell of document.cells.values()) {
    for (const polygon of cell.polygons) {
      processedPolygons += 1;
      if (processedPolygons === 1 || processedPolygons % 2000 === 0) {
        const progress = base + Math.floor((processedPolygons / totalPolygons) * span * 0.8);
        report(
          options,
          Math.min(base + span - 5, progress),
          `Building ${stats.chosenMode} geometry...`,
        );
      }

      const sourceKey = `${polygon.layer}:${polygon.datatype}`;
      polygonSourceKeys.add(sourceKey);
      const entries = entriesBySourceKey.get(sourceKey);
      if (!entries || entries.length === 0) {
        continue;
      }

      for (const resolvedEntry of entries) {
        const { renderKey } = resolvedEntry;
        let data = layerData.get(renderKey);
        if (!data) {
          const classification = resolvedEntry.classification;
          const entry = resolvedEntry.entry ?? {
            layer: resolvedEntry.layer,
            datatype: resolvedEntry.datatype,
            name: resolvedEntry.name,
            thickness: getDefaultThicknessForType(
              classification.type,
              config.defaultThickness ?? 0.1,
            ),
            zOffset: resolvedEntry.zOffset,
            color: resolvedEntry.color,
            visible: resolvedEntry.defaultVisible,
          };
          data = {
            entry,
            classification,
            positions: [],
            normals: [],
            indices: [],
          };
          layerData.set(renderKey, data);
        }

        const isOutlineLayer =
          data.classification.type === "boundary" ||
          data.entry.material?.lypOutline === true;

        if (isOutlineLayer) {
          data.extentUm = expandExtentFromPolygon(data.extentUm, polygon, dbToUm);
        } else if (stats.chosenMode === "flat") {
          addFlatPolygon(polygon, data.entry, dbToUm, unitScale, zScale, data);
        } else {
          addExtrudedPolygon(polygon, data.entry, dbToUm, unitScale, zScale, data);
        }
      }
    }
  }

  const sortedLayers = Array.from(layerData.entries()).sort(
    (a, b) => (a[1].entry.zOffset ?? 0) - (b[1].entry.zOffset ?? 0),
  );

  const layers: GeometryLayerPayload[] = [];
  report(options, base + Math.floor(span * 0.85), "Finalizing geometry payloads");
  for (let i = 0; i < sortedLayers.length; i++) {
    const [key, data] = sortedLayers[i]!;
    const isOutlineLayer =
      data.classification.type === "boundary" ||
      data.entry.material?.lypOutline === true;
    const extentData = isOutlineLayer
      ? createLayerExtentData(data.extentUm, data.entry, unitScale, zScale)
      : null;
    const positions = extentData?.positions ?? data.positions;
    const normals = extentData?.normals ?? data.normals;
    const indices = extentData?.indices ?? data.indices;
    if (indices.length === 0) continue;
    const opacity = data.entry.material?.opacity ?? data.classification.defaultOpacity;
    const isTransparent = opacity < 1;
    layers.push({
      layerKey: key,
      layer: data.entry.layer,
      datatype: data.entry.datatype,
      layerType: data.classification.type,
      lypTransparent: data.entry.material?.lypTransparent === true,
      lypOutline: isOutlineLayer,
      lypDitherPattern: data.entry.material?.lypDitherPattern,
      lypWidth: data.entry.material?.lypWidth,
      lypXfill: data.entry.material?.lypXfill,
      defaultVisible: data.entry.visible ?? data.classification.defaultVisible,
      color: data.entry.color,
      opacity,
      isTransparent,
      renderOrder: i,
      polygonOffsetFactor: -i * 0.1,
      polygonOffsetUnits: -i,
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      indices: new Uint32Array(indices),
    });
  }

  report(options, base + span, "Geometry build complete");
  const buildableRenderKeys = resolvedRenderEntries
    .filter((entry) => polygonSourceKeys.has(entry.sourceKey))
    .map((entry) => entry.renderKey);
  return {
    layers,
    layerStack: config,
    stats,
    renderEntries: resolvedRenderEntries.map((entry) => ({
      renderKey: entry.renderKey,
      sourceKey: entry.sourceKey,
      layer: entry.layer,
      datatype: entry.datatype,
      name: entry.name,
      zOffset: entry.zOffset,
      color: entry.color,
      defaultVisible: entry.defaultVisible,
      group: entry.group,
      layerType: entry.classification.type,
      isAnnotation: entry.classification.isAnnotation,
    })),
    buildableRenderKeys,
    deferredRenderKeys: deferredRenderKeys.filter((key) => buildableRenderKeys.includes(key)),
  };
}
