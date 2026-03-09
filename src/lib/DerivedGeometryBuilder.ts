import earcut from "earcut";
import * as PolygonOps from "./PolygonOps";
import type { Region, Ring } from "./PolygonOps";
import type {
  DerivedGeometryBaseSlab,
  DerivedGeometryDepositStep,
  DerivedGeometryEtchStep,
  DerivedGeometryMask,
  DerivedGeometryMaskRef,
  DerivedGeometrySchema,
  DerivedGeometryThickness,
  GDSDocument,
  LayerStackConfig,
  LayerStackEntry,
  Polygon,
} from "../types/gds";
import { classifyLayer } from "./LayerClassifier";
import { getUnitScale, type GeometryLayerPayload } from "./GeometryCommon";
import { isDerivedGeometrySchema } from "./DerivedGeometry";

export type OverlayMode = "nominal" | "typical" | "max";

interface Solid {
  id: string;
  name: string;
  material: string;
  group?: string;
  sourceCadId: string;
  regionKind: "die-area" | "mask";
  region: Region;
  zMin: number;
  zMax: number;
  display: {
    color: string;
    opacity?: number;
    metallic?: boolean;
  };
  originStepIds: string[];
}

interface MaskEvaluationResult {
  region: Region;
  primaryCadId: string | null;
}

interface BuildContext {
  document: GDSDocument;
  schema: DerivedGeometrySchema;
  dbToUm: number;
  overlayMode: OverlayMode;
  warnings: string[];
  cadRegionCache: Map<string, Region>;
  maskRegionCache: Map<string, MaskEvaluationResult>;
  ringsBySourceKey: Map<string, Polygon[]>;
}

interface EtchBudget {
  region: Region;
  remainingDepth: number;
  stopZ: number;
}

interface StopBand {
  region: Region;
  zTop: number;
}

export interface DerivedGeometryBuildResult {
  layers: GeometryLayerPayload[];
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

function buildRingsBySourceKey(document: GDSDocument): Map<string, Polygon[]> {
  const byKey = new Map<string, Polygon[]>();
  for (const cell of document.cells.values()) {
    for (const polygon of cell.polygons) {
      const key = `${polygon.layer}:${polygon.datatype}`;
      const list = byKey.get(key) ?? [];
      list.push(polygon);
      byKey.set(key, list);
    }
  }
  return byKey;
}

function getCadRings(
  context: BuildContext,
  cadId: string,
): Ring[] {
  const cad = context.schema.cadLayers[cadId];
  if (!cad) {
    context.warnings.push(`Unknown CAD layer: ${cadId}`);
    return [];
  }
  const key = `${cad.gds.layer}:${cad.gds.datatype}`;
  const polygons = context.ringsBySourceKey.get(key) ?? [];
  return polygons.map((polygon) => polygonToRing(polygon, context.dbToUm));
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

function getCadRegion(context: BuildContext, cadId: string): Region {
  const cached = context.cadRegionCache.get(cadId);
  if (cached) return cached;
  const region = PolygonOps.fromRings(getCadRings(context, cadId));
  context.cadRegionCache.set(cadId, region);
  return region;
}

function stableMaskKey(mask: DerivedGeometryMask): string {
  return JSON.stringify(mask);
}

function evaluateMaskRegion(
  mask: DerivedGeometryMask,
  dieAreaRegion: Region,
  context: BuildContext,
  visitedRefs: Set<string> = new Set(),
): MaskEvaluationResult {
  const cacheKey = `${context.overlayMode}:${stableMaskKey(mask)}`;
  const cached = context.maskRegionCache.get(cacheKey);
  if (cached) return cached;

  let result: MaskEvaluationResult;

  if (typeof mask !== "object" || mask === null) {
    result = { region: [], primaryCadId: null };
  } else if ("cad" in mask && typeof mask.cad === "string") {
    const cadId = mask.cad;
    const base = getCadRegion(context, cadId);
    const bufferUm = resolveOverlayBufferUmLeaf(
      mask as DerivedGeometryMaskRef,
      context.schema,
      context.overlayMode,
      context.warnings,
    );
    const buffered = bufferUm > 0 ? PolygonOps.bufferApprox(base, bufferUm) : base;
    result = {
      region: PolygonOps.intersect(buffered, dieAreaRegion),
      primaryCadId: cadId,
    };
  } else if ("ref" in mask && typeof mask.ref === "string") {
    const ref = mask.ref;
    if (visitedRefs.has(ref)) {
      context.warnings.push(`Mask ref cycle detected: ${ref}`);
      result = { region: [], primaryCadId: null };
    } else {
      const resolved = context.schema.masks?.[ref];
      if (!resolved) {
        context.warnings.push(`Unknown mask ref "${ref}"`);
        result = { region: [], primaryCadId: null };
      } else {
        const nextVisited = new Set(visitedRefs);
        nextVisited.add(ref);
        result = evaluateMaskRegion(resolved, dieAreaRegion, context, nextVisited);
      }
    }
  } else if ("op" in mask && mask.op === "not" && "arg" in mask) {
    const evaluated = evaluateMaskRegion(
      mask.arg as DerivedGeometryMask,
      dieAreaRegion,
      context,
      new Set(visitedRefs),
    );
    result = {
      region: PolygonOps.difference(dieAreaRegion, evaluated.region),
      primaryCadId: evaluated.primaryCadId,
    };
  } else if ("op" in mask && (mask.op === "and" || mask.op === "or") && "args" in mask) {
    const op = mask.op as "and" | "or";
    const args = (mask as { args: DerivedGeometryMask[] }).args ?? [];
    const evaluatedArgs = args.map((arg) =>
      evaluateMaskRegion(arg, dieAreaRegion, context, new Set(visitedRefs)),
    );
    let region: Region = op === "and" ? dieAreaRegion : [];
    for (const evaluated of evaluatedArgs) {
      region =
        op === "and"
          ? PolygonOps.intersect(region, evaluated.region)
          : PolygonOps.union(region, evaluated.region);
    }
    result = {
      region,
      primaryCadId: evaluatedArgs.find((entry) => entry.primaryCadId)?.primaryCadId ?? null,
    };
  } else {
    context.warnings.push("Unsupported mask expression node; ignoring.");
    result = { region: [], primaryCadId: null };
  }

  context.maskRegionCache.set(cacheKey, result);
  return result;
}

function getDieAreaRegion(
  context: BuildContext,
): { cadId: string; region: Region } {
  const cadId =
    getCadIdByRole(context.schema, "die-area") ??
    (context.schema.cadLayers["DIEAREA"] ? "DIEAREA" : "");

  if (cadId) {
    const region = getCadRegion(context, cadId);
    if (!PolygonOps.isEmpty(region)) {
      return { cadId, region };
    }
  }

  const bounds = context.document.boundingBox;
  const minX = bounds.minX * context.dbToUm;
  const minY = bounds.minY * context.dbToUm;
  const maxX = bounds.maxX * context.dbToUm;
  const maxY = bounds.maxY * context.dbToUm;
  context.warnings.push(
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
  return (
    selections.includeSteps !== null &&
    solid.originStepIds.some((stepId) => selections.includeSteps?.has(stepId))
  );
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
      zMin: zCursor,
      zMax: zCursor + thickness,
      display,
      originStepIds: [],
    });
    zCursor += thickness;
  }

  return { solids, zCursor };
}

function buildDepositSolids(
  steps: Array<DerivedGeometryDepositStep | DerivedGeometryEtchStep>,
  startZ: number,
  dieArea: { cadId: string; region: Region },
  context: BuildContext,
  zUnits: "nm" | "um" | "mm",
  selections: ReturnType<typeof buildOutputSelections>,
): { solids: Solid[]; zCursor: number } {
  const solids: Solid[] = [];
  let zCursor = startZ;

  for (const step of steps) {
    if (step.type === "etch") {
      if (step.sidewallAngleDeg !== undefined) {
        context.warnings.push(
          `Etch step ${step.id} specifies sidewallAngleDeg, which is currently ignored.`,
        );
      }
      continue;
    }

    const thickness = resolveThickness(step.thickness, context.schema, zUnits, context.warnings);

    let region: Region = dieArea.region;
    let sourceCadId = dieArea.cadId;
    if (step.pattern !== undefined) {
      const evaluated = evaluateMaskRegion(step.pattern.mask, dieArea.region, context);
      region = evaluated.region;
      sourceCadId = evaluated.primaryCadId ?? dieArea.cadId;
      if (PolygonOps.isEmpty(region)) {
        context.warnings.push(`No polygons found for deposit mask (step ${step.id}).`);
      }
    }

    const display = pickMaterialDisplay(context.schema, step.material);
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
      zMin: zCursor,
      zMax: zCursor + thickness,
      display,
      originStepIds: [step.id],
    });
    zCursor += thickness;
  }

  return { solids, zCursor };
}

function solidThickness(solid: Solid): number {
  return Math.max(0, solid.zMax - solid.zMin);
}

function buildStopBands(solids: Solid[]): StopBand[] {
  const byZ = new Map<string, Region[]>();
  for (const solid of solids) {
    const key = solid.zMax.toFixed(12);
    const list = byZ.get(key) ?? [];
    list.push(solid.region);
    byZ.set(key, list);
  }

  return Array.from(byZ.entries())
    .map(([key, regions]) => ({
      zTop: Number(key),
      region: PolygonOps.unionMany(regions),
    }))
    .filter((band) => !PolygonOps.isEmpty(band.region))
    .sort((a, b) => b.zTop - a.zTop);
}

function buildEtchBudgets(
  maskRegion: Region,
  depth: number,
  stopBands: StopBand[],
): EtchBudget[] {
  if (PolygonOps.isEmpty(maskRegion)) return [];
  if (stopBands.length === 0) {
    return [{ region: maskRegion, remainingDepth: depth, stopZ: -Infinity }];
  }

  const budgets: EtchBudget[] = [];
  let uncovered = maskRegion;
  for (const band of stopBands) {
    const overlap = PolygonOps.intersect(uncovered, band.region);
    if (!PolygonOps.isEmpty(overlap)) {
      budgets.push({
        region: overlap,
        remainingDepth: depth,
        stopZ: band.zTop,
      });
      uncovered = PolygonOps.difference(uncovered, band.region);
    }
  }

  if (!PolygonOps.isEmpty(uncovered)) {
    budgets.push({
      region: uncovered,
      remainingDepth: depth,
      stopZ: -Infinity,
    });
  }

  return budgets;
}

function applyBudgetToSolid(
  solid: Solid,
  budgets: EtchBudget[],
  stepId: string,
  maskCadId: string,
  fragmentCounter: { value: number },
): { solids: Solid[]; budgets: EtchBudget[] } {
  const preservedFragments: Solid[] = [];
  const nextBudgets: EtchBudget[] = [];
  let remainingRegion = solid.region;
  const eps = 1e-12;

  for (const budget of budgets) {
    const overlap = PolygonOps.intersect(remainingRegion, budget.region);
    remainingRegion = PolygonOps.difference(remainingRegion, budget.region);
    const budgetRemainder = PolygonOps.difference(budget.region, solid.region);
    if (!PolygonOps.isEmpty(budgetRemainder)) {
      nextBudgets.push({
        ...budget,
        region: budgetRemainder,
      });
    }

    if (PolygonOps.isEmpty(overlap)) {
      continue;
    }

    if (solid.zMax <= budget.stopZ + eps) {
      preservedFragments.push({
        ...solid,
        id: `${solid.id}@${stepId}:frag${fragmentCounter.value++}`,
        sourceCadId: maskCadId,
        regionKind: "mask",
        region: overlap,
      });
      continue;
    }

    const removableThickness = solid.zMax - Math.max(solid.zMin, budget.stopZ);
    if (removableThickness <= eps) {
      preservedFragments.push({
        ...solid,
        id: `${solid.id}@${stepId}:frag${fragmentCounter.value++}`,
        sourceCadId: maskCadId,
        regionKind: "mask",
        region: overlap,
      });
      continue;
    }

    const removeAmount =
      budget.remainingDepth === Infinity
        ? removableThickness
        : Math.min(budget.remainingDepth, removableThickness);
    const keptThickness = solidThickness(solid) - removeAmount;
    if (keptThickness > eps) {
      preservedFragments.push({
        ...solid,
        id: `${solid.id}@${stepId}:frag${fragmentCounter.value++}`,
        name: `${solid.name} (${stepId})`,
        sourceCadId: maskCadId,
        regionKind: "mask",
        region: overlap,
        zMax: solid.zMax - removeAmount,
      });
    }

    if (budget.remainingDepth !== Infinity) {
      const remainingDepth = budget.remainingDepth - removeAmount;
      if (
        remainingDepth > eps &&
        removeAmount >= removableThickness - eps &&
        solid.zMin >= budget.stopZ + eps
      ) {
        nextBudgets.push({
          ...budget,
          region: overlap,
          remainingDepth,
        });
      }
    }
  }

  if (!PolygonOps.isEmpty(remainingRegion)) {
    preservedFragments.push({
      ...solid,
      region: remainingRegion,
    });
  }

  return { solids: preservedFragments, budgets: nextBudgets };
}

function applyEtchSteps(
  solids: Solid[],
  steps: Array<DerivedGeometryDepositStep | DerivedGeometryEtchStep>,
  dieAreaRegion: Region,
  context: BuildContext,
  zUnits: "nm" | "um" | "mm",
): Solid[] {
  let current = [...solids];
  const fragmentCounter = { value: 1 };

  for (const step of steps) {
    if (step.type !== "etch") continue;

    const maskEval = evaluateMaskRegion(step.mask, dieAreaRegion, context);
    const maskCadId = maskEval.primaryCadId ?? "MASK";
    let maskRegion = maskEval.region;
    if (PolygonOps.isEmpty(maskRegion)) continue;

    const depth =
      step.depth === "through"
        ? Infinity
        : resolveThickness(step.depth, context.schema, zUnits, context.warnings);

    let stopBands: StopBand[] = [];
    if (step.stopOn?.material) {
      const stopMaterial = step.stopOn.material;
      const stopSolids = current.filter((solid) => solid.material === stopMaterial);
      const stopRegion = PolygonOps.unionMany(stopSolids.map((solid) => solid.region));
      if (PolygonOps.isEmpty(stopRegion)) {
        context.warnings.push(
          `Etch step ${step.id} has stopOn.material=${stopMaterial} but no solids with that material were present; applying etch mask as-is.`,
        );
      } else {
        maskRegion = PolygonOps.intersect(maskRegion, stopRegion);
        stopBands = buildStopBands(stopSolids);
      }
    }

    const budgets = buildEtchBudgets(maskRegion, depth, stopBands);
    if (budgets.length === 0) continue;

    const nonTargets = current.filter((solid) => solid.material !== step.targetMaterial);
    const targets = current
      .filter((solid) => solid.material === step.targetMaterial)
      .sort((a, b) => b.zMax - a.zMax);

    let activeBudgets = budgets;
    const nextTargets: Solid[] = [];
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]!;
      const applied = applyBudgetToSolid(
        target,
        activeBudgets,
        step.id,
        maskCadId,
        fragmentCounter,
      );
      nextTargets.push(...applied.solids);
      activeBudgets = applied.budgets;
      if (activeBudgets.length === 0) {
        nextTargets.push(...targets.slice(i + 1));
        break;
      }
    }

    current = [...nonTargets, ...nextTargets];
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
      thickness: solidThickness(solid),
      zOffset: solid.zMin,
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

function createExtrudedPayload(
  region: Region,
  entry: LayerStackEntry,
  renderOrder: number,
  unitScale: number,
  zScale: number,
): GeometryLayerPayload | null {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  for (const polygon of region) {
    const polygonData = createExtrudedPolygonData(
      polygon.outer,
      polygon.holes,
      entry,
      unitScale,
      zScale,
    );
    if (!polygonData) continue;
    const baseIndex = positions.length / 3;
    positions.push(...polygonData.positions);
    normals.push(...polygonData.normals);
    for (const index of polygonData.indices) {
      indices.push(baseIndex + index);
    }
  }

  if (indices.length === 0) return null;

  const classification = classifyLayer(
    entry.layer,
    entry.datatype,
    entry.name ?? entry.id ?? "",
  );
  const opacity = entry.material?.opacity ?? 1;
  const isTransparent = opacity < 0.999;

  return {
    layerKey: entry.id ?? `${entry.layer}:${entry.datatype}`,
    layer: entry.layer,
    datatype: entry.datatype,
    layerType: classification.type,
    lypTransparent: false,
    lypOutline: false,
    defaultVisible: entry.visible ?? classification.defaultVisible,
    color: entry.color,
    opacity,
    isTransparent,
    renderOrder,
    polygonOffsetFactor: -renderOrder * 0.1,
    polygonOffsetUnits: -renderOrder,
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
  };
}

function createExtrudedPolygonData(
  outerRing: Ring,
  holeRings: Ring[],
  entry: LayerStackEntry,
  unitScale: number,
  zScale: number,
): { positions: number[]; normals: number[]; indices: number[] } | null {
  const outer = ensureOrientation(outerRing, false);
  const holes = holeRings.map((ring) => ensureOrientation(ring, true));
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
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i]!;
      const [x1, y1] = ring[(i + 1) % ring.length]!;
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
  for (const hole of holes) addSideWalls(hole);

  return { positions, normals, indices };
}

export function buildDerivedGeometryPayload(
  document: GDSDocument,
  schema: DerivedGeometrySchema,
  options: { zScale?: number; overlayMode?: OverlayMode } = {},
): DerivedGeometryBuildResult {
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

  const context: BuildContext = {
    document,
    schema,
    dbToUm,
    overlayMode,
    warnings,
    cadRegionCache: new Map(),
    maskRegionCache: new Map(),
    ringsBySourceKey: buildRingsBySourceKey(document),
  };

  const dieArea = getDieAreaRegion(context);
  const uiGroups = buildUiGroupLabels(schema);
  const selections = buildOutputSelections(schema);

  const baseResult = buildBaseSlabSolids(
    schema.process.baseStack ?? [],
    dieArea,
    schema,
    zUnits,
    selections,
    warnings,
  );

  const depositResult = buildDepositSolids(
    schema.process.steps ?? [],
    baseResult.zCursor,
    dieArea,
    context,
    zUnits,
    selections,
  );

  const allSolids = [...baseResult.solids, ...depositResult.solids];
  const etchedSolids = applyEtchSteps(
    allSolids,
    schema.process.steps ?? [],
    dieArea.region,
    context,
    zUnits,
  );

  const solidsForRender = etchedSolids.filter((solid) => shouldIncludeSolid(solid, selections));
  const layerStack = solidsToLayerStack(schema, solidsForRender, dieArea.cadId, zUnits);
  const sortedSolids = [...solidsForRender].sort((a, b) => a.zMin - b.zMin);
  const entryById = new Map(
    layerStack.layers
      .filter((layer) => layer.id)
      .map((layer) => [layer.id as string, layer]),
  );

  const layers: GeometryLayerPayload[] = [];
  for (let i = 0; i < sortedSolids.length; i++) {
    const solid = sortedSolids[i]!;
    const entry = entryById.get(solid.id);
    if (!entry) continue;
    const payload = createExtrudedPayload(
      solid.region,
      entry,
      i,
      unitScale,
      zScale,
    );
    if (payload) layers.push(payload);
  }

  return {
    layers,
    layerStack,
    uiGroups,
    warnings,
  };
}
