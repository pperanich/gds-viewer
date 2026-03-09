import { describe, expect, test } from "bun:test";
import { buildGeometryPayload, createDefaultLayerStack } from "../src/lib/GeometryPayloadBuilder";
import type { BoundingBox, Cell, GDSDocument, Point, Polygon } from "../src/index";

function makeBox(minX: number, minY: number, maxX: number, maxY: number): BoundingBox {
  return { minX, minY, maxX, maxY };
}

function rectPoints(minX: number, minY: number, maxX: number, maxY: number): Point[] {
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
}

function polygon(
  id: string,
  layer: number,
  datatype: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): Polygon {
  return {
    id,
    layer,
    datatype,
    points: rectPoints(minX, minY, maxX, maxY),
    boundingBox: makeBox(minX, minY, maxX, maxY),
  };
}

function buildDocument(polygons: Polygon[]): GDSDocument {
  const bounds = polygons.reduce<BoundingBox>(
    (acc, poly) => ({
      minX: Math.min(acc.minX, poly.boundingBox.minX),
      minY: Math.min(acc.minY, poly.boundingBox.minY),
      maxX: Math.max(acc.maxX, poly.boundingBox.maxX),
      maxY: Math.max(acc.maxY, poly.boundingBox.maxY),
    }),
    makeBox(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY),
  );
  const cell: Cell = {
    name: "TOP",
    polygons,
    texts: [],
    boundingBox: bounds,
  };

  return {
    name: "test",
    cells: new Map([["TOP", cell]]),
    layers: new Map([
      ["1:0", { layer: 1, datatype: 0, name: "M1", color: "#ff0000", visible: true }],
      ["2:0", { layer: 2, datatype: 0, name: "WG", color: "#00ff00", visible: true }],
    ]),
    topCells: ["TOP"],
    boundingBox: bounds,
    units: { database: 1e-6, user: 1e-6 },
  };
}

describe("Geometry payload builder", () => {
  test("builds a default layer stack from document layers", () => {
    const document = buildDocument([
      polygon("m1", 1, 0, 0, 0, 10, 10),
      polygon("wg", 2, 0, 2, 2, 8, 8),
    ]);

    const stack = createDefaultLayerStack(document);
    expect(stack.layers.length).toBe(2);
    expect(stack.layers.map((layer) => layer.layer)).toEqual([1, 2]);
  });

  test("switches to flat mode automatically when the threshold is exceeded", () => {
    const polygons: Polygon[] = [];
    for (let i = 0; i < 500; i++) {
      polygons.push(polygon(`p${i}`, 1, 0, i, 0, i + 1, 1));
    }
    const document = buildDocument(polygons);
    const stack = createDefaultLayerStack(document);

    const result = buildGeometryPayload(document, stack, {
      mode: "auto",
      flatModeThresholdBytes: 1,
    });

    expect(result.stats.chosenMode).toBe("flat");
    expect(result.layers.length).toBeGreaterThan(0);
  });

  test("defers hidden layers from the initial payload build", () => {
    const document = buildDocument([
      polygon("m1", 1, 0, 0, 0, 10, 10),
      polygon("wg", 2, 0, 2, 2, 8, 8),
    ]);
    const stack = createDefaultLayerStack(document);
    stack.layers[1]!.visible = false;

    const result = buildGeometryPayload(document, stack, {
      deferHiddenLayers: true,
      mode: "extruded",
    });

    expect(result.layers.map((layer) => layer.layerKey)).toEqual(["1:0"]);
    expect(result.deferredRenderKeys).toEqual(["2:0"]);
    expect(result.buildableRenderKeys.sort()).toEqual(["1:0", "2:0"]);
  });

  test("builds specific deferred render keys on demand", () => {
    const document = buildDocument([
      polygon("m1", 1, 0, 0, 0, 10, 10),
      polygon("wg", 2, 0, 2, 2, 8, 8),
    ]);
    const stack = createDefaultLayerStack(document);

    const result = buildGeometryPayload(document, stack, {
      includeRenderKeys: ["2:0"],
      mode: "flat",
    });

    expect(result.layers.map((layer) => layer.layerKey)).toEqual(["2:0"]);
    expect(result.deferredRenderKeys).toEqual(["1:0"]);
  });

  test("guards explicit 3D builds when the hard complexity limit is exceeded", () => {
    const polygons: Polygon[] = [];
    for (let i = 0; i < 50; i++) {
      polygons.push(polygon(`p${i}`, 1, 0, i, 0, i + 1, 1));
    }
    const document = buildDocument(polygons);
    const stack = createDefaultLayerStack(document);

    const result = buildGeometryPayload(document, stack, {
      mode: "extruded",
      hardLimitPointCount: 10,
    });

    expect(result.stats.chosenMode).toBe("flat");
    expect(result.stats.exceedsHardLimit).toBe(true);
    expect(result.stats.modeReason).toBe("hard-limit");
  });
});
