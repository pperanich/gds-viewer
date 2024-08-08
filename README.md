# gds-viewer

A high-performance 3D GDS/GDSII file viewer built as a Web Component. Visualize semiconductor layouts and photonics designs directly in the browser with interactive 3D rendering, layer management, and measurement tools.

![GDS Viewer Demo](https://img.shields.io/badge/demo-live-brightgreen)

## Features

- 🎨 **3D & 2D Visualization** - Interactive 3D rendering with orthographic 2D mode
- 📏 **Measurement Tools** - Precise distance measurements in 2D mode
- 🎭 **Layer Management** - Toggle visibility, group by type, automatic layer classification
- 🎨 **Layer Stack Support** - Import KLayout `.lyp` files or use custom layer configurations
- ⚡ **Web Worker Parsing** - Non-blocking GDS file parsing for smooth UI
- 🎯 **Smart Defaults** - Automatic layer classification for photonics and semiconductor designs
- 📐 **Scale & Grid** - Dynamic scale ruler and grid overlay
- 🌓 **Theme Support** - Light and dark modes with customizable CSS variables
- 🔧 **Web Component** - Easy integration into any web application

## Installation

```bash
npm install gds-viewer
# or
yarn add gds-viewer
# or
bun add gds-viewer
```

## Quick Start

### Direct Embedding (No Build Step)

Download the latest `gds-viewer.js` from the [releases page](https://github.com/YOUR_USERNAME/gds-viewer/releases) and include it directly:

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
      style="width: 100%; height: 600px;">
    </gds-viewer>
  </body>
</html>
```

### Via NPM (For Build Tools)

```html
<!DOCTYPE html>
<html>
  <head>
    <script type="module">
      import 'gds-viewer';
    </script>
  </head>
  <body>
    <gds-viewer 
      gds-url="/path/to/design.gds"
      lyp-url="/path/to/layers.lyp"
      style="width: 100%; height: 600px;">
    </gds-viewer>
  </body>
</html>
```

### Programmatic Usage

```javascript
import { GdsViewer } from 'gds-viewer';

const viewer = document.querySelector('gds-viewer');

// Load GDS file
const gdsFile = await fetch('/design.gds').then(r => r.arrayBuffer());
await viewer.loadGdsBuffer(gdsFile);

// Load layer configuration (KLayout .lyp format)
await viewer.loadLypFromUrl('/layers.lyp');

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
      material: { opacity: 0.8 }
    }
  ],
  units: "um",
  defaultThickness: 0.2
});

// Access parsed document
const doc = viewer.getDocument();
console.log(doc.cells, doc.layers, doc.boundingBox);
```

## API Reference

### Web Component Attributes

| Attribute | Description |
|-----------|-------------|
| `gds-url` | URL to GDS/GDSII file |
| `lyp-url` | URL to KLayout layer properties file (.lyp) |
| `layer-stack-url` | URL to JSON layer stack configuration |

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
  LayerType,
  LayerClassification
} from 'gds-viewer';
```

### Layer Stack Configuration

```typescript
interface LayerStackConfig {
  layers: LayerStackEntry[];
  units?: string;  // "nm" | "um" | "mm"
  defaultThickness: number;
}

interface LayerStackEntry {
  layer: number;
  datatype: number;
  name: string;
  thickness: number;
  zOffset: number;
  color: string;  // hex color
  material?: {
    opacity?: number;
    metallic?: boolean;
  };
}
```

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

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+

Requires WebGL2 support.

## License

MIT

## Credits

Built with:
- [Three.js](https://threejs.org/) - 3D rendering
- [GDSII](https://github.com/gdsfactory/gdsii) - GDS file parsing
- [PixiJS](https://pixijs.com/) - Text rendering
- [Earcut](https://github.com/mapbox/earcut) - Polygon triangulation
