import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import earcut from "earcut";
import * as PolygonOps from "./PolygonOps";
import type { Region, Ring } from "./PolygonOps";
import type {
  DerivedGeometryBaseSlab,
  DerivedGeometryDepositStep,
  DerivedGeometryEtchStep,
  DerivedGeometrySchema,
  DerivedGeometryThickness,
  DerivedGeometryMask,
  DerivedGeometryMaskRef,
  GDSDocument,
  LayerStackConfig,
  LayerStackEntry,
  Polygon,
} from "../types/gds";
import { classifyLayer } from "./LayerClassifier";
import { getUnitScale } from "./GeometryBuilder";
import { isDerivedGeometrySchema } from "./DerivedGeometry";

type OverlayMode = "nominal" | "typical" | "max";

interface Solid {
  id: string;
  name: string;
  material: string;
  group?: string;
  sourceCadId: string;
  regionKind: "die-area" | "mask";
  region: Region;
  zOffset: number;
  thickness: number;
  display: {
    color: string;
    opacity?: number;
    metallic?: boolean;
  };
}

export interface DerivedModelBuildResult {
  group: THREE.Group;
  layerStack: LayerStackConfig;
  uiGroups: Map<string, string>;
  warnings: string[];
}

function getZUnits(schema: DerivedGeometrySchema): "um" | "nm" | "mm" {
  const z = schema.units?.z;
  if (z === "nm" || z === "mm" || z === "um") return z;
  return "um";
}

function getXyUnits(schema: DerivedGeometrySchema): "um" | "nm" | "mm" {
  const xy = schema.units?.xy;
  if (xy === "nm" || xy === "mm" || xy === "um") return xy;
  return "um";
}

function toZUnits(
  value: number,
  from: "nm" | "um" | "mm",
  to: "nm" | "um" | "mm",
): number {
  if (from === to) return value;
  const valueUm =
    from === "um" ? value : from === "nm" ? value * 0.001 : value * 1000;
  return to === "um" ? valueUm : to === "nm" ? valueUm / 0.001 : valueUm / 1000;
}

function toXyUnits(
  value: number,
  from: "nm" | "um" | "mm",
  to: "nm" | "um" | "mm",
): number {
  if (from === to) return value;
  const valueUm =
    from === "um" ? value : from === "nm" ? value * 0.001 : value * 1000;
  return to === "um" ? valueUm : to === "nm" ? valueUm / 0.001 : valueUm / 1000;
}

function resolveThickness(
  thickness: DerivedGeometryThickness,
  schema: DerivedGeometrySchema,
  zUnits: "nm" | "um" | "mm",
  warnings: string[],
): number {
  if (typeof thickness === "number") return thickness;
  const ref = thickness.ref;
  const param = schema.params?.[ref];
  if (!param) {
    warnings.push(`Missing param ref: ${ref}`);
    return 0;
  }
  if (param.units === "deg") {
    warnings.push(`Param ref ${ref} has units=deg; ignoring for thickness.`);
    return 0;
  }
  return toZUnits(param.nominal, param.units, zUnits);
}

function ringArea(ring: Ring): number {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i]!;
    const [x1, y1] = ring[(i + 1) % ring.length]!;
    area += x0 * y1 - x1 * y0;
  }
  return area / 2;
}

function normalizeRing(ring: Ring): Ring {
  if (ring.length > 1) {
    const [x0, y0] = ring[0]!;
    const [x1, y1] = ring[ring.length - 1]!;
    if (Math.abs(x0 - x1) < 1e-12 && Math.abs(y0 - y1) < 1e-12) {
      return ring.slice(0, -1);
    }
  }
  return ring;
}

function ensureOrientation(ring: Ring, clockwise: boolean): Ring {
  const normalized = normalizeRing(ring);
  const area = ringArea(normalized);
  const isClockwise = area < 0;
  if (isClockwise === clockwise) return normalized;
  return [...normalized].reverse();
}

function getCadIdByRole(schema: DerivedGeometrySchema, role: string): string | null {
  for (const [id, layer] of Object.entries(schema.cadLayers)) {
    if (layer.role === role) return id;
  }
  return null;
}

function buildUiGroupLabels(schema: DerivedGeometrySchema): Map<string, string> {
  const labels = new Map<string, string>();
  for (const group of schema.outputs?.uiGroups ?? []) {
    labels.set(group.id, group.label);
  }
  return labels;
}

function buildOutputSelections(schema: DerivedGeometrySchema): {
  includeMaterials: Set<string> | null;
  includeSteps: Set<string> | null;
  stepToGroup: Map<string, string>;
  materialToGroup: Map<string, string>;
} {
  const renderSolids = schema.outputs?.renderSolids;
  if (!renderSolids || renderSolids.length === 0) {
    return {
      includeMaterials: null,
      includeSteps: null,
      stepToGroup: new Map(),
      materialToGroup: new Map(),
    };
  }

  const includeMaterials = new Set<string>();
  const includeSteps = new Set<string>();
  const stepToGroup = new Map<string, string>();
  const materialToGroup = new Map<string, string>();

  for (const solid of renderSolids) {
    if ("material" in solid.from) {
      includeMaterials.add(solid.from.material);
      if (solid.uiGroup) materialToGroup.set(solid.from.material, solid.uiGroup);
      continue;
    }
    for (const stepId of solid.from.steps) {
      includeSteps.add(stepId);
      if (solid.uiGroup) stepToGroup.set(stepId, solid.uiGroup);
    }
  }

  return { includeMaterials, includeSteps, stepToGroup, materialToGroup };
}

function polygonToRing(polygon: Polygon, dbToUm: number): Ring {
  return polygon.points.map((p) => [p.x * dbToUm, p.y * dbToUm] as [number, number]);
}

function getRingsForGdsLayer(
  document: GDSDocument,
  layer: number,
  datatype: number,
  dbToUm: number,
): Ring[] {
  const rings: Ring[] = [];
  for (const cell of document.cells.values()) {
    for (const polygon of cell.polygons) {
      if (polygon.layer !== layer || polygon.datatype !== datatype) continue;
      const ring = polygonToRing(polygon, dbToUm);
      if (ring.length >= 3) rings.push(ring);
    }
  }
  return rings;
}

function getCadRings(
  document: GDSDocument,
  schema: DerivedGeometrySchema,
  cadId: string,
  dbToUm: number,
  warnings: string[],
): Ring[] {
  const cad = schema.cadLayers[cadId];
  if (!cad) {
    warnings.push(`Unknown CAD layer: ${cadId}`);
    return [];
  }
  return getRingsForGdsLayer(document, cad.gds.layer, cad.gds.datatype, dbToUm);
}

function resolveOverlayBufferUmLeaf(
  mask: DerivedGeometryMaskRef,
  schema: DerivedGeometrySchema,
  overlayMode: OverlayMode,
  warnings: string[],
): number {
  if (overlayMode === "nominal") return 0;
  const alignmentId = mask.alignment;
  if (!alignmentId) return 0;
  const rule = schema.alignment?.[alignmentId];
  if (!rule) {
    warnings.push(`Unknown alignment rule "${alignmentId}" referenced by mask CAD "${mask.cad}".`);
    return 0;
  }
  const overlay =
    overlayMode === "max" ? rule.maxOverlay ?? rule.typicalOverlay : rule.typicalOverlay;
  if (!overlay || overlay <= 0) return 0;
  const xyUnits = getXyUnits(schema);
  const overlayInXy = toXyUnits(overlay, rule.units, xyUnits);
  return toXyUnits(overlayInXy, xyUnits, "um");
}

function getCadRegion(
  document: GDSDocument,
  schema: DerivedGeometrySchema,
  cadId: string,
  dbToUm: number,
  warnings: string[],
): Region {
  const rings = getCadRings(document, schema, cadId, dbToUm, warnings);
  return PolygonOps.fromRings(rings);
}

function evaluateMaskRegion(
  mask: DerivedGeometryMask,
  dieAreaRegion: Region,
  document: GDSDocument,
  schema: DerivedGeometrySchema,
  dbToUm: number,
  overlayMode: OverlayMode,
  warnings: string[],
  visitedRefs: Set<string> = new Set(),
): { region: Region; primaryCadId: string | null } {
  if (typeof mask !== "object" || mask === null) {
    return { region: [], primaryCadId: null };
  }

  if ("cad" in mask && typeof mask.cad === "string") {
    const cadId = mask.cad;
    const base = getCadRegion(document, schema, cadId, dbToUm, warnings);
    const bufferUm = resolveOverlayBufferUmLeaf(mask as DerivedGeometryMaskRef, schema, overlayMode, warnings);
    const buffered = bufferUm > 0 ? PolygonOps.bufferApprox(base, bufferUm) : base;
    return {
      region: PolygonOps.intersect(buffered, dieAreaRegion),
      primaryCadId: cadId,
    };
  }

  if ("ref" in mask && typeof mask.ref === "string") {
    const ref = mask.ref;
    if (visitedRefs.has(ref)) {
      warnings.push(`Mask ref cycle detected: ${ref}`);
      return { region: [], primaryCadId: null };
    }
    visitedRefs.add(ref);
    const resolved = schema.masks?.[ref];
    if (!resolved) {
      warnings.push(`Unknown mask ref "${ref}"`);
      return { region: [], primaryCadId: null };
    }
    return evaluateMaskRegion(
      resolved,
      dieAreaRegion,
      document,
      schema,
      dbToUm,
      overlayMode,
      warnings,
      visitedRefs,
    );
  }

  if ("op" in mask && mask.op === "not" && "arg" in mask) {
    const arg = (mask as { arg: DerivedGeometryMask }).arg;
    const evaluated = evaluateMaskRegion(
      arg,
      dieAreaRegion,
      document,
      schema,
      dbToUm,
      overlayMode,
      warnings,
      visitedRefs,
    );
    return {
      region: PolygonOps.difference(dieAreaRegion, evaluated.region),
      primaryCadId: evaluated.primaryCadId,
    };
  }

  if ("op" in mask && (mask.op === "and" || mask.op === "or") && "args" in mask) {
    const op = mask.op as "and" | "or";
    const args = (mask as { args: DerivedGeometryMask[] }).args ?? [];
    const evaluatedArgs = args.map((a) =>
      evaluateMaskRegion(
        a,
        dieAreaRegion,
        document,
        schema,
        dbToUm,
        overlayMode,
        warnings,
        visitedRefs,
      ),
    );
    let region: Region = op === "and" ? dieAreaRegion : [];
    for (const e of evaluatedArgs) {
      region = op === "and" ? PolygonOps.intersect(region, e.region) : PolygonOps.union(region, e.region);
    }
    const primaryCadId = evaluatedArgs.find((e) => e.primaryCadId)?.primaryCadId ?? null;
    return { region, primaryCadId };
  }

  warnings.push("Unsupported mask expression node; ignoring.");
  return { region: [], primaryCadId: null };
}

function getDieAreaRegion(
  document: GDSDocument,
  schema: DerivedGeometrySchema,
  dbToUm: number,
  warnings: string[],
): { cadId: string; region: Region } {
  const cadId =
    getCadIdByRole(schema, "die-area") ?? (schema.cadLayers["DIEAREA"] ? "DIEAREA" : "");

  if (cadId) {
    const rings = getCadRings(document, schema, cadId, dbToUm, warnings);
    if (rings.length > 0) {
      return {
        cadId,
        region: PolygonOps.fromRings(rings),
      };
    }
  }

  const bounds = document.boundingBox;
  const minX = bounds.minX * dbToUm;
  const minY = bounds.minY * dbToUm;
  const maxX = bounds.maxX * dbToUm;
  const maxY = bounds.maxY * dbToUm;
  warnings.push(
    'Die-area CAD layer not found; using document bounding box as die area.',
  );
  return {
    cadId: "DIEAREA",
    region: [
      {
        outer: ensureOrientation(
          [
            [minX, minY],
            [maxX, minY],
            [maxX, maxY],
            [minX, maxY],
          ],
          false,
        ),
        holes: [],
      },
    ],
  };
}

function pickMaterialDisplay(
  schema: DerivedGeometrySchema,
  materialId: string,
): { color: string; opacity?: number; metallic?: boolean } {
  const display = schema.materials?.[materialId]?.display;
  return {
    color: display?.color ?? "#c0c0c0",
    opacity: display?.opacity,
    metallic: display?.metallic,
  };
}

function shouldIncludeSolid(
  solid: Solid,
  selections: ReturnType<typeof buildOutputSelections>,
): boolean {
  const byMaterial =
    selections.includeMaterials === null ||
    selections.includeMaterials.has(solid.material);
  if (byMaterial) return true;

  const byStep =
    selections.includeSteps !== null &&
    solid.id.startsWith("step:") &&
    selections.includeSteps.has(solid.id.slice("step:".length));
  return byStep;
}

function createExtrudedGeometryFromRegion(
  region: Region,
  entry: LayerStackEntry,
  unitScale: number,
  zScale: number,
): THREE.BufferGeometry | null {
  const geometries: THREE.BufferGeometry[] = [];

  for (const polygon of region) {
    const geometry = createExtrudedGeometryFromPolygon(
      polygon.outer,
      polygon.holes,
      entry,
      unitScale,
      zScale,
    );
    if (geometry) geometries.push(geometry);
  }

  if (geometries.length === 0) return null;
  if (geometries.length === 1) return geometries[0]!;

  const merged = mergeGeometries(geometries, false);
  if (!merged) {
    for (const geom of geometries) geom.dispose();
    return null;
  }
  for (const geom of geometries) {
    if (geom !== merged) geom.dispose();
  }
  return merged;
}

function createExtrudedGeometryFromPolygon(
  outerRing: Ring,
  holeRings: Ring[],
  entry: LayerStackEntry,
  unitScale: number,
  zScale: number,
): THREE.BufferGeometry | null {
  const outer = ensureOrientation(outerRing, false);
  const holes = holeRings.map((h) => ensureOrientation(h, true));
  if (outer.length < 3) return null;

  const vertices2d: number[] = [];
  const holeIndices: number[] = [];

  function pushRing(ring: Ring) {
    for (const [x, y] of ring) {
      vertices2d.push(x, y);
    }
  }

  pushRing(outer);
  for (const hole of holes) {
    holeIndices.push(vertices2d.length / 2);
    pushRing(hole);
  }

  const triangles = earcut(vertices2d, holeIndices, 2);
  if (triangles.length === 0) return null;

  const thickness = entry.thickness * unitScale * zScale;
  const zOffset = entry.zOffset * unitScale * zScale;

  const geometry = new THREE.BufferGeometry();
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  const numVerts = vertices2d.length / 2;
  const vertexOffset = {
    bottom: 0,
    top: numVerts,
  };

  for (let i = 0; i < numVerts; i++) {
    const x = vertices2d[i * 2]!;
    const y = vertices2d[i * 2 + 1]!;
    positions.push(x, y, zOffset);
    normals.push(0, 0, -1);
  }
  for (let i = 0; i < numVerts; i++) {
    const x = vertices2d[i * 2]!;
    const y = vertices2d[i * 2 + 1]!;
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

  function addSideWalls(ring: Ring) {
    const points = ring;
    for (let i = 0; i < points.length; i++) {
      const [x0, y0] = points[i]!;
      const [x1, y1] = points[(i + 1) % points.length]!;

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
  }

  addSideWalls(outer);
  for (const hole of holes) {
    addSideWalls(hole);
  }

  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);

  return geometry;
}

function buildBaseSlabSolids(
  base: DerivedGeometryBaseSlab[],
  dieArea: { cadId: string; region: Region },
  schema: DerivedGeometrySchema,
  zUnits: "nm" | "um" | "mm",
  selections: ReturnType<typeof buildOutputSelections>,
  warnings: string[],
): { solids: Solid[]; zCursor: number } {
  const solids: Solid[] = [];
  let zCursor = 0;

  for (const slab of base) {
    const thickness = resolveThickness(slab.thickness, schema, zUnits, warnings);
    const display = pickMaterialDisplay(schema, slab.material);
    const group = selections.materialToGroup.get(slab.material);
    solids.push({
      id: `base:${slab.id}`,
      name: slab.id,
      material: slab.material,
      group,
      sourceCadId: dieArea.cadId,
      regionKind: "die-area",
      region: dieArea.region,
      zOffset: zCursor,
      thickness,
      display,
    });
    zCursor += thickness;
  }

  return { solids, zCursor };
}

function buildDepositSolids(
  steps: Array<DerivedGeometryDepositStep | DerivedGeometryEtchStep>,
  startZ: number,
  dieArea: { cadId: string; region: Region },
  document: GDSDocument,
  schema: DerivedGeometrySchema,
  dbToUm: number,
  zUnits: "nm" | "um" | "mm",
  overlayMode: OverlayMode,
  selections: ReturnType<typeof buildOutputSelections>,
  warnings: string[],
): { solids: Solid[]; zCursor: number } {
  const solids: Solid[] = [];
  let zCursor = startZ;

  for (const step of steps) {
    if (step.type !== "deposit") continue;
    const thickness = resolveThickness(step.thickness, schema, zUnits, warnings);

    let region: Region = dieArea.region;
    let sourceCadId = dieArea.cadId;
    if (step.pattern !== undefined) {
      const evaluated = evaluateMaskRegion(
        step.pattern.mask,
        dieArea.region,
        document,
        schema,
        dbToUm,
        overlayMode,
        warnings,
      );
      region = evaluated.region;
      sourceCadId = evaluated.primaryCadId ?? dieArea.cadId;
      if (PolygonOps.isEmpty(region)) {
        warnings.push(`No polygons found for deposit mask (step ${step.id}).`);
      }
    }

    const display = pickMaterialDisplay(schema, step.material);
    const group =
      selections.stepToGroup.get(step.id) ?? selections.materialToGroup.get(step.material);
    solids.push({
      id: `step:${step.id}`,
      name: step.id,
      material: step.material,
      group,
      sourceCadId,
      regionKind: step.pattern ? "mask" : "die-area",
      region,
      zOffset: zCursor,
      thickness,
      display,
    });
    zCursor += thickness;
  }

  return { solids, zCursor };
}

function applyEtchSteps(
  solids: Solid[],
  steps: Array<DerivedGeometryDepositStep | DerivedGeometryEtchStep>,
  dieAreaRegion: Region,
  document: GDSDocument,
  schema: DerivedGeometrySchema,
  dbToUm: number,
  zUnits: "nm" | "um" | "mm",
  overlayMode: OverlayMode,
  selections: ReturnType<typeof buildOutputSelections>,
  warnings: string[],
): Solid[] {
  let current = [...solids];

  for (const step of steps) {
    if (step.type !== "etch") continue;

    const maskEval = evaluateMaskRegion(
      step.mask,
      dieAreaRegion,
      document,
      schema,
      dbToUm,
      overlayMode,
      warnings,
    );
    const maskCadId = maskEval.primaryCadId ?? "MASK";
    let maskRegion = maskEval.region;
    if (PolygonOps.isEmpty(maskRegion)) continue;

    const depth =
      step.depth === "through"
        ? Infinity
        : resolveThickness(step.depth, schema, zUnits, warnings);

    if (step.stopOn?.material) {
      const stopMaterial = step.stopOn.material;
      const stopRegion = PolygonOps.unionMany(
        current.filter((s) => s.material === stopMaterial).map((s) => s.region),
      );
      if (PolygonOps.isEmpty(stopRegion)) {
        warnings.push(
          `Etch step ${step.id} has stopOn.material=${stopMaterial} but no solids with that material were present; applying etch mask as-is.`,
        );
      } else {
        maskRegion = PolygonOps.intersect(maskRegion, stopRegion);
      }
    }

    if (PolygonOps.isEmpty(maskRegion)) continue;

    const next: Solid[] = [];
    for (const solid of current) {
      if (solid.material !== step.targetMaterial) {
        next.push(solid);
        continue;
      }

      const outsideRegion = PolygonOps.difference(solid.region, maskRegion);
      const insideRegion = PolygonOps.intersect(solid.region, maskRegion);

      if (!PolygonOps.isEmpty(outsideRegion)) {
        next.push({
          ...solid,
          region: outsideRegion,
        });
      }

      const insideThickness = depth === Infinity ? 0 : Math.max(0, solid.thickness - depth);
      if (!PolygonOps.isEmpty(insideRegion) && insideThickness > 1e-12) {
        const display = solid.display;
        const group = selections.materialToGroup.get(solid.material) ?? solid.group;
        next.push({
          id: `${solid.id}@${step.id}`,
          name: `${solid.name} (${step.id})`,
          material: solid.material,
          group,
          sourceCadId: maskCadId,
          regionKind: "mask",
          region: insideRegion,
          zOffset: solid.zOffset,
          thickness: insideThickness,
          display,
        });
      }
    }

    current = next;
  }

  return current;
}

function solidsToLayerStack(
  schema: DerivedGeometrySchema,
  solids: Solid[],
  dieAreaCadId: string,
  zUnits: "nm" | "um" | "mm",
): LayerStackConfig {
  const layers: LayerStackEntry[] = [];

  for (const solid of solids) {
    const cad = schema.cadLayers[solid.sourceCadId] ?? schema.cadLayers[dieAreaCadId];
    const layer = cad?.gds.layer ?? 0;
    const datatype = cad?.gds.datatype ?? 0;

    layers.push({
      id: solid.id,
      name: solid.name,
      group: solid.group,
      layer,
      datatype,
      source: { layer, datatype },
      thickness: solid.thickness,
      zOffset: solid.zOffset,
      color: solid.display.color,
      material: {
        opacity: solid.display.opacity,
        metallic: solid.display.metallic,
      },
    });
  }

  return {
    layers,
    units: zUnits,
    defaultThickness: 0.2,
    defaultColor: "#c0c0c0",
  };
}

export function buildDerivedModel(
  document: GDSDocument,
  schema: DerivedGeometrySchema,
  options: { zScale?: number; overlayMode?: OverlayMode } = {},
): DerivedModelBuildResult {
  const warnings: string[] = [];
  if (!isDerivedGeometrySchema(schema)) {
    throw new Error(
      'Invalid derived-geometry JSON: expected format "gds-viewer-derived-geometry@1"',
    );
  }

  const dbToUm = document.units.database / 1e-6;
  const zUnits = getZUnits(schema);
  const unitScale = getUnitScale(zUnits);
  const zScale = options.zScale ?? 1;
  const overlayMode: OverlayMode = options.overlayMode ?? "typical";

  const dieArea = getDieAreaRegion(document, schema, dbToUm, warnings);
  const uiGroups = buildUiGroupLabels(schema);
  const selections = buildOutputSelections(schema);

  const baseStack = schema.process.baseStack ?? [];
  const steps = schema.process.steps ?? [];

  const baseResult = buildBaseSlabSolids(
    baseStack,
    dieArea,
    schema,
    zUnits,
    selections,
    warnings,
  );

  const depositResult = buildDepositSolids(
    steps,
    baseResult.zCursor,
    dieArea,
    document,
    schema,
    dbToUm,
    zUnits,
    overlayMode,
    selections,
    warnings,
  );

  const allSolids = [...baseResult.solids, ...depositResult.solids];
  const etchedSolids = applyEtchSteps(
    allSolids,
    steps,
    dieArea.region,
    document,
    schema,
    dbToUm,
    zUnits,
    overlayMode,
    selections,
    warnings,
  );

  const solidsForRender = etchedSolids.filter((s) => shouldIncludeSolid(s, selections));

  const layerStack = solidsToLayerStack(schema, solidsForRender, dieArea.cadId, zUnits);
  const entryById = new Map(
    layerStack.layers
      .filter((l) => l.id)
      .map((l) => [l.id as string, l]),
  );

  const sorted = [...solidsForRender].sort((a, b) => a.zOffset - b.zOffset);
  const root = new THREE.Group();

  for (let i = 0; i < sorted.length; i++) {
    const solid = sorted[i]!;
    const entry = entryById.get(solid.id) ?? null;
    if (!entry) continue;

    const geometry = createExtrudedGeometryFromRegion(
      solid.region,
      entry,
      unitScale,
      zScale,
    );
    if (!geometry) continue;

    const classification = classifyLayer(
      entry.layer,
      entry.datatype,
      entry.name ?? entry.id ?? "",
    );
    const layerType = classification.type;
    const opacity = entry.material?.opacity;
    const effectiveOpacity = opacity ?? 1;
    const isTransparent = effectiveOpacity < 0.999;

    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(entry.color),
      side: THREE.DoubleSide,
      transparent: isTransparent,
      opacity: effectiveOpacity,
      depthWrite: !isTransparent,
      polygonOffset: true,
      polygonOffsetFactor: -i * 0.1,
      polygonOffsetUnits: -i,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData = {
      layerKey: entry.id ?? `${entry.layer}:${entry.datatype}`,
      layer: entry.layer,
      datatype: entry.datatype,
      layerType,
      lypTransparent: false,
      lypOutline: false,
    };
    mesh.visible = entry.visible ?? classification.defaultVisible;
    mesh.renderOrder = i;
    root.add(mesh);
  }

  return {
    group: root,
    layerStack,
    uiGroups,
    warnings,
  };
}
