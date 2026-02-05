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

const SOURCE_PATTERN = /^(\d+)\/(\d+)@/;
const WILDCARD_SOURCE = "*/*@*";

export function parseLypFile(xmlContent: string): LypParseResult {
  if (typeof DOMParser !== "undefined") {
    return parseLypWithDOMParser(xmlContent);
  }

  return parseLypWithRegex(xmlContent);
}

export function serializeLypParseResult(
  result: LypParseResult
): SerializedLypParseResult {
  return {
    layers: result.layers,
    groups: Array.from(result.groups.entries()),
  };
}

export function deserializeLypParseResult(
  data: SerializedLypParseResult
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
    const groupMembers = props.querySelectorAll("group-members");

    if (groupMembers.length > 0) {
      const groupName = getTextContentDOM(props, "name") || "Unnamed Group";
      const memberLayers: LypLayerProperties[] = [];

      for (const member of groupMembers) {
        const layer = parsePropertiesElementDOM(member);
        if (layer) {
          memberLayers.push(layer);
          layers.push(layer);
        }
      }

      if (memberLayers.length > 0) {
        groups.set(groupName, memberLayers);
      }
    } else {
      const layer = parsePropertiesElementDOM(props);
      if (layer) {
        layers.push(layer);
      }
    }
  }

  return { layers, groups };
}

function parsePropertiesElementDOM(element: Element): LypLayerProperties | null {
  const source = getTextContentDOM(element, "source");
  if (!source || source === WILDCARD_SOURCE) {
    return null;
  }

  const sourceMatch = source.match(SOURCE_PATTERN);
  if (!sourceMatch) {
    return null;
  }

  const layer = parseInt(sourceMatch[1]!, 10);
  const datatype = parseInt(sourceMatch[2]!, 10);

  const name = getTextContentDOM(element, "name") || `Layer ${layer}/${datatype}`;
  const frameColor = normalizeColor(getTextContentDOM(element, "frame-color"));
  const fillColor = normalizeColor(getTextContentDOM(element, "fill-color"));
  const visible = getTextContentDOM(element, "visible") === "true";
  const transparent = getTextContentDOM(element, "transparent") === "true";
  const valid = getTextContentDOM(element, "valid") !== "false";
  const ditherPattern = getTextContentDOM(element, "dither-pattern") || undefined;
  const widthStr = getTextContentDOM(element, "width");
  const width = widthStr ? parseInt(widthStr, 10) : undefined;

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
    valid,
  };
}

function getTextContentDOM(parent: Element, tagName: string): string {
  const element = parent.querySelector(`:scope > ${tagName}`);
  return element?.textContent?.trim() ?? "";
}

function parseLypWithRegex(xmlContent: string): LypParseResult {
  const layers: LypLayerProperties[] = [];
  const groups = new Map<string, LypLayerProperties[]>();

  const propertiesBlocks = extractPropertiesBlocks(xmlContent);

  for (const block of propertiesBlocks) {
    const groupMemberMatches = block.match(/<group-members>([\s\S]*?)<\/group-members>/g);

    if (groupMemberMatches && groupMemberMatches.length > 0) {
      const groupName = extractTagValue(block, "name") || "Unnamed Group";
      const memberLayers: LypLayerProperties[] = [];

      for (const memberBlock of groupMemberMatches) {
        const layer = parsePropertiesBlockRegex(memberBlock);
        if (layer) {
          memberLayers.push(layer);
          layers.push(layer);
        }
      }

      if (memberLayers.length > 0) {
        groups.set(groupName, memberLayers);
      }
    } else {
      const layer = parsePropertiesBlockRegex(block);
      if (layer) {
        layers.push(layer);
      }
    }
  }

  return { layers, groups };
}

function extractPropertiesBlocks(xml: string): string[] {
  const blocks: string[] = [];
  const regex = /<properties>([\s\S]*?)<\/properties>/g;
  let match;

  while ((match = regex.exec(xml)) !== null) {
    blocks.push(match[0]);
  }

  return blocks;
}

function parsePropertiesBlockRegex(block: string): LypLayerProperties | null {
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

  const name = extractTagValue(block, "name") || `Layer ${layer}/${datatype}`;
  const frameColor = normalizeColor(extractTagValue(block, "frame-color"));
  const fillColor = normalizeColor(extractTagValue(block, "fill-color"));
  const visible = extractTagValue(block, "visible") === "true";
  const transparent = extractTagValue(block, "transparent") === "true";
  const valid = extractTagValue(block, "valid") !== "false";
  const ditherPattern = extractTagValue(block, "dither-pattern") || undefined;
  const widthStr = extractTagValue(block, "width");
  const width = widthStr ? parseInt(widthStr, 10) : undefined;

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
    valid,
  };
}

function extractTagValue(xml: string, tagName: string): string {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = xml.match(regex);
  return match ? match[1]!.trim() : "";
}

function normalizeColor(color: string): string {
  if (!color) return "#808080";

  if (color.startsWith("#") && color.length === 7) {
    return color.toLowerCase();
  }

  if (color.startsWith("#") && color.length === 4) {
    const r = color[1];
    const g = color[2];
    const b = color[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }

  return "#808080";
}

export function lypToLayerStack(
  lypResult: LypParseResult,
  options: {
    defaultThickness?: number;
    units?: "um" | "nm" | "mm";
    autoZOffset?: boolean;
  } = {}
): LayerStackConfig {
  const { defaultThickness = 0.2, units = "um", autoZOffset = true } = options;

  const layersByZOrder = [...lypResult.layers]
    .filter((l) => l.valid)
    .map((l) => {
      const parsed = parseLayerName(l.name);
      const classification = classifyLayer(l.layer, l.datatype, parsed.baseName);
      return { lyp: l, classification, parsed };
    })
    .sort((a, b) => a.classification.zOrder - b.classification.zOrder);

  let currentZOffset = 0;
  const layers: LayerStackEntry[] = [];

  for (const { lyp, classification } of layersByZOrder) {
    const color = lyp.fillColor || lyp.frameColor || getTypeColor(classification.type);
    const thickness = getThicknessForType(classification.type, defaultThickness);

    layers.push({
      layer: lyp.layer,
      datatype: lyp.datatype,
      name: lyp.name,
      thickness,
      zOffset: autoZOffset ? currentZOffset : 0,
      color,
      material: {
        opacity: lyp.transparent ? 0.5 : classification.defaultOpacity,
        metallic: classification.type === "metal" || classification.type === "heater",
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
    defaultColor: "#808080",
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
