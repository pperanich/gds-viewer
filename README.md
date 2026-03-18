# gds-viewer

A high-performance 3D GDS/GDSII file viewer built as a Web Component. Visualize semiconductor layouts and photonics designs directly in the browser with interactive 3D rendering, layer management, and measurement tools.

## Features

- **3D & 2D Visualization** - Interactive 3D rendering with orthographic 2D mode
- **Measurement Tools** - Precise distance measurements in 2D mode
- **Layer Management** - Toggle visibility, group by type, automatic layer classification
- **Layer Stack Support** - Import KLayout `.lyp`, custom layer stacks, process-stack JSON, or derived-geometry JSON
- **Web Worker Parsing** - Non-blocking GDS file parsing for smooth UI
- **Smart Defaults** - Automatic layer classification for photonics and semiconductor designs
- **Scale & Grid** - Dynamic scale ruler and grid overlay
- **Theme Support** - Light and dark modes with customizable CSS variables
- **Web Component** - Easy integration into any web application

## Quick Start

### Direct Embedding

Build `dist/gds-viewer.js` locally with `bun run build`, or use a release asset from the [releases page](https://github.com/pperanich/gds-viewer/releases), and include it directly:

```html
<!DOCTYPE html>
<html>
  <head>
    <script type="module" src="/gds-viewer.js"></script>
  </head>
  <body>
    <!-- Load from URL -->
    <gds-viewer
      gds-url="/path/to/design.gds"
      lyp-url="/path/to/layers.lyp"
      style="width: 100%; height: 600px;"
    >
    </gds-viewer>
  </body>
</html>
```

### Programmatic Usage

```javascript
import { GdsViewer } from "gds-viewer";

const viewer = document.querySelector("gds-viewer");

// Load GDS file
const gdsFile = await fetch("/design.gds").then((r) => r.arrayBuffer());
await viewer.loadGdsBuffer(gdsFile);

// Load layer configuration (KLayout .lyp format)
await viewer.loadLypFromUrl("/layers.lyp");

// Or use a custom layer stack
viewer.setLayerStack({
  layers: [
    {
      layer: 1,
      datatype: 0,
      name: "Waveguide",
      thickness: 0.22,
      zOffset: 0,
      color: "#ff6b6b",
      material: { opacity: 0.8 },
    },
  ],
  units: "um",
  defaultThickness: 0.2,
});

// Or load a physical process-stack JSON
await viewer.loadProcessStackFromUrl("/process-stack.json");

// Or load a derived-geometry JSON
await viewer.loadDerivedGeometryFromUrl("/derived-geometry.json");

// Access parsed document
const doc = viewer.getDocument();
console.log(doc.cells, doc.layers, doc.boundingBox);
```

## API Reference

### Web Component Attributes

| Attribute         | Description                                 |
| ----------------- | ------------------------------------------- |
| `gds-url`         | URL to GDS/GDSII file                       |
| `lyp-url`         | URL to KLayout layer properties file (.lyp) |
| `derived-geometry-url` | URL to derived-geometry JSON configuration |
| `derived-geometry-overlay-mode` | Overlay envelope mode for aligned masks (`nominal`, `typical`, `max`; default: `typical`) |
| `process-stack-url` | URL to process-stack JSON configuration    |
| `layer-stack-url` | URL to JSON layer stack configuration       |
| `theme`           | Initial theme (`light` or `dark`)           |
| `lyp-layer-ordering` | LYP draw order (`lyp`, `lyp-reverse`, `classification`) |

### Methods

#### Loading Files

```javascript
// Load GDS from File object
await viewer.loadGdsFile(file: File)

// Load GDS from ArrayBuffer
await viewer.loadGdsBuffer(buffer: ArrayBuffer)

// Load GDS from ArrayBuffer with filename
await viewer.loadGdsFromArrayBuffer(buffer: ArrayBuffer, filename?: string)
```

#### Layer Configuration

```javascript
// Load KLayout .lyp file
await viewer.loadLypFile(file: File)
await viewer.loadLypFromUrl(url: string)
await viewer.loadLypFromString(xmlString: string)

// Set custom layer stack
viewer.setLayerStack(config: LayerStackConfig)

// Load physical process stack JSON
await viewer.loadProcessStackFromUrl(url: string)
await viewer.loadProcessStackFromString(jsonString: string)
viewer.setProcessStack(config: ProcessStackConfig)

// Load derived-geometry JSON
await viewer.loadDerivedGeometryFromUrl(url: string)
await viewer.loadDerivedGeometryFromString(jsonString: string)
viewer.setDerivedGeometry(config: DerivedGeometrySchema)

// Control LYP-derived ordering (if a .lyp is loaded)
viewer.setLypLayerOrdering("lyp" | "lyp-reverse" | "classification")
```

#### Data Access

```javascript
// Get parsed GDS document
const doc: GDSDocument = viewer.getDocument()

// Get current layer stack configuration
const stack: LayerStackConfig = viewer.getLayerStack()
```

### TypeScript Types

```typescript
import type {
  GDSDocument,
  Cell,
  Polygon,
  Layer,
  Point,
  BoundingBox,
  LayerStackConfig,
  LayerStackEntry,
  ProcessStackConfig,
  ProcessStackLayer,
  LayerType,
  LayerClassification,
} from "gds-viewer";
```

### Layer Stack Configuration

```typescript
interface LayerStackConfig {
  layers: LayerStackEntry[];
  units?: string; // "nm" | "um" | "mm"
  defaultThickness?: number;
  defaultColor?: string;
}

interface LayerStackEntry {
  id?: string;
  layer: number;
  datatype: number;
  name?: string;
  visible?: boolean;
  group?: string;
  source?: { layer: number; datatype: number };
  thickness: number;
  zOffset: number;
  color: string; // hex color
  material?: {
    opacity?: number;
    metallic?: boolean;
  };
}
```

### Process Stack Configuration

`ProcessStackConfig` captures physical `zMin` and `thickness` per layer and is converted to `LayerStackConfig` internally.

```typescript
interface ProcessStackConfig {
  format?: "gds-viewer-process-stack@1";
  units?: "um" | "nm" | "mm";
  defaultThickness?: number;
  defaultColor?: string;
  layers: ProcessStackLayer[];
}

interface ProcessStackLayer {
  id?: string;
  layer: number;
  datatype: number;
  name: string;
  zMin: number;
  thickness: number;
  color?: string;
  visible?: boolean;
  material?: {
    opacity?: number;
    metallic?: boolean;
  };
}
```

### Derived Geometry Configuration

`DerivedGeometrySchema` describes a process-style stack (base slabs + deposit/etch steps) and compiles to renderable `LayerStackConfig` entries.

Note: derived-geometry is compiled from the GDS document using a worker-backed process compiler. It currently supports **base slabs**, **deposit steps** (including multiple stacked films on the same CAD layer), and **etch steps** on both die-area and mask-patterned solids using polygon boolean operations (union/intersection/difference). Etches now respect stacked same-material intervals and `stopOn.material` as a vertical stop condition. `renderSolids.from.steps` includes descendants of selected steps after etch/split operations. `mask.alignment` can be visualized as an **overlay envelope** using `derived-geometry-overlay-mode` (implemented via polygon offsetting). Masks can also be composed via `schema.masks` and `and/or/not/ref` expressions in step masks. `sidewallAngleDeg` is currently parsed but only reported as ignored; sloped sidewalls are not yet modeled.

Precedence when URL attributes are provided:
1. `lyp-url`
2. `derived-geometry-url`
3. `process-stack-url`
4. `layer-stack-url`

## Styling

Customize the viewer appearance using CSS variables:

```css
gds-viewer {
  /* Background colors */
  --gds-bg-light: #f0f0f0;
  --gds-bg-dark: #121212;

  /* Panel styling */
  --gds-panel-bg: rgba(30, 30, 30, 0.9);
  --gds-panel-text: #ffffff;
  --gds-panel-font: system-ui, -apple-system, sans-serif;
  --gds-panel-font-size: 13px;
  --gds-panel-radius: 8px;
  --gds-panel-padding: 12px;

  /* Button styling */
  --gds-button-bg: #e0e0e0;
  --gds-button-bg-active: #4a4a8a;
  --gds-button-text: #333333;
  --gds-button-text-active: #ffffff;

  /* Ruler styling */
  --gds-ruler-color-light: #333333;
  --gds-ruler-color-dark: #ffffff;
  --gds-ruler-font-size: 12px;

  /* Grid styling */
  --gds-grid-color-light: #aaaaaa;
  --gds-grid-color-dark: #888888;
  --gds-grid-opacity: 0.4;

  /* Layer compositing tuning (applies in both 2D and 3D) */
  --gds-2d-opacity-scale: 0.72;
  --gds-2d-opacity-min: 0.16;

  /* Measurement tool styling */
  --gds-measure-color: #ff6600;
  --gds-measure-line-width: 3;
  --gds-measure-font-size: 12px;
}
```

## Layer Auto-Classification

The viewer automatically classifies and colorizes layers based on common photonics and semiconductor naming conventions:

- **Waveguides** - Core optical waveguides
- **Slabs** - Slab regions for mode confinement
- **Metal** - Metal interconnects and heaters
- **Vias/Contacts** - Vertical connections
- **Doping** - Implant regions (N/P wells, active areas)
- **Cladding** - Oxide and protective layers
- **Boundaries** - Design boundaries and annotations

Custom classification rules can be added via layer stack configuration.

## Development

```bash
# Install dependencies
bun install

# Start dev server
bun run dev

# Build library
bun run build

# Type checking
bun run typecheck
```

## Browser Support

`gds-viewer` targets modern browsers with WebGPU support and may fall back to WebGL through Three.js where supported.

- Chrome/Edge 113+ recommended
- Safari 17+ recommended
- Firefox support is experimental and may require `dom.webgpu.enabled`

## License

MIT

## Credits

Built with:

- [Three.js](https://threejs.org/) - 3D rendering (WebGPU/WebGL)
- [GDSII](https://github.com/gdsfactory/gdsii) - GDS file parsing
- [Earcut](https://github.com/mapbox/earcut) - Polygon triangulation

Grid shader based on ["The Best Darn Grid Shader (Yet)"](https://bgolus.medium.com/the-best-darn-grid-shader-yet-727f9278b9d8) by Ben Golus.
