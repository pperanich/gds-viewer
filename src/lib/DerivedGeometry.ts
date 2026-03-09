import type {
  DerivedGeometryCadLayer,
  DerivedGeometryMaterialDisplay,
  DerivedGeometryMask,
  DerivedGeometrySchema,
  DerivedGeometryThickness,
  LayerStackConfig,
  LayerStackEntry,
} from "../types/gds";

export interface DerivedGeometryConversionResult {
  layerStack: LayerStackConfig;
  uiGroups: Map<string, string>;
  warnings: string[];
}

function resolveMaskCadId(
  mask: DerivedGeometryMask,
  schema: DerivedGeometrySchema,
  warnings: string[],
  visitedRefs: Set<string> = new Set(),
): string | null {
  if (typeof mask !== "object" || mask === null) return null;
  if ("cad" in mask && typeof mask.cad === "string") return mask.cad;
  if ("ref" in mask && typeof mask.ref === "string") {
    const ref = mask.ref;
    if (visitedRefs.has(ref)) {
      warnings.push(`Mask ref cycle detected: ${ref}`);
      return null;
    }
    const resolved = schema.masks?.[ref];
    if (!resolved) {
      warnings.push(`Unknown mask ref "${ref}"`);
      return null;
    }
    const nextVisited = new Set(visitedRefs);
    nextVisited.add(ref);
    return resolveMaskCadId(resolved, schema, warnings, nextVisited);
  }
  if ("op" in mask && mask.op === "not" && "arg" in mask) {
    return resolveMaskCadId(
      mask.arg as DerivedGeometryMask,
      schema,
      warnings,
      new Set(visitedRefs),
    );
  }
  if ("op" in mask && (mask.op === "and" || mask.op === "or") && "args" in mask) {
    const args = mask.args as DerivedGeometryMask[];
    for (const a of args) {
      const cad = resolveMaskCadId(a, schema, warnings, new Set(visitedRefs));
      if (cad) return cad;
    }
    return null;
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getDieAreaCadId(schema: DerivedGeometrySchema): string | null {
  for (const [id, layer] of Object.entries(schema.cadLayers)) {
    if ((layer as DerivedGeometryCadLayer).role === "die-area") return id;
  }
  if (schema.cadLayers["DIEAREA"]) return "DIEAREA";
  return null;
}

function getZUnits(schema: DerivedGeometrySchema): "um" | "nm" | "mm" {
  const z = schema.units?.z;
  if (z === "nm" || z === "mm" || z === "um") return z;
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

function resolveThickness(
  thickness: DerivedGeometryThickness,
  schema: DerivedGeometrySchema,
  zUnits: "nm" | "um" | "mm",
  warnings: string[],
): number {
  if (typeof thickness === "number") {
    return thickness;
  }

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

function getMaterialDisplay(
  schema: DerivedGeometrySchema,
  materialId: string,
): DerivedGeometryMaterialDisplay | null {
  const display = schema.materials?.[materialId]?.display;
  return display ?? null;
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
  solidToGroup: Map<string, string>;
  stepToGroup: Map<string, string>;
  materialToGroup: Map<string, string>;
} {
  const renderSolids = schema.outputs?.renderSolids;
  if (!renderSolids || renderSolids.length === 0) {
    return {
      includeMaterials: null,
      includeSteps: null,
      solidToGroup: new Map(),
      stepToGroup: new Map(),
      materialToGroup: new Map(),
    };
  }

  const includeMaterials = new Set<string>();
  const includeSteps = new Set<string>();
  const solidToGroup = new Map<string, string>();
  const stepToGroup = new Map<string, string>();
  const materialToGroup = new Map<string, string>();

  for (const solid of renderSolids) {
    if (solid.uiGroup) {
      solidToGroup.set(solid.id, solid.uiGroup);
    }
    if ("material" in solid.from) {
      includeMaterials.add(solid.from.material);
      if (solid.uiGroup) {
        materialToGroup.set(solid.from.material, solid.uiGroup);
      }
      continue;
    }
    for (const stepId of solid.from.steps) {
      includeSteps.add(stepId);
      if (solid.uiGroup) {
        stepToGroup.set(stepId, solid.uiGroup);
      }
    }
  }

  return {
    includeMaterials,
    includeSteps,
    solidToGroup,
    stepToGroup,
    materialToGroup,
  };
}

export function isDerivedGeometrySchema(
  value: unknown,
): value is DerivedGeometrySchema {
  if (!isObject(value)) return false;
  if (value["format"] !== "gds-viewer-derived-geometry@1") return false;
  if (!isObject(value["cadLayers"])) return false;
  if (!isObject(value["process"])) return false;
  return true;
}

export function derivedGeometryToLayerStack(
  schema: DerivedGeometrySchema,
): DerivedGeometryConversionResult {
  const warnings: string[] = [];
  const zUnits = getZUnits(schema);
  const dieAreaCadId = getDieAreaCadId(schema);
  if (!dieAreaCadId) {
    warnings.push(
      'No die-area CAD layer found (role="die-area" or id "DIEAREA"); base slabs without explicit patterns will not render.',
    );
  }

  const selections = buildOutputSelections(schema);
  const uiGroups = buildUiGroupLabels(schema);

  const layers: LayerStackEntry[] = [];
  let zCursor = 0;

  const baseStack = schema.process.baseStack ?? [];
  for (const slab of baseStack) {
    const thicknessZ = resolveThickness(slab.thickness, schema, zUnits, warnings);
    const display = getMaterialDisplay(schema, slab.material);
    const include =
      selections.includeMaterials === null ||
      selections.includeMaterials.has(slab.material);
    if (include && dieAreaCadId) {
      const dieArea = schema.cadLayers[dieAreaCadId];
      if (!dieArea) {
        warnings.push(`Die-area CAD layer not found: ${dieAreaCadId}`);
      } else {
        layers.push({
          id: `base:${slab.id}`,
          layer: dieArea.gds.layer,
          datatype: dieArea.gds.datatype,
          source: { layer: dieArea.gds.layer, datatype: dieArea.gds.datatype },
          name: slab.id,
          group: selections.materialToGroup.get(slab.material),
          thickness: thicknessZ,
          zOffset: zCursor,
          color: display?.color ?? "#c0c0c0",
          material: {
            opacity: display?.opacity,
            metallic: display?.metallic,
          },
        });
      }
    }
    zCursor += thicknessZ;
  }

  const steps = schema.process.steps ?? [];
  for (const step of steps) {
    if (step.type !== "deposit") {
      continue;
    }

    const deposit = step;
    const thicknessZ = resolveThickness(deposit.thickness, schema, zUnits, warnings);

    const include =
      selections.includeSteps === null ||
      selections.includeSteps.has(deposit.id) ||
      (selections.includeMaterials !== null &&
        selections.includeMaterials.has(deposit.material));
    if (!include) {
      zCursor += thicknessZ;
      continue;
    }

    const maskCadId =
      deposit.pattern !== undefined
        ? resolveMaskCadId(deposit.pattern.mask, schema, warnings)
        : dieAreaCadId;
    if (!maskCadId) {
      warnings.push(`No mask specified for deposit step: ${deposit.id}`);
      zCursor += thicknessZ;
      continue;
    }

    const cadLayer = schema.cadLayers[maskCadId];
    if (!cadLayer) {
      warnings.push(`Unknown CAD layer "${maskCadId}" referenced by step ${deposit.id}`);
      zCursor += thicknessZ;
      continue;
    }

    const display = getMaterialDisplay(schema, deposit.material);
    layers.push({
      id: `step:${deposit.id}`,
      layer: cadLayer.gds.layer,
      datatype: cadLayer.gds.datatype,
      source: { layer: cadLayer.gds.layer, datatype: cadLayer.gds.datatype },
      name: deposit.id,
      group:
        selections.stepToGroup.get(deposit.id) ??
        selections.materialToGroup.get(deposit.material),
      thickness: thicknessZ,
      zOffset: zCursor,
      color: display?.color ?? "#c0c0c0",
      material: {
        opacity: display?.opacity,
        metallic: display?.metallic,
      },
    });

    zCursor += thicknessZ;
  }

  return {
    layerStack: {
      layers,
      units: zUnits,
      defaultThickness: 0.2,
      defaultColor: "#c0c0c0",
    },
    uiGroups,
    warnings,
  };
}
