import type { LayerStackConfig, LayerStackEntry } from "../types/gds";
import { parseLayerName, classifyLayer, getTypeColor } from "./LayerClassifier";

export interface LypLayerProperties {
  name: string;
  layer: number;
  datatype: number;
  frameColor: string;
  fillColor: string;
  visible: boolean;
  transparent: boolean;
  ditherPattern?: string;
  width?: number;
  xfill?: boolean;
  valid: boolean;
}

export interface LypParseResult {
  layers: LypLayerProperties[];
  groups: Map<string, LypLayerProperties[]>;
}

export interface SerializedLypParseResult {
  layers: LypLayerProperties[];
  groups: [string, LypLayerProperties[]][];
}

interface LypVisualDefaults {
  frameColor?: string;
  fillColor?: string;
  visible?: boolean;
  transparent?: boolean;
  ditherPattern?: string;
  width?: number;
  xfill?: boolean;
  valid?: boolean;
}

const SOURCE_PATTERN = /^(\d+)\/(\d+)@/;
const WILDCARD_SOURCE = "*/*@*";
const DEFAULT_COLOR = "#808080";
const OUTLINE_NAME_PATTERNS = [
  /^WAFER$/i,
  /^FRAME$/i,
  /^PR_BNDRY/i,
  /^BOUNDARY/i,
  /boundary$/i,
  /^BBOX/i,
  /^DIEAREA/i,
  /OUTLINE/i,
  /^FLOORPLAN/i,
];

export function parseLypFile(xmlContent: string): LypParseResult {
  if (typeof DOMParser !== "undefined") {
    return parseLypWithDOMParser(xmlContent);
  }

  return parseLypWithRegex(xmlContent);
}

export function serializeLypParseResult(
  result: LypParseResult,
): SerializedLypParseResult {
  return {
    layers: result.layers,
    groups: Array.from(result.groups.entries()),
  };
}

export function deserializeLypParseResult(
  data: SerializedLypParseResult,
): LypParseResult {
  return {
    layers: data.layers,
    groups: new Map(data.groups),
  };
}

function parseLypWithDOMParser(xmlContent: string): LypParseResult {
  const layers: LypLayerProperties[] = [];
  const groups = new Map<string, LypLayerProperties[]>();

  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlContent, "text/xml");

  const parseError = doc.querySelector("parsererror");
  if (parseError) {
    throw new Error(`Invalid LYP XML: ${parseError.textContent}`);
  }

  const propertiesElements = doc.querySelectorAll("layer-properties > properties");

  for (const props of propertiesElements) {
    const defaults = parseVisualDefaultsDOM(props);
    const groupMembers = props.querySelectorAll(":scope > group-members");

    if (groupMembers.length > 0) {
      const groupName = getDirectTextContentDOM(props, "name") ?? "Unnamed Group";
      const memberLayers: LypLayerProperties[] = [];

      for (const member of groupMembers) {
        const layer = parsePropertiesElementDOM(member, defaults);
        if (layer) {
          memberLayers.push(layer);
          layers.push(layer);
        }
      }

      if (memberLayers.length > 0) {
        groups.set(groupName, memberLayers);
      }
      continue;
    }

    const layer = parsePropertiesElementDOM(props, defaults);
    if (layer) {
      layers.push(layer);
    }
  }

  return { layers, groups };
}

function parsePropertiesElementDOM(
  element: Element,
  inherited: LypVisualDefaults = {},
): LypLayerProperties | null {
  const source = getDirectTextContentDOM(element, "source");
  if (!source || source === WILDCARD_SOURCE) {
    return null;
  }

  const sourceMatch = source.match(SOURCE_PATTERN);
  if (!sourceMatch) {
    return null;
  }

  const layer = parseInt(sourceMatch[1]!, 10);
  const datatype = parseInt(sourceMatch[2]!, 10);

  const name =
    getDirectTextContentDOM(element, "name") ?? `Layer ${layer}/${datatype}`;

  const frameColor = getColorWithFallbackDOM(
    element,
    "frame-color",
    inherited.frameColor,
  );
  const fillColor = getColorWithFallbackDOM(
    element,
    "fill-color",
    inherited.fillColor,
  );
  const visible = getBooleanWithFallbackDOM(
    element,
    "visible",
    inherited.visible ?? true,
  );
  const transparent = getBooleanWithFallbackDOM(
    element,
    "transparent",
    inherited.transparent ?? false,
  );
  const valid = getBooleanWithFallbackDOM(
    element,
    "valid",
    inherited.valid ?? true,
  );
  const xfill = getBooleanWithFallbackDOM(
    element,
    "xfill",
    inherited.xfill ?? false,
  );

  const ditherPattern = normalizeOptionalText(
    getDirectTextContentDOM(element, "dither-pattern") ?? inherited.ditherPattern,
  );
  const width = parseOptionalInteger(
    getDirectTextContentDOM(element, "width"),
    inherited.width,
  );

  return {
    name,
    layer,
    datatype,
    frameColor,
    fillColor,
    visible,
    transparent,
    ditherPattern,
    width,
    xfill,
    valid,
  };
}

function parseVisualDefaultsDOM(element: Element): LypVisualDefaults {
  const defaults: LypVisualDefaults = {};

  const frameColor = normalizeOptionalText(getDirectTextContentDOM(element, "frame-color"));
  if (frameColor) {
    defaults.frameColor = normalizeColor(frameColor);
  }

  const fillColor = normalizeOptionalText(getDirectTextContentDOM(element, "fill-color"));
  if (fillColor) {
    defaults.fillColor = normalizeColor(fillColor);
  }

  const visible = parseBooleanValue(getDirectTextContentDOM(element, "visible"));
  if (visible !== undefined) {
    defaults.visible = visible;
  }

  const transparent = parseBooleanValue(
    getDirectTextContentDOM(element, "transparent"),
  );
  if (transparent !== undefined) {
    defaults.transparent = transparent;
  }

  const valid = parseBooleanValue(getDirectTextContentDOM(element, "valid"));
  if (valid !== undefined) {
    defaults.valid = valid;
  }

  const xfill = parseBooleanValue(getDirectTextContentDOM(element, "xfill"));
  if (xfill !== undefined) {
    defaults.xfill = xfill;
  }

  const ditherPattern = normalizeOptionalText(
    getDirectTextContentDOM(element, "dither-pattern"),
  );
  if (ditherPattern) {
    defaults.ditherPattern = ditherPattern;
  }

  const width = parseOptionalInteger(getDirectTextContentDOM(element, "width"));
  if (width !== undefined) {
    defaults.width = width;
  }

  return defaults;
}

function getDirectTextContentDOM(
  parent: Element,
  tagName: string,
): string | undefined {
  const element = parent.querySelector(`:scope > ${tagName}`);
  if (!element) return undefined;
  return element.textContent?.trim() ?? "";
}

function getColorWithFallbackDOM(
  parent: Element,
  tagName: string,
  fallback?: string,
): string {
  const value = normalizeOptionalText(getDirectTextContentDOM(parent, tagName));
  if (!value) {
    return fallback ?? DEFAULT_COLOR;
  }
  return normalizeColor(value);
}

function getBooleanWithFallbackDOM(
  parent: Element,
  tagName: string,
  fallback: boolean,
): boolean {
  const value = parseBooleanValue(getDirectTextContentDOM(parent, tagName));
  return value ?? fallback;
}

function parseLypWithRegex(xmlContent: string): LypParseResult {
  const layers: LypLayerProperties[] = [];
  const groups = new Map<string, LypLayerProperties[]>();

  const propertiesBlocks = extractPropertiesBlocks(xmlContent);

  for (const block of propertiesBlocks) {
    const groupMemberBlocks = block.match(/<group-members>([\s\S]*?)<\/group-members>/g);
    const defaults = parseVisualDefaultsRegex(stripGroupMembers(block));

    if (groupMemberBlocks && groupMemberBlocks.length > 0) {
      const groupName = extractTagValue(stripGroupMembers(block), "name") ?? "Unnamed Group";
      const memberLayers: LypLayerProperties[] = [];

      for (const memberBlock of groupMemberBlocks) {
        const layer = parsePropertiesBlockRegex(memberBlock, defaults);
        if (layer) {
          memberLayers.push(layer);
          layers.push(layer);
        }
      }

      if (memberLayers.length > 0) {
        groups.set(groupName, memberLayers);
      }
      continue;
    }

    const layer = parsePropertiesBlockRegex(block, defaults);
    if (layer) {
      layers.push(layer);
    }
  }

  return { layers, groups };
}

function extractPropertiesBlocks(xml: string): string[] {
  const blocks: string[] = [];
  const regex = /<properties>([\s\S]*?)<\/properties>/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(xml)) !== null) {
    blocks.push(match[0]);
  }

  return blocks;
}

function parsePropertiesBlockRegex(
  block: string,
  inherited: LypVisualDefaults = {},
): LypLayerProperties | null {
  const source = extractTagValue(block, "source");
  if (!source || source === WILDCARD_SOURCE) {
    return null;
  }

  const sourceMatch = source.match(SOURCE_PATTERN);
  if (!sourceMatch) {
    return null;
  }

  const layer = parseInt(sourceMatch[1]!, 10);
  const datatype = parseInt(sourceMatch[2]!, 10);

  const name = extractTagValue(block, "name") ?? `Layer ${layer}/${datatype}`;
  const frameColor = getColorWithFallbackRegex(
    extractTagValue(block, "frame-color"),
    inherited.frameColor,
  );
  const fillColor = getColorWithFallbackRegex(
    extractTagValue(block, "fill-color"),
    inherited.fillColor,
  );
  const visible = getBooleanWithFallbackRegex(
    extractTagValue(block, "visible"),
    inherited.visible ?? true,
  );
  const transparent = getBooleanWithFallbackRegex(
    extractTagValue(block, "transparent"),
    inherited.transparent ?? false,
  );
  const valid = getBooleanWithFallbackRegex(
    extractTagValue(block, "valid"),
    inherited.valid ?? true,
  );
  const xfill = getBooleanWithFallbackRegex(
    extractTagValue(block, "xfill"),
    inherited.xfill ?? false,
  );

  const ditherPattern = normalizeOptionalText(
    extractTagValue(block, "dither-pattern") ?? inherited.ditherPattern,
  );
  const width = parseOptionalInteger(
    extractTagValue(block, "width"),
    inherited.width,
  );

  return {
    name,
    layer,
    datatype,
    frameColor,
    fillColor,
    visible,
    transparent,
    ditherPattern,
    width,
    xfill,
    valid,
  };
}

function parseVisualDefaultsRegex(block: string): LypVisualDefaults {
  const defaults: LypVisualDefaults = {};

  const frameColor = normalizeOptionalText(extractTagValue(block, "frame-color"));
  if (frameColor) {
    defaults.frameColor = normalizeColor(frameColor);
  }

  const fillColor = normalizeOptionalText(extractTagValue(block, "fill-color"));
  if (fillColor) {
    defaults.fillColor = normalizeColor(fillColor);
  }

  const visible = parseBooleanValue(extractTagValue(block, "visible"));
  if (visible !== undefined) {
    defaults.visible = visible;
  }

  const transparent = parseBooleanValue(extractTagValue(block, "transparent"));
  if (transparent !== undefined) {
    defaults.transparent = transparent;
  }

  const valid = parseBooleanValue(extractTagValue(block, "valid"));
  if (valid !== undefined) {
    defaults.valid = valid;
  }

  const xfill = parseBooleanValue(extractTagValue(block, "xfill"));
  if (xfill !== undefined) {
    defaults.xfill = xfill;
  }

  const ditherPattern = normalizeOptionalText(extractTagValue(block, "dither-pattern"));
  if (ditherPattern) {
    defaults.ditherPattern = ditherPattern;
  }

  const width = parseOptionalInteger(extractTagValue(block, "width"));
  if (width !== undefined) {
    defaults.width = width;
  }

  return defaults;
}

function stripGroupMembers(xml: string): string {
  return xml.replace(/<group-members>[\s\S]*?<\/group-members>/g, "");
}

function extractTagValue(xml: string, tagName: string): string | undefined {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = xml.match(regex);
  return normalizeOptionalText(match?.[1]);
}

function getColorWithFallbackRegex(value?: string, fallback?: string): string {
  if (!value) {
    return fallback ?? DEFAULT_COLOR;
  }
  return normalizeColor(value);
}

function getBooleanWithFallbackRegex(value: string | undefined, fallback: boolean): boolean {
  const parsed = parseBooleanValue(value);
  return parsed ?? fallback;
}

function parseBooleanValue(value?: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  return undefined;
}

function normalizeOptionalText(value?: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseOptionalInteger(
  value?: string,
  fallback?: number,
): number | undefined {
  if (!value) {
    return fallback;
  }

  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return parsed;
}

function normalizeColor(color: string): string {
  const value = color.trim();
  if (!value) return DEFAULT_COLOR;

  if (value.startsWith("#") && value.length === 7) {
    return value.toLowerCase();
  }

  if (value.startsWith("#") && value.length === 4) {
    const r = value[1];
    const g = value[2];
    const b = value[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }

  return DEFAULT_COLOR;
}

function shouldRenderAsOutline(
  lyp: LypLayerProperties,
  layerType: string,
  baseName: string,
): boolean {
  if (layerType === "boundary") {
    return true;
  }

  const normalized = baseName.trim();
  for (const pattern of OUTLINE_NAME_PATTERNS) {
    if (pattern.test(normalized)) {
      return true;
    }
  }

  const fullName = lyp.name.trim();
  for (const pattern of OUTLINE_NAME_PATTERNS) {
    if (pattern.test(fullName)) {
      return true;
    }
  }

  return false;
}

export function lypToLayerStack(
  lypResult: LypParseResult,
  options: {
    defaultThickness?: number;
    units?: "um" | "nm" | "mm";
    autoZOffset?: boolean;
    layerOrdering?: "lyp" | "lyp-reverse" | "classification";
  } = {},
): LayerStackConfig {
  const {
    defaultThickness = 0.2,
    units = "um",
    autoZOffset = true,
    layerOrdering = "lyp-reverse",
  } = options;

  const layersInOrder = lypResult.layers
    .filter((l) => l.valid)
    .map((l) => {
      const parsed = parseLayerName(l.name);
      const classification = classifyLayer(l.layer, l.datatype, parsed.baseName);
      return { lyp: l, classification, parsed };
    });

  if (layerOrdering === "classification") {
    layersInOrder.sort((a, b) => a.classification.zOrder - b.classification.zOrder);
  } else if (layerOrdering === "lyp-reverse") {
    layersInOrder.reverse();
  }

  let currentZOffset = 0;
  const layers: LayerStackEntry[] = [];

  for (const { lyp, classification, parsed } of layersInOrder) {
    const shouldOutline = shouldRenderAsOutline(
      lyp,
      classification.type,
      parsed.baseName,
    );
    const color = shouldOutline
      ? lyp.frameColor || lyp.fillColor || getTypeColor(classification.type)
      : lyp.fillColor || lyp.frameColor || getTypeColor(classification.type);
    const thickness = getThicknessForType(classification.type, defaultThickness);

    layers.push({
      layer: lyp.layer,
      datatype: lyp.datatype,
      name: lyp.name,
      thickness,
      zOffset: autoZOffset ? currentZOffset : 0,
      color,
      visible: shouldOutline ? false : lyp.visible,
      material: {
        opacity: lyp.transparent ? 0.5 : classification.defaultOpacity,
        metallic: classification.type === "metal" || classification.type === "heater",
        lypTransparent: lyp.transparent,
        lypOutline: shouldOutline,
        lypDitherPattern: lyp.ditherPattern,
        lypWidth: lyp.width,
        lypXfill: lyp.xfill,
      },
    });

    if (autoZOffset) {
      currentZOffset += thickness * 1.1;
    }
  }

  return {
    layers,
    units,
    defaultThickness,
    defaultColor: DEFAULT_COLOR,
  };
}

function getThicknessForType(type: string, defaultThickness: number): number {
  switch (type) {
    case "well":
      return defaultThickness * 2;
    case "active":
    case "poly":
      return defaultThickness * 0.8;
    case "metal":
      return defaultThickness * 1.5;
    case "via":
    case "contact":
      return defaultThickness * 1.2;
    case "heater":
      return defaultThickness * 0.6;
    case "waveguide":
      return defaultThickness * 1.0;
    case "slab":
      return defaultThickness * 0.5;
    case "doping":
      return defaultThickness * 0.3;
    case "cladding":
      return defaultThickness * 3;
    default:
      return defaultThickness;
  }
}

export async function loadLypFromUrl(url: string): Promise<LypParseResult> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch LYP file: ${response.statusText}`);
  }
  const xmlContent = await response.text();
  return parseLypFile(xmlContent);
}

export async function loadLypFromFile(file: File): Promise<LypParseResult> {
  const xmlContent = await file.text();
  return parseLypFile(xmlContent);
}
