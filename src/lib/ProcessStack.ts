import type {
  LayerStackConfig,
  LayerStackEntry,
  ProcessStackConfig,
} from "../types/gds";

function toLayerStackEntry(
  layer: ProcessStackConfig["layers"][number],
  defaultColor: string,
  defaultThickness: number,
): LayerStackEntry {
  return {
    layer: layer.layer,
    datatype: layer.datatype,
    name: layer.name,
    visible: layer.visible,
    thickness: layer.thickness ?? defaultThickness,
    zOffset: layer.zMin,
    color: layer.color ?? defaultColor,
    material: layer.material ? { ...layer.material } : undefined,
  };
}

export function processStackToLayerStack(
  processStack: ProcessStackConfig,
): LayerStackConfig {
  const defaultThickness = processStack.defaultThickness ?? 0.2;
  const defaultColor = processStack.defaultColor ?? "#c0c0c0";
  const layers = processStack.layers.map((layer) =>
    toLayerStackEntry(layer, defaultColor, defaultThickness),
  );

  return {
    layers,
    units: processStack.units ?? "um",
    defaultThickness,
    defaultColor,
  };
}
