import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type {
  GDSDocument,
  LayerStackConfig,
  LayerStackEntry,
  ProcessStackConfig,
  DerivedGeometrySchema,
  TextElement,
} from "../types/gds";
import { parseGDSII } from "./GDSParser";
import { buildGeometryAsync, buildLayerMap, getUnitScale } from "./GeometryBuilder";
import { classifyLayer, getTypeColor } from "./LayerClassifier";
import { lypToLayerStack, type LypParseResult } from "./LypParser";
import {
  derivedGeometryToLayerStack,
  isDerivedGeometrySchema,
} from "./DerivedGeometry";
import { buildDerivedModel } from "./DerivedGeometryModel";
import { processStackToLayerStack } from "./ProcessStack";
import {
  loadLypFromUrlInWorker,
  loadLypFromFileInWorker,
  parseLypFileInWorker,
} from "./LypWorkerClient";
import { textRenderer, TextLayerGroup } from "./TextRenderer";
import { ScaleRuler } from "./ScaleRuler";
import { GridOverlay } from "./GridOverlay";
import { MeasurementTool } from "./MeasurementTool";

export class GdsViewer extends HTMLElement {
  private scene: THREE.Scene;
  private perspectiveCamera: THREE.PerspectiveCamera;
  private orthoCamera: THREE.OrthographicCamera;
  private activeCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private renderer: WebGPURenderer;
  private controls: OrbitControls;
  private modelGroup: THREE.Group | null = null;
  private textGroup: THREE.Group | null = null;
  private resizeObserver: ResizeObserver;
  private chipBackdrop: THREE.Mesh;
  private chipBackdropMaterial: THREE.MeshBasicMaterial;

  private gdsDocument: GDSDocument | null = null;
  private layerStack: LayerStackConfig | null = null;
  private lypResult: LypParseResult | null = null;
  private derivedSchema: DerivedGeometrySchema | null = null;
  private derivedUiGroups: Map<string, string> | null = null;
  private derivedWarnings: string[] = [];
  private layerVisibility: Map<string, boolean> = new Map();
  private textLayerGroups: Map<string, TextLayerGroup> = new Map();

  private scaleRuler: ScaleRuler;
  private gridOverlay: GridOverlay;
  private measurementTool: MeasurementTool;

  private container: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private layerPanel: HTMLDivElement;
  private controlsPanel: HTMLDivElement;
  private layersCollapsed: boolean = false;
  private meshMaterialState = new WeakMap<
    THREE.Mesh,
    {
      opacity: number;
      transparent: boolean;
    }
  >();

  private zScale: number = 1;
  private darkMode: boolean = false;
  private baseZScale: number = 1;
  private baseViewHeight: number = 100;
  private is2DMode: boolean = false;
  private rendererReady: boolean = false;
  private buildToken: number = 0;

  static get observedAttributes() {
    return [
      "gds-url",
      "derived-geometry-url",
      "derived-geometry-overlay-mode",
      "process-stack-url",
      "layer-stack-url",
      "lyp-url",
      "lyp-layer-ordering",
      "layers-collapsed",
      "theme",
    ];
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host {
        --gds-bg-light: #f0f0f0;
        --gds-bg-dark: #121212;
        
        --gds-panel-bg: rgba(30, 30, 30, 0.9);
        --gds-panel-text: #ffffff;
        --gds-panel-font: system-ui, -apple-system, sans-serif;
        --gds-panel-font-size: 13px;
        --gds-panel-radius: 8px;
        --gds-panel-padding: 12px;
        
        --gds-button-bg: #e0e0e0;
        --gds-button-bg-active: #4a4a8a;
        --gds-button-text: #333333;
        --gds-button-text-active: #ffffff;
        --gds-button-radius: 4px;
        
        --gds-ruler-color-light: #333333;
        --gds-ruler-color-dark: #ffffff;
        --gds-ruler-font: system-ui, -apple-system, sans-serif;
        --gds-ruler-font-size: 12px;
        
        --gds-grid-color-light: #aaaaaa;
        --gds-grid-color-dark: #aaaaaa;
        --gds-grid-opacity: 0.4;
        --gds-2d-opacity-scale: 0.72;
        --gds-2d-opacity-min: 0.16;
        --gds-chip-backdrop-color-dark: #ffffff;
        --gds-chip-backdrop-opacity-dark: 0.9;

        --gds-measure-color: #ff6600;
        --gds-measure-line-width: 3;
        --gds-measure-font: monospace;
        --gds-measure-font-size: 12px;
        --gds-measure-label-bg: rgba(255, 255, 255, 0.9);
        --gds-measure-label-radius: 3px;
      }
    `;
    this.shadowRoot!.appendChild(style);

    this.container = document.createElement("div");
    this.container.style.cssText =
      "width:100%;height:100%;position:relative;overflow:hidden;";

    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "display:block;width:100%;height:100%;";
    this.container.appendChild(this.canvas);

    this.layerPanel = document.createElement("div");
    this.layerPanel.style.cssText = `
      position:absolute;top:10px;right:10px;
      background:var(--gds-panel-bg);color:var(--gds-panel-text);
      padding:var(--gds-panel-padding);border-radius:var(--gds-panel-radius);
      overflow:hidden;
      font-family:var(--gds-panel-font);font-size:var(--gds-panel-font-size);
      min-width:180px;
      z-index:100;
    `;
    this.layerPanel.innerHTML = this.renderLayerPanelShell("");
    this.container.appendChild(this.layerPanel);

    this.controlsPanel = document.createElement("div");
    this.controlsPanel.style.cssText = `
      position:absolute;bottom:10px;right:10px;
      background:var(--gds-panel-bg);color:var(--gds-panel-text);
      padding:var(--gds-panel-padding);border-radius:var(--gds-panel-radius);
      font-family:var(--gds-panel-font);font-size:var(--gds-panel-font-size);
      min-width:200px;
      z-index:100;
    `;
    this.container.appendChild(this.controlsPanel);
    this.updateControlsPanel();

    this.scaleRuler = new ScaleRuler();
    this.container.appendChild(this.scaleRuler.getElement());

    this.shadowRoot!.appendChild(this.container);

    this.scene = new THREE.Scene();

    this.gridOverlay = new GridOverlay();
    this.scene.add(this.gridOverlay.getObject());

    this.chipBackdropMaterial = new THREE.MeshBasicMaterial({
      color: "#ffffff",
      side: THREE.DoubleSide,
      transparent: false,
      opacity: 1,
      depthWrite: false,
      depthTest: true,
    });
    this.chipBackdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      this.chipBackdropMaterial,
    );
    this.chipBackdrop.visible = false;
    this.chipBackdrop.renderOrder = -0.5;
    this.chipBackdrop.position.set(0, 0, -1);
    this.scene.add(this.chipBackdrop);

    this.perspectiveCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 10000);
    this.perspectiveCamera.position.set(0, 0, 100);
    this.perspectiveCamera.up.set(0, 0, 1);

    this.orthoCamera = new THREE.OrthographicCamera(
      -50,
      50,
      50,
      -50,
      0.1,
      10000,
    );
    this.orthoCamera.position.set(0, 0, 100);
    this.orthoCamera.up.set(0, 0, 1);

    this.activeCamera = this.perspectiveCamera;

    this.renderer = new WebGPURenderer({
      canvas: this.canvas,
      antialias: true,
      logarithmicDepthBuffer: true,
      forceWebGL: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.controls = new OrbitControls(this.activeCamera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;

    this.measurementTool = new MeasurementTool(
      this.container,
      this.canvas,
      this.scene,
    );
    this.measurementTool.setControls(this.controls);
    this.measurementTool.setHostElement(this);

    this.canvas.addEventListener("dblclick", () => this.resetToDefaultView());

    this.setupLights();

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
  }

  connectedCallback() {
    this.resizeObserver.observe(this.container);
    this.handleResize();
    this.setTheme(this.getThemeFromAttribute(), false);
    this.applyTheme();
    this.startRenderLoop();
    this.setLayersCollapsed(this.hasAttribute("layers-collapsed"), false);
    this.loadFromAttributes();
  }

  disconnectedCallback() {
    this.resizeObserver.disconnect();
    this.renderer.setAnimationLoop(null);
    this.renderer.dispose();
    this.controls.dispose();
    this.gridOverlay.dispose();
    this.chipBackdrop.geometry.dispose();
    this.chipBackdropMaterial.dispose();
    this.measurementTool.dispose();
  }

  attributeChangedCallback(name: string, _oldValue: string, _newValue: string) {
	    if (
	      name === "gds-url" ||
	      name === "derived-geometry-url" ||
	      name === "process-stack-url" ||
	      name === "layer-stack-url" ||
	      name === "lyp-url"
	    ) {
	      this.loadFromAttributes();
      return;
    }
    if (name === "derived-geometry-overlay-mode") {
      if (this.derivedSchema && this.gdsDocument) {
        void this.buildAndRenderModel();
      }
      return;
    }
    if (name === "lyp-layer-ordering") {
      void this.handleLypLayerOrderingChanged();
      return;
    }
    if (name === "layers-collapsed") {
      this.setLayersCollapsed(this.hasAttribute("layers-collapsed"), false);
      return;
    }
    if (name === "theme") {
      this.setTheme(this.getThemeFromAttribute(), false);
    }
  }

	  private async loadFromAttributes() {
	    const gdsUrl = this.getAttribute("gds-url");
	    const derivedGeometryUrl = this.getAttribute("derived-geometry-url");
	    const processStackUrl = this.getAttribute("process-stack-url");
	    const layerStackUrl = this.getAttribute("layer-stack-url");
	    const lypUrl = this.getAttribute("lyp-url");

    if (!gdsUrl) return;

    try {
      const gdsPromise = fetch(gdsUrl)
        .then((r) => r.arrayBuffer())
        .then((buffer) => parseGDSII(buffer));

	      const layerStackPromise = lypUrl
	        ? loadLypFromUrlInWorker(lypUrl).then((lypResult) => {
	            this.lypResult = lypResult;
	            this.derivedSchema = null;
	            this.derivedUiGroups = null;
	            this.derivedWarnings = [];
	            return this.createLayerStackFromLyp(lypResult);
	          })
	        : derivedGeometryUrl
	          ? fetch(derivedGeometryUrl)
	              .then((r) => r.json())
	              .then((json) => this.createLayerStackFromDerivedGeometry(json))
	        : processStackUrl
	          ? fetch(processStackUrl)
	              .then((r) => r.json())
	              .then((json) => this.createLayerStackFromProcessStack(json))
	        : layerStackUrl
	          ? fetch(layerStackUrl).then((r) => {
	              this.lypResult = null;
	              this.derivedSchema = null;
	              this.derivedUiGroups = null;
	              this.derivedWarnings = [];
	              return r.json();
	            })
	          : Promise.resolve<LayerStackConfig | null>(null);

      const [gdsDocument, layerStack] = await Promise.all([
        gdsPromise,
        layerStackPromise,
      ]);

	      this.gdsDocument = gdsDocument;
	      this.layerStack = layerStack ?? this.createDefaultLayerStack();
	      if (!lypUrl && !derivedGeometryUrl && !processStackUrl && !layerStackUrl) {
	        this.lypResult = null;
	        this.derivedSchema = null;
	        this.derivedUiGroups = null;
	        this.derivedWarnings = [];
	      }

      await this.buildAndRenderModel();
    } catch (error) {
      console.error("Failed to load GDS:", error);
    }
  }

  private createDefaultLayerStack(): LayerStackConfig {
    if (!this.gdsDocument) {
      return { layers: [], defaultThickness: 0.2 };
    }

    const layerEntries = Array.from(this.gdsDocument.layers.values()).map(
      (layer) => {
        const classification = classifyLayer(
          layer.layer,
          layer.datatype,
          layer.name,
        );
        return { layer, classification };
      },
    );

    const layers: LayerStackConfig["layers"] = [];
    let zOffset = 0;
    const defaultThickness = 0.2;

    for (const { layer, classification } of layerEntries) {
      const thickness = this.getThicknessForType(
        classification.type,
        defaultThickness,
      );
      const color = layer.color || getTypeColor(classification.type);

      layers.push({
        layer: layer.layer,
        datatype: layer.datatype,
        name: layer.name,
        thickness,
        zOffset,
        color,
        material: {
          opacity: classification.defaultOpacity,
          metallic:
            classification.type === "metal" || classification.type === "heater",
        },
      });
      zOffset += thickness * 1.1;
    }

    return { layers, units: "um", defaultThickness: 0.2 };
  }

  private getLypLayerOrderingFromAttribute():
    | "lyp"
    | "lyp-reverse"
    | "classification" {
    const value = this.getAttribute("lyp-layer-ordering")?.trim().toLowerCase();
    if (value === "lyp" || value === "lyp-reverse" || value === "classification") {
      return value;
    }
    return "lyp-reverse";
  }

  private getDerivedGeometryOverlayModeFromAttribute():
    | "nominal"
    | "typical"
    | "max" {
    const value = this
      .getAttribute("derived-geometry-overlay-mode")
      ?.trim()
      .toLowerCase();
    if (value === "nominal" || value === "typical" || value === "max") {
      return value;
    }
    return "typical";
  }

	  private createLayerStackFromLyp(lypResult: LypParseResult): LayerStackConfig {
	    return lypToLayerStack(lypResult, {
	      layerOrdering: this.getLypLayerOrderingFromAttribute(),
	    });
	  }

	  private createLayerStackFromDerivedGeometry(
	    derivedGeometry: unknown,
	  ): LayerStackConfig {
	    if (!isDerivedGeometrySchema(derivedGeometry)) {
	      throw new Error(
	        'Invalid derived-geometry JSON: expected format "gds-viewer-derived-geometry@1"',
	      );
	    }
	    this.derivedSchema = derivedGeometry;
	    const result = derivedGeometryToLayerStack(derivedGeometry);
	    this.lypResult = null;
	    this.derivedUiGroups = result.uiGroups;
	    this.derivedWarnings = result.warnings;
	    if (result.warnings.length > 0) {
	      console.warn(
	        "Derived geometry conversion warnings:",
	        result.warnings,
	      );
	    }
	    return result.layerStack;
	  }

	  private createLayerStackFromProcessStack(
	    processStack: unknown,
	  ): LayerStackConfig {
    if (
      !processStack ||
      typeof processStack !== "object" ||
      !Array.isArray((processStack as { layers?: unknown }).layers)
    ) {
      throw new Error(
        "Invalid process stack JSON: expected object with a layers array",
      );
    }
    const typedProcessStack = processStack as ProcessStackConfig;
    const converted = processStackToLayerStack(typedProcessStack);
	    const merged = this.mergeProcessStackWithExisting(
	      typedProcessStack,
	      converted,
	      this.layerStack,
	    );
	    this.lypResult = null;
	    this.derivedSchema = null;
	    this.derivedUiGroups = null;
	    this.derivedWarnings = [];
	    return merged;
	  }

  private mergeProcessStackWithExisting(
    processStack: ProcessStackConfig,
    processLayerStack: LayerStackConfig,
    existingLayerStack: LayerStackConfig | null,
  ): LayerStackConfig {
    if (!existingLayerStack || existingLayerStack.layers.length === 0) {
      return processLayerStack;
    }

    const existingByKey = new Map(
      existingLayerStack.layers.map((layer) => [
        `${layer.layer}:${layer.datatype}`,
        layer,
      ]),
    );
    const processKeys = new Set(
      processStack.layers.map((layer) => `${layer.layer}:${layer.datatype}`),
    );

    const mergedLayers = processLayerStack.layers.map((layer, index) => {
      const processLayer = processStack.layers[index];
      const key = `${layer.layer}:${layer.datatype}`;
      const existing = existingByKey.get(key);
      if (!processLayer || !existing) return layer;

      return {
        ...layer,
        color: processLayer.color ?? existing.color,
        visible:
          processLayer.visible !== undefined ? layer.visible : existing.visible,
        material:
          processLayer.material !== undefined
            ? { ...existing.material, ...layer.material }
            : existing.material,
      };
    });

    for (const existingLayer of existingLayerStack.layers) {
      const key = `${existingLayer.layer}:${existingLayer.datatype}`;
      if (!processKeys.has(key)) {
        mergedLayers.push(existingLayer);
      }
    }

    return {
      ...processLayerStack,
      layers: mergedLayers,
      defaultColor:
        processLayerStack.defaultColor ?? existingLayerStack.defaultColor,
    };
  }

  private async handleLypLayerOrderingChanged() {
    if (!this.lypResult) return;
    this.layerStack = this.createLayerStackFromLyp(this.lypResult);
    if (this.gdsDocument) {
      await this.buildAndRenderModel();
    }
  }

  private getThicknessForType(type: string, defaultThickness: number): number {
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

	  private async buildAndRenderModel() {
	    if (!this.gdsDocument || !this.layerStack) return;

	    const token = ++this.buildToken;

	    let nextModel: THREE.Group;
	    let nextLayerStack: LayerStackConfig | null = null;

	    if (this.derivedSchema) {
	      const result = buildDerivedModel(this.gdsDocument, this.derivedSchema, {
	        zScale: this.baseZScale,
          overlayMode: this.getDerivedGeometryOverlayModeFromAttribute(),
	      });
	      nextModel = result.group;
	      nextLayerStack = result.layerStack;
	      this.derivedUiGroups = result.uiGroups;
	      this.derivedWarnings = result.warnings;
	      if (result.warnings.length > 0) {
	        console.warn("Derived geometry warnings:", result.warnings);
	      }
	    } else {
	      nextModel = await buildGeometryAsync(
	        this.gdsDocument,
	        this.layerStack,
	        {
	          zScale: this.baseZScale,
	        },
	      );
	    }

	    if (token !== this.buildToken) {
	      this.disposeGroup(nextModel);
	      return;
	    }

	    if (nextLayerStack) {
	      this.layerStack = nextLayerStack;
	    }

	    if (this.modelGroup) {
	      this.scene.remove(this.modelGroup);
	      this.disposeGroup(this.modelGroup);
	    }

    if (this.textGroup) {
      this.scene.remove(this.textGroup);
      this.disposeGroup(this.textGroup);
    }

    this.modelGroup = nextModel;
    this.modelGroup.scale.z = this.zScale;
    this.scene.add(this.modelGroup);
    this.updateChipBackdropBounds();

    if (this.is2DMode) {
      this.modelGroup.scale.z = 0.001;
      this.apply2DCompositing();
    } else {
      this.apply2DCompositing();
    }

    this.fitCameraToModel();

    await this.renderTexts(token);

    this.initLayerVisibility();
    this.updateLayerPanel();
  }

  private async renderTexts(buildToken?: number) {
    if (!this.gdsDocument || !this.layerStack) return;

    const allTexts: TextElement[] = [];
    for (const cell of this.gdsDocument.cells.values()) {
      allTexts.push(...cell.texts);
    }

    if (allTexts.length === 0) return;

    const layerMap = buildLayerMap(this.layerStack);
    const dbToUm = this.gdsDocument.units.database / 1e-6;
    const unitScale = getUnitScale(this.layerStack.units ?? "um");

    try {
      const textLayerGroups = await textRenderer.renderTexts(
        allTexts,
        layerMap,
        {
          dbToUm,
          unitScale,
          zScale: this.baseZScale,
          documentBounds: this.gdsDocument.boundingBox,
        },
      );

      if (buildToken !== undefined && buildToken !== this.buildToken) {
        return;
      }

      this.textLayerGroups = textLayerGroups;
      this.textGroup = textRenderer.createTextGroup(textLayerGroups);
      this.textGroup.scale.z = this.zScale;
      this.scene.add(this.textGroup);

      for (const [key, group] of this.textLayerGroups) {
        if (!this.layerVisibility.has(key)) {
          this.layerVisibility.set(key, group.classification.defaultVisible);
        }
      }

      this.updateLayerPanel();
    } catch (error) {
      console.warn("Failed to render texts:", error);
    }
  }

  private updateControlsPanel() {
    const zScaleRow = this.is2DMode
      ? ""
      : `
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <span style="min-width:60px">Z Scale:</span>
        <input type="range" min="1" max="200" value="${this.zScale}" 
          style="flex:1;cursor:pointer;" data-control="zscale">
        <span style="min-width:35px;text-align:right">${this.zScale}x</span>
      </label>
    `;

    const backendLabel = this.renderer?.backend
      ? this.getBackend() === "webgpu"
        ? "WebGPU"
        : "WebGL"
      : "Initializing...";

    this.controlsPanel.innerHTML = `
      <div style="margin-bottom:8px"><strong>View Controls</strong></div>
      <div style="display:flex;gap:8px;margin-bottom:8px;">
        <button data-control="view-mode" style="flex:1;padding:6px 12px;border:none;border-radius:var(--gds-button-radius);cursor:pointer;background:var(${this.is2DMode ? "--gds-button-bg" : "--gds-button-bg-active"});color:var(${this.is2DMode ? "--gds-button-text" : "--gds-button-text-active"});">
          3D
        </button>
        <button data-control="view-mode-2d" style="flex:1;padding:6px 12px;border:none;border-radius:var(--gds-button-radius);cursor:pointer;background:var(${this.is2DMode ? "--gds-button-bg-active" : "--gds-button-bg"});color:var(${this.is2DMode ? "--gds-button-text-active" : "--gds-button-text"});">
          2D
        </button>
      </div>
      ${zScaleRow}
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
        <span style="min-width:60px">Theme:</span>
        <button data-control="theme" style="padding:4px 12px;border:none;border-radius:var(--gds-button-radius);cursor:pointer;background:var(${this.darkMode ? "--gds-button-bg-active" : "--gds-button-bg"});color:var(${this.darkMode ? "--gds-button-text-active" : "--gds-button-text"});">
          ${this.darkMode ? "Dark" : "Light"}
        </button>
      </label>
      <div style="margin-top:8px;font-size:11px;color:#888;">
        Renderer: ${backendLabel}
      </div>
    `;

    const slider = this.controlsPanel.querySelector(
      'input[data-control="zscale"]',
    );
    slider?.addEventListener("input", (e) => {
      const target = e.target as HTMLInputElement;
      this.zScale = parseInt(target.value, 10);
      const valueSpan = this.controlsPanel.querySelector(
        'span[style*="text-align:right"]',
      );
      if (valueSpan) valueSpan.textContent = `${this.zScale}x`;
      this.updateZScale();
    });

    const themeBtn = this.controlsPanel.querySelector(
      'button[data-control="theme"]',
    );
    themeBtn?.addEventListener("click", () => {
      this.setTheme(this.darkMode ? "light" : "dark", true);
    });

    const view3DBtn = this.controlsPanel.querySelector(
      'button[data-control="view-mode"]',
    );
    view3DBtn?.addEventListener("click", () => {
      if (this.is2DMode) this.toggle2DMode();
    });

    const view2DBtn = this.controlsPanel.querySelector(
      'button[data-control="view-mode-2d"]',
    );
    view2DBtn?.addEventListener("click", () => {
      if (!this.is2DMode) this.toggle2DMode();
    });

    this.updatePanelLayout();
  }

  private applyTheme() {
    const styles = getComputedStyle(this);

    const bgLight =
      styles.getPropertyValue("--gds-bg-light").trim() || "#f0f0f0";
    const bgDark = styles.getPropertyValue("--gds-bg-dark").trim() || "#121212";
    const bgColor = this.darkMode ? bgDark : bgLight;
    this.scene.background = new THREE.Color(bgColor);

    const rulerLight =
      styles.getPropertyValue("--gds-ruler-color-light").trim() || "#333333";
    const rulerDark =
      styles.getPropertyValue("--gds-ruler-color-dark").trim() || "#ffffff";
    const rulerColor = this.darkMode ? rulerDark : rulerLight;
    this.scaleRuler.setColors(rulerColor, rulerColor);

    const rulerFont =
      styles.getPropertyValue("--gds-ruler-font").trim() ||
      "system-ui, -apple-system, sans-serif";
    const rulerFontSize =
      styles.getPropertyValue("--gds-ruler-font-size").trim() || "12px";
    this.scaleRuler.setFont(rulerFont, rulerFontSize);

    const gridLight =
      styles.getPropertyValue("--gds-grid-color-light").trim() || "#aaaaaa";
    const gridDark =
      styles.getPropertyValue("--gds-grid-color-dark").trim() || "#aaaaaa";
    const gridOpacity =
      parseFloat(styles.getPropertyValue("--gds-grid-opacity").trim()) || 0.4;
    const gridColor = this.darkMode ? gridDark : gridLight;
    this.gridOverlay.setColor(
      gridColor,
      gridOpacity,
    );

    const chipBackdropColorDark =
      styles.getPropertyValue("--gds-chip-backdrop-color-dark").trim() ||
      "#ffffff";
    const chipBackdropOpacityDark =
      parseFloat(
        styles.getPropertyValue("--gds-chip-backdrop-opacity-dark").trim(),
      ) || 0.9;
    const isChipBackdropTransparent = chipBackdropOpacityDark < 0.999;
    this.chipBackdropMaterial.color.set(chipBackdropColorDark);
    if (this.chipBackdropMaterial.transparent !== isChipBackdropTransparent) {
      this.chipBackdropMaterial.transparent = isChipBackdropTransparent;
      this.chipBackdropMaterial.needsUpdate = true;
    }
    this.chipBackdropMaterial.opacity = isChipBackdropTransparent
      ? chipBackdropOpacityDark
      : 1;
    this.updateChipBackdropBounds();

    this.measurementTool.updateStylesFromCSS();
  }

  private getThemeFromAttribute(): "light" | "dark" {
    const theme = this.getAttribute("theme")?.toLowerCase();
    return theme === "dark" ? "dark" : "light";
  }

  private setTheme(theme: "light" | "dark", updateAttribute: boolean) {
    const darkMode = theme === "dark";
    if (this.darkMode === darkMode && !updateAttribute) return;

    this.darkMode = darkMode;

    if (updateAttribute) {
      this.setAttribute("theme", theme);
    }

    this.applyTheme();
    this.updateControlsPanel();
  }

  private updateZScale() {
    if (this.modelGroup) {
      this.modelGroup.scale.z = this.zScale;
    }
    if (this.textGroup) {
      this.textGroup.scale.z = this.zScale;
    }
  }

	  private updateChipBackdropBounds() {
    if (!this.gdsDocument) {
      this.chipBackdrop.visible = false;
      return;
    }

    const dbToUm = this.gdsDocument.units.database / 1e-6;
    const bounds = this.gdsDocument.boundingBox;
    const minX = bounds.minX * dbToUm;
    const maxX = bounds.maxX * dbToUm;
    const minY = bounds.minY * dbToUm;
    const maxY = bounds.maxY * dbToUm;
    const width = Math.max(1e-6, maxX - minX);
    const height = Math.max(1e-6, maxY - minY);

    this.chipBackdrop.scale.set(width, height, 1);
    this.chipBackdrop.position.set(
      (minX + maxX) / 2,
      (minY + maxY) / 2,
      -1,
    );
	    this.chipBackdrop.visible = this.darkMode;
	  }

	  private getLayerPanelEntries(): Array<{
	    renderKey: string;
	    sourceKey: string;
	    name: string;
	    zOffset: number;
	    color: string;
	    stackEntry: LayerStackEntry | null;
	    classification: ReturnType<typeof classifyLayer>;
	    isTextLayer: boolean;
	  }> {
	    if (!this.gdsDocument || !this.layerStack) return [];

	    const usedKeys = new Set<string>();
	    const entriesBySource = new Map<
	      string,
	      Array<{ renderKey: string; entry: LayerStackEntry }>
	    >();

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

	    for (const entry of this.layerStack.layers) {
	      const sourceLayer = entry.source?.layer ?? entry.layer;
	      const sourceDatatype = entry.source?.datatype ?? entry.datatype;
	      const sourceKey = `${sourceLayer}:${sourceDatatype}`;
	      const baseRenderKey = (entry.id && entry.id.trim()) || sourceKey;
	      const renderKey = uniqueKey(baseRenderKey);
	      const list = entriesBySource.get(sourceKey) ?? [];
	      list.push({ renderKey, entry });
	      entriesBySource.set(sourceKey, list);
	    }

	    const defaultThickness = this.layerStack.defaultThickness ?? 0.1;
	    let maxConfiguredZOffset = -defaultThickness * 1.1;
	    for (const entry of this.layerStack.layers) {
	      if (entry.zOffset > maxConfiguredZOffset) {
	        maxConfiguredZOffset = entry.zOffset;
	      }
	    }
	    let nextFallbackZOffset = maxConfiguredZOffset + defaultThickness * 1.1;

		    const results: Array<{
		      renderKey: string;
		      sourceKey: string;
		      name: string;
	      zOffset: number;
	      color: string;
	      stackEntry: LayerStackEntry | null;
	      classification: ReturnType<typeof classifyLayer>;
		      isTextLayer: boolean;
		    }> = [];
		    const seenSourceKeys = new Set<string>();

		    for (const [sourceKey, layer] of this.gdsDocument.layers) {
		      seenSourceKeys.add(sourceKey);
		      const renderEntries = entriesBySource.get(sourceKey);
		      const hasTexts = this.textLayerGroups.has(sourceKey);

	      if (renderEntries && renderEntries.length > 0) {
	        const hasSourceKeyEntry = renderEntries.some(
	          (item) => item.renderKey === sourceKey,
	        );
	        const layerName = layer.name ?? sourceKey;
	        let maxZ = -Infinity;

	        for (const { renderKey, entry } of renderEntries) {
	          const name = entry.name ?? layerName;
	          const classification = classifyLayer(layer.layer, layer.datatype, name);
	          results.push({
	            renderKey,
	            sourceKey,
	            name,
	            zOffset: entry.zOffset,
	            color: entry.color,
	            stackEntry: entry,
	            classification,
	            isTextLayer: hasTexts && hasSourceKeyEntry && renderKey === sourceKey,
	          });
	          maxZ = Math.max(maxZ, entry.zOffset);
	        }

	        if (hasTexts && !hasSourceKeyEntry) {
	          const textClassification =
	            this.textLayerGroups.get(sourceKey)?.classification ??
	            classifyLayer(layer.layer, layer.datatype, `${layerName} (Text)`);
	          results.push({
	            renderKey: sourceKey,
	            sourceKey,
	            name: `${layerName} (Text)`,
	            zOffset: Number.isFinite(maxZ) ? maxZ + 1e-6 : 0,
	            color: "#4a4a8a",
	            stackEntry: null,
	            classification: textClassification,
	            isTextLayer: true,
	          });
	        }

	        continue;
	      }

	      const name = layer.name ?? sourceKey;
	      const classification = classifyLayer(layer.layer, layer.datatype, name);
	      const color =
	        layer.color ||
	        (classification.isAnnotation ? "#333333" : getTypeColor(classification.type));
	      results.push({
	        renderKey: sourceKey,
	        sourceKey,
	        name,
	        zOffset: nextFallbackZOffset,
	        color,
	        stackEntry: null,
	        classification,
	        isTextLayer: hasTexts,
	      });
		      nextFallbackZOffset += defaultThickness * 1.1;
		    }

		    for (const [sourceKey, renderEntries] of entriesBySource) {
		      if (seenSourceKeys.has(sourceKey)) continue;
		      const [layerStr, datatypeStr] = sourceKey.split(":");
		      const layerNum = parseInt(layerStr ?? "0", 10);
		      const datatypeNum = parseInt(datatypeStr ?? "0", 10);

		      for (const { renderKey, entry } of renderEntries) {
		        const name = entry.name ?? renderKey;
		        const classification = classifyLayer(layerNum, datatypeNum, name);
		        results.push({
		          renderKey,
		          sourceKey,
		          name,
		          zOffset: entry.zOffset,
		          color: entry.color,
		          stackEntry: entry,
		          classification,
		          isTextLayer: false,
		        });
		      }
		    }

		    return results;
		  }

	  private applyLayerVisibility() {
	    const map = this.layerVisibility;

	    if (this.modelGroup) {
	      this.modelGroup.traverse((obj) => {
	        if (
	          (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) &&
	          typeof obj.userData["layerKey"] === "string"
	        ) {
	          const key = obj.userData["layerKey"] as string;
	          const visible = map.get(key);
	          if (visible !== undefined) {
	            obj.visible = visible;
	          }
	        }
	      });
	    }

	    if (this.textGroup) {
	      this.textGroup.traverse((obj) => {
	        if (
	          obj instanceof THREE.Group &&
	          typeof obj.userData["layerKey"] === "string"
	        ) {
	          const key = obj.userData["layerKey"] as string;
	          const visible = map.get(key);
	          if (visible !== undefined) {
	            obj.visible = visible;
	          }
	        }
	      });
	    }
	  }

	  private initLayerVisibility() {
	    const previous = new Map(this.layerVisibility);
	    this.layerVisibility.clear();
	    const entries = this.getLayerPanelEntries();
	    for (const entry of entries) {
	      const defaultVisible =
	        entry.stackEntry?.visible ?? entry.classification.defaultVisible;
	      const visible = previous.get(entry.renderKey) ?? defaultVisible;
	      this.layerVisibility.set(entry.renderKey, visible);
	    }
	    this.applyLayerVisibility();
	  }

	  private updateLayerPanel() {
	    if (!this.gdsDocument || !this.layerStack) {
      this.layerPanel.innerHTML = this.renderLayerPanelShell(
        "<div>No data</div>",
      );
      this.bindLayerPanelControls();
	      return;
	    }

	    const layerEntries = this.getLayerPanelEntries().map((entry) => ({
	      key: entry.renderKey,
	      sourceKey: entry.sourceKey,
	      name: entry.name,
	      zOffset: entry.zOffset,
	      classification: entry.classification,
	      color: entry.color,
	      group: entry.stackEntry?.group,
	      isTextLayer: entry.isTextLayer,
	    }));

    const typeGroups = new Map<string, typeof layerEntries>();
    const typeOrder = [
      "metal",
      "via",
      "contact",
      "poly",
      "active",
      "well",
      "doping",
      "waveguide",
      "slab",
      "heater",
      "trench",
      "cladding",
      "resistor",
      "capacitor",
      "diode",
      "boundary",
      "annotation",
      "simulation",
      "unknown",
    ];

    for (const entry of layerEntries) {
      const type = entry.classification.type;
      if (!typeGroups.has(type)) {
        typeGroups.set(type, []);
      }
      typeGroups.get(type)!.push(entry);
    }

    for (const group of typeGroups.values()) {
      group.sort((a, b) => b.zOffset - a.zOffset);
    }

    const typeLabels: Record<string, string> = {
      metal: "Metal",
      via: "Via",
      contact: "Contact",
      poly: "Poly",
      active: "Active",
      well: "Well",
      doping: "Doping",
      waveguide: "Waveguide",
      slab: "Slab",
      heater: "Heater",
      trench: "Trench",
      cladding: "Cladding",
      resistor: "Resistor",
      capacitor: "Capacitor",
      diode: "Diode",
      boundary: "Boundary",
      annotation: "Annotation",
      simulation: "Simulation",
      unknown: "Other",
    };

	    let contentHtml = "";
	    if (this.derivedWarnings.length > 0) {
	      contentHtml += `
	        <div style="margin-top:8px;padding:6px 8px;border-radius:6px;background:rgba(255,153,0,0.15);color:#ffcc80;font-size:11px;line-height:1.3;">
	          Derived geometry loaded with ${this.derivedWarnings.length} warning(s). See console for details.
	        </div>
	      `;
	    }

    for (const type of typeOrder) {
      const group = typeGroups.get(type);
      if (!group || group.length === 0) continue;

      const groupId = `layer-group-${type}`;
      const label = typeLabels[type] || type;

      contentHtml += `
        <div style="margin-top:12px;">
          <div class="layer-group-header" data-group="${groupId}" 
            style="display:flex;align-items:center;cursor:pointer;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.1);">
            <span class="collapse-icon" style="margin-right:6px;font-size:10px;">▼</span>
            <strong style="font-size:12px;">${label}</strong>
            <span style="margin-left:auto;font-size:11px;color:#888;">${group.length}</span>
          </div>
          <div class="layer-group-content" id="${groupId}">
      `;

	      for (const {
	        key,
	        name,
	        classification,
	        isTextLayer,
	        color,
	        group: entryGroup,
	      } of group) {
	        const checked = this.layerVisibility.get(key) ? "checked" : "";
	        const dimStyle = classification.isAnnotation ? "opacity:0.6;" : "";
	        const textBadge = isTextLayer
	          ? '<span style="font-size:9px;background:#4a4a8a;padding:1px 4px;border-radius:3px;margin-left:4px;">TEXT</span>'
	          : "";
	        const groupLabel = entryGroup
	          ? (this.derivedUiGroups?.get(entryGroup) ?? entryGroup)
	          : null;
	        const groupBadge = groupLabel
	          ? `<span style="font-size:9px;background:#2b7a4b;padding:1px 4px;border-radius:3px;margin-left:4px;">${groupLabel}</span>`
	          : "";

        contentHtml += `
          <label style="display:flex;align-items:center;margin-top:6px;cursor:pointer;padding-left:16px;${dimStyle}">
            <input type="checkbox" ${checked} data-layer="${key}" 
              style="margin-right:8px;cursor:pointer;">
            <span style="width:12px;height:12px;background:${color};
              border-radius:2px;margin-right:8px;flex-shrink:0;"></span>
	            <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;">${name}${textBadge}${groupBadge}</span>
	          </label>
	        `;
	      }

      contentHtml += "</div></div>";
    }

    this.layerPanel.innerHTML = this.renderLayerPanelShell(contentHtml);
    this.bindLayerPanelControls();
    this.updatePanelLayout();
  }

  private renderLayerPanelShell(contentHtml: string): string {
    const buttonLabel = this.layersCollapsed ? "Show" : "Hide";
    return `
      <div data-role="layer-panel-header" style="display:flex;align-items:center;gap:8px;">
        <strong>Layers</strong>
        <button data-role="layer-toggle" style="margin-left:auto;padding:2px 6px;border-radius:4px;border:1px solid rgba(255,255,255,0.2);background:transparent;color:inherit;font-size:11px;cursor:pointer;">
          ${buttonLabel}
        </button>
      </div>
      <div data-role="layer-panel-content" style="${this.layersCollapsed ? "display:none;" : ""}overflow-y:auto;">
        ${contentHtml}
      </div>
    `;
  }

  private bindLayerPanelControls() {
    const toggle = this.layerPanel.querySelector(
      '[data-role="layer-toggle"]',
    ) as HTMLButtonElement | null;
    toggle?.addEventListener("click", (e) => {
      e.preventDefault();
      this.setLayersCollapsed(!this.layersCollapsed, true);
    });

    this.layerPanel.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.addEventListener("change", (e) => {
        const target = e.target as HTMLInputElement;
        const layerKey = target.dataset["layer"];
        if (layerKey) {
          this.setLayerVisibility(layerKey, target.checked);
        }
      });
    });

    this.layerPanel
      .querySelectorAll(".layer-group-header")
      .forEach((header) => {
        header.addEventListener("click", () => {
          const groupId = (header as HTMLElement).dataset["group"];
          if (!groupId) return;
          const content = this.layerPanel.querySelector(
            `#${groupId}`,
          ) as HTMLElement;
          const icon = header.querySelector(".collapse-icon") as HTMLElement;
          if (!content || !icon) return;

          const isCollapsed = content.style.display === "none";
          content.style.display = isCollapsed ? "block" : "none";
          icon.textContent = isCollapsed ? "▼" : "▶";
      });
    });
  }

  private setLayersCollapsed(collapsed: boolean, updateAttribute: boolean) {
    this.layersCollapsed = collapsed;
    if (updateAttribute) {
      if (collapsed) {
        this.setAttribute("layers-collapsed", "");
      } else {
        this.removeAttribute("layers-collapsed");
      }
    }
    const content = this.layerPanel.querySelector(
      '[data-role="layer-panel-content"]',
    ) as HTMLElement | null;
    if (content) {
      content.style.display = collapsed ? "none" : "block";
    }
    const toggle = this.layerPanel.querySelector(
      '[data-role="layer-toggle"]',
    ) as HTMLButtonElement | null;
    if (toggle) {
      toggle.textContent = collapsed ? "Show" : "Hide";
    }
    this.updatePanelLayout();
  }

  private setLayerVisibility(layerKey: string, visible: boolean) {
    this.layerVisibility.set(layerKey, visible);

    if (this.modelGroup) {
      this.modelGroup.traverse((obj) => {
        if (
          (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) &&
          obj.userData["layerKey"] === layerKey
        ) {
          obj.visible = visible;
        }
      });
    }

    if (this.textGroup) {
      this.textGroup.traverse((obj) => {
        if (
          obj instanceof THREE.Group &&
          obj.userData["layerKey"] === layerKey
        ) {
          obj.visible = visible;
        }
      });
    }
  }

  private setupLights() {}

  private fitCameraToModel() {
    if (!this.modelGroup) return;

    const box = new THREE.Box3().setFromObject(this.modelGroup);
    const center = box.getCenter(new THREE.Vector3());

    this.resetCameraView(box, center);
  }

  private resetCameraView(
    box?: THREE.Box3,
    center?: THREE.Vector3,
    distance?: number,
  ) {
    if (!this.modelGroup) return;

    if (!box) {
      box = new THREE.Box3().setFromObject(this.modelGroup);
    }
    if (!center) {
      center = box.getCenter(new THREE.Vector3());
    }
    if (!distance) {
      const size = box.getSize(new THREE.Vector3());
      const fovRad = this.perspectiveCamera.fov * (Math.PI / 180);
      const aspect = this.perspectiveCamera.aspect;

      const distanceForHeight = size.y / 2 / Math.tan(fovRad / 2);
      const distanceForWidth = size.x / 2 / Math.tan(fovRad / 2) / aspect;

      distance = Math.max(distanceForHeight, distanceForWidth) * 1.05;
    }

    this.perspectiveCamera.position.set(
      center.x,
      center.y,
      center.z + distance,
    );
    this.orthoCamera.position.set(center.x, center.y, center.z + distance);
    this.controls.target.copy(center);
    this.controls.update();

    this.perspectiveCamera.near = distance / 100;
    this.perspectiveCamera.far = distance * 100;
    this.perspectiveCamera.updateProjectionMatrix();

    this.updateOrthoCamera();

    const fovRad = this.perspectiveCamera.fov * (Math.PI / 180);
    this.baseViewHeight = 2 * distance * Math.tan(fovRad / 2);
  }

  private updateOrthoCamera() {
    const rect = this.container.getBoundingClientRect();
    const aspect = (rect.width || 1) / (rect.height || 1);
    const distance = this.perspectiveCamera.position.distanceTo(
      this.controls.target,
    );
    const fovRad = this.perspectiveCamera.fov * (Math.PI / 180);
    const height = distance * Math.tan(fovRad / 2) * 2;
    const width = height * aspect;

    this.orthoCamera.left = -width / 2;
    this.orthoCamera.right = width / 2;
    this.orthoCamera.top = height / 2;
    this.orthoCamera.bottom = -height / 2;
    this.orthoCamera.near = 0.1;
    this.orthoCamera.far = distance * 100;
    this.orthoCamera.updateProjectionMatrix();
  }

  private handleResize() {
    const rect = this.container.getBoundingClientRect();
    const width = rect.width || 1;
    const height = rect.height || 1;

    this.perspectiveCamera.aspect = width / height;
    this.perspectiveCamera.updateProjectionMatrix();
    this.updateOrthoCamera();
    this.renderer.setSize(width, height);
    this.updatePanelLayout();
  }

  private startRenderLoop() {
    this.renderer.setAnimationLoop(() => {
      if (!this.rendererReady && this.renderer.backend) {
        this.rendererReady = true;
        this.updateControlsPanel();
      }

      this.controls.update();

      const rect = this.container.getBoundingClientRect();
      this.scaleRuler.update(
        this.activeCamera,
        rect.height,
        this.controls.target,
      );
      this.gridOverlay.update(
        this.activeCamera,
        this.controls.target,
        this.scaleRuler.getGridSpacing(),
        this.renderer.getPixelRatio(),
      );
      this.measurementTool.updateLabels();

      if (this.textGroup) {
        textRenderer.updateTextScales(
          this.textGroup,
          this.activeCamera,
          this.baseViewHeight,
          this.controls.target,
        );
      }

      this.renderer.render(this.scene, this.activeCamera);
    });
  }

  private updatePanelLayout() {
    const gap = 12;
    const controlsRect = this.controlsPanel?.getBoundingClientRect();
    const layersRect = this.layerPanel?.getBoundingClientRect();
    const header = this.layerPanel.querySelector(
      '[data-role="layer-panel-header"]',
    ) as HTMLElement | null;
    const content = this.layerPanel.querySelector(
      '[data-role="layer-panel-content"]',
    ) as HTMLElement | null;
    if (!controlsRect || !layersRect || !header || !content) return;
    const availableHeight = controlsRect.top - layersRect.top - gap;
    const headerHeight = header.getBoundingClientRect().height;
    const layerStyles = getComputedStyle(this.layerPanel);
    const paddingTop = parseFloat(layerStyles.paddingTop) || 0;
    const paddingBottom = parseFloat(layerStyles.paddingBottom) || 0;
    const borderTop = parseFloat(layerStyles.borderTopWidth) || 0;
    const borderBottom = parseFloat(layerStyles.borderBottomWidth) || 0;
    const chromeHeight =
      headerHeight + paddingTop + paddingBottom + borderTop + borderBottom;
    const contentMaxHeight = Math.max(80, availableHeight - chromeHeight);
    content.style.maxHeight = `${contentMaxHeight}px`;
    this.layerPanel.style.maxHeight = "";
  }

  private toggle2DMode() {
    this.is2DMode = !this.is2DMode;

    const currentTarget = this.controls.target.clone();

    if (this.is2DMode) {
      this.modelGroup?.scale.setZ(0.001);
      this.textGroup?.scale.setZ(0.001);
      this.apply2DCompositing();

      this.activeCamera = this.orthoCamera;
      this.controls.object = this.activeCamera;
      this.controls.enableRotate = false;
      this.controls.screenSpacePanning = true;
      this.controls.mouseButtons = {
        LEFT: THREE.MOUSE.PAN,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: undefined as unknown as THREE.MOUSE,
      };

      this.measurementTool.setCamera(this.orthoCamera);
      this.measurementTool.setActive(true);

      this.switchTo2DView(currentTarget);
      this.controls.update();
    } else {
      this.modelGroup?.scale.setZ(this.zScale);
      this.textGroup?.scale.setZ(this.zScale);
      this.apply2DCompositing();

      this.activeCamera = this.perspectiveCamera;
      this.controls.object = this.activeCamera;
      this.controls.enableRotate = true;
      this.controls.screenSpacePanning = true;
      this.controls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN,
      };

      this.measurementTool.setActive(false);

      this.switchTo3DView(currentTarget);
    }

    this.updateControlsPanel();
  }

  private apply2DCompositing() {
    if (!this.modelGroup) return;

    const styles = getComputedStyle(this);
    const scaleRaw = parseFloat(
      styles.getPropertyValue("--gds-2d-opacity-scale").trim(),
    );
    const minOpacityRaw = parseFloat(
      styles.getPropertyValue("--gds-2d-opacity-min").trim(),
    );
    const scale = Number.isFinite(scaleRaw)
      ? THREE.MathUtils.clamp(scaleRaw, 0.05, 1)
      : 0.72;
    const minOpacity = Number.isFinite(minOpacityRaw)
      ? THREE.MathUtils.clamp(minOpacityRaw, 0, 1)
      : 0.16;

    this.modelGroup.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      if (!(obj.material instanceof THREE.MeshBasicMaterial)) return;

      const material = obj.material;
      const previous = this.meshMaterialState.get(obj);
      if (!previous) {
        this.meshMaterialState.set(obj, {
          opacity: material.opacity,
          transparent: material.transparent,
        });
      }

      const baseOpacity = previous?.opacity ?? material.opacity;
      const targetOpacity = THREE.MathUtils.clamp(
        baseOpacity * scale,
        minOpacity,
        1,
      );
      const transparent = targetOpacity < 0.999;
      const transparentChanged = material.transparent !== transparent;

      material.opacity = targetOpacity;
      material.transparent = transparent;

      if (transparentChanged) {
        material.needsUpdate = true;
      }
    });
  }

  private switchTo2DView(preservedTarget: THREE.Vector3) {
    const distance = this.perspectiveCamera.position.distanceTo(
      this.controls.target,
    );
    const fovRad = this.perspectiveCamera.fov * (Math.PI / 180);
    const viewHeight = distance * Math.tan(fovRad / 2) * 2;

    const rect = this.container.getBoundingClientRect();
    const aspect = (rect.width || 1) / (rect.height || 1);
    const halfHeight = viewHeight / 2;

    this.orthoCamera.zoom = 1;
    this.orthoCamera.left = -halfHeight * aspect;
    this.orthoCamera.right = halfHeight * aspect;
    this.orthoCamera.top = halfHeight;
    this.orthoCamera.bottom = -halfHeight;
    this.orthoCamera.near = 0.1;
    this.orthoCamera.far = 10000;
    this.orthoCamera.updateProjectionMatrix();

    this.orthoCamera.position.set(preservedTarget.x, preservedTarget.y, 1000);
    this.orthoCamera.up.set(0, 1, 0);
    this.orthoCamera.lookAt(preservedTarget.x, preservedTarget.y, 0);
    this.controls.target.set(preservedTarget.x, preservedTarget.y, 0);
  }

  private switchTo3DView(preservedTarget: THREE.Vector3) {
    const viewHeight =
      (this.orthoCamera.top - this.orthoCamera.bottom) /
      (this.orthoCamera.zoom || 1);
    const fovRad = this.perspectiveCamera.fov * (Math.PI / 180);
    const zDistance = viewHeight / 2 / Math.tan(fovRad / 2);

    this.perspectiveCamera.position.set(
      preservedTarget.x,
      preservedTarget.y,
      zDistance,
    );
    this.perspectiveCamera.up.set(0, 0, 1);
    this.controls.target.set(preservedTarget.x, preservedTarget.y, 0);
    this.controls.update();

    this.perspectiveCamera.near = zDistance / 100;
    this.perspectiveCamera.far = zDistance * 100;
    this.perspectiveCamera.updateProjectionMatrix();
  }

  private resetToDefaultView() {
    if (!this.modelGroup) return;

    const box = new THREE.Box3().setFromObject(this.modelGroup);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    if (this.is2DMode) {
      const rect = this.container.getBoundingClientRect();
      const aspect = (rect.width || 1) / (rect.height || 1);

      const halfHeight = (size.y / 2) * 1.05;
      const halfWidth = (size.x / 2) * 1.05;
      const fitHeight = halfHeight;
      const fitWidth = halfWidth / aspect;
      const viewHalfSize = Math.max(fitHeight, fitWidth);

      this.orthoCamera.left = -viewHalfSize * aspect;
      this.orthoCamera.right = viewHalfSize * aspect;
      this.orthoCamera.top = viewHalfSize;
      this.orthoCamera.bottom = -viewHalfSize;
      this.orthoCamera.zoom = 1;
      this.orthoCamera.updateProjectionMatrix();

      this.orthoCamera.position.set(center.x, center.y, 1000);
      this.orthoCamera.lookAt(center.x, center.y, 0);
      this.controls.target.set(center.x, center.y, 0);
      this.controls.update();
    } else {
      this.resetCameraView(box, center);
    }
  }

  private disposeGroup(group: THREE.Group) {
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => m.dispose());
        } else {
          obj.material.dispose();
        }
      } else if (obj instanceof THREE.LineSegments) {
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => m.dispose());
        } else {
          obj.material.dispose();
        }
      } else if (obj instanceof THREE.Sprite) {
        const material = obj.material as THREE.SpriteMaterial;
        if (material.map) material.map.dispose();
        material.dispose();
      }
    });
  }

  async loadGdsFile(file: File): Promise<void> {
    const buffer = await file.arrayBuffer();
    this.gdsDocument = await parseGDSII(buffer);
    this.lypResult = null;
    this.derivedSchema = null;
    this.derivedUiGroups = null;
    this.derivedWarnings = [];
    this.layerStack = this.createDefaultLayerStack();
    await this.buildAndRenderModel();
  }

  async loadGdsAndLypFiles(gdsFile: File, lypFile: File): Promise<void> {
    const gdsPromise = gdsFile
      .arrayBuffer()
      .then((buffer) => parseGDSII(buffer));
    const lypPromise = loadLypFromFileInWorker(lypFile);

    const [gdsDocument, lypResult] = await Promise.all([
      gdsPromise,
      lypPromise,
    ]);

    this.gdsDocument = gdsDocument;
    this.lypResult = lypResult;
    this.derivedSchema = null;
    this.derivedUiGroups = null;
    this.derivedWarnings = [];
    this.layerStack = this.createLayerStackFromLyp(lypResult);
    await this.buildAndRenderModel();
  }

  async loadGdsBuffer(buffer: ArrayBuffer): Promise<void> {
    this.gdsDocument = await parseGDSII(buffer);
    this.lypResult = null;
    this.derivedSchema = null;
    this.derivedUiGroups = null;
    this.derivedWarnings = [];
    this.layerStack = this.createDefaultLayerStack();
    await this.buildAndRenderModel();
  }

  setLayerStack(config: LayerStackConfig): void {
    this.lypResult = null;
    this.derivedSchema = null;
    this.derivedUiGroups = null;
    this.derivedWarnings = [];
    this.layerStack = config;
    if (this.gdsDocument) {
      void this.buildAndRenderModel();
    }
  }

  setProcessStack(config: ProcessStackConfig): void {
    this.lypResult = null;
    this.derivedSchema = null;
    this.derivedUiGroups = null;
    this.derivedWarnings = [];
    this.layerStack = this.createLayerStackFromProcessStack(config);
    if (this.gdsDocument) {
      void this.buildAndRenderModel();
    }
  }

  setDerivedGeometry(config: DerivedGeometrySchema): void {
    this.lypResult = null;
    this.derivedSchema = config;
    this.layerStack = this.createLayerStackFromDerivedGeometry(config);
    if (this.gdsDocument) {
      void this.buildAndRenderModel();
    }
  }

  async loadLypFile(file: File): Promise<void> {
    this.lypResult = await loadLypFromFileInWorker(file);
    this.derivedSchema = null;
    this.derivedUiGroups = null;
    this.derivedWarnings = [];
    this.layerStack = this.createLayerStackFromLyp(this.lypResult);
    if (this.gdsDocument) {
      await this.buildAndRenderModel();
    }
  }

  async loadLypFromUrl(url: string): Promise<void> {
    this.lypResult = await loadLypFromUrlInWorker(url);
    this.derivedSchema = null;
    this.derivedUiGroups = null;
    this.derivedWarnings = [];
    this.layerStack = this.createLayerStackFromLyp(this.lypResult);
    if (this.gdsDocument) {
      await this.buildAndRenderModel();
    }
  }

  async loadLypFromString(xmlString: string): Promise<void> {
    this.lypResult = await parseLypFileInWorker(xmlString);
    this.derivedSchema = null;
    this.derivedUiGroups = null;
    this.derivedWarnings = [];
    this.layerStack = this.createLayerStackFromLyp(this.lypResult);
    if (this.gdsDocument) {
      await this.buildAndRenderModel();
    }
  }

  async loadDerivedGeometryFromUrl(url: string): Promise<void> {
    const derived = await fetch(url).then((r) => r.json());
    this.layerStack = this.createLayerStackFromDerivedGeometry(derived);
    if (this.gdsDocument) {
      await this.buildAndRenderModel();
    }
  }

  async loadDerivedGeometryFromString(jsonString: string): Promise<void> {
    const derived = JSON.parse(jsonString) as unknown;
    this.layerStack = this.createLayerStackFromDerivedGeometry(derived);
    if (this.gdsDocument) {
      await this.buildAndRenderModel();
    }
  }

  async loadProcessStackFromUrl(url: string): Promise<void> {
    const processStack = await fetch(url).then((r) => r.json());
    this.derivedSchema = null;
    this.derivedUiGroups = null;
    this.derivedWarnings = [];
    this.layerStack = this.createLayerStackFromProcessStack(processStack);
    if (this.gdsDocument) {
      await this.buildAndRenderModel();
    }
  }

  async loadProcessStackFromString(jsonString: string): Promise<void> {
    const processStack = JSON.parse(jsonString) as unknown;
    this.derivedSchema = null;
    this.derivedUiGroups = null;
    this.derivedWarnings = [];
    this.layerStack = this.createLayerStackFromProcessStack(processStack);
    if (this.gdsDocument) {
      await this.buildAndRenderModel();
    }
  }

  async loadGdsFromArrayBuffer(
    buffer: ArrayBuffer,
    _filename?: string,
  ): Promise<void> {
    this.gdsDocument = await parseGDSII(buffer);
    if (!this.layerStack) {
      this.layerStack = this.createDefaultLayerStack();
    }
    await this.buildAndRenderModel();
  }

  getDocument(): GDSDocument | null {
    return this.gdsDocument;
  }

  getLayerStack(): LayerStackConfig | null {
    return this.layerStack;
  }

  getBackend(): "webgpu" | "webgl" {
    const backend = this.renderer.backend as { isWebGPUBackend?: boolean };
    return backend.isWebGPUBackend ? "webgpu" : "webgl";
  }

  set2DMode(enabled: boolean): void {
    if (enabled === this.is2DMode) return;
    this.toggle2DMode();
  }

  setLypLayerOrdering(ordering: "lyp" | "lyp-reverse" | "classification"): void {
    this.setAttribute("lyp-layer-ordering", ordering);
  }

  focusOn(
    x: number,
    y: number,
    options?: { viewHeightUm?: number },
  ): void {
    const target = new THREE.Vector3(x, y, 0);
    const currentTarget = this.controls.target.clone();
    const active = this.activeCamera;
    const delta = active.position.clone().sub(currentTarget);

    if (options?.viewHeightUm && options.viewHeightUm > 0) {
      if (active instanceof THREE.PerspectiveCamera) {
        const fovRad = active.fov * (Math.PI / 180);
        const distance = options.viewHeightUm / 2 / Math.tan(fovRad / 2);
        const dir =
          delta.lengthSq() > 0 ? delta.normalize() : new THREE.Vector3(0, 0, 1);
        active.position.copy(target.clone().add(dir.multiplyScalar(distance)));
      } else {
        const viewHeight = active.top - active.bottom;
        active.zoom = viewHeight / options.viewHeightUm;
        active.updateProjectionMatrix();
      }
    } else {
      active.position.copy(target.clone().add(delta));
    }

    if (active instanceof THREE.OrthographicCamera) {
      active.position.set(target.x, target.y, active.position.z);
      active.up.set(0, 1, 0);
      active.lookAt(target.x, target.y, 0);
    }

    this.controls.target.copy(target);
    this.controls.update();
  }
}

customElements.define("gds-viewer", GdsViewer);
