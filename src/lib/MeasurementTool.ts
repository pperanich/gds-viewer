import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const CAP_LENGTH_PX = 10;
const ENDPOINT_HIT_RADIUS_PX = 12;
const SNAP_ANGLE_DEG = 3;

interface MeasurementStyles {
  color: string;
  lineWidth: number;
  font: string;
  fontSize: string;
  labelBg: string;
  labelRadius: string;
}

const DEFAULT_STYLES: MeasurementStyles = {
  color: "#ff6600",
  lineWidth: 3,
  font: "monospace",
  fontSize: "12px",
  labelBg: "rgba(255, 255, 255, 0.9)",
  labelRadius: "3px",
};

interface Measurement {
  id: number;
  startPoint: THREE.Vector3;
  endPoint: THREE.Vector3;
  lines: Line2[];
  labelDiv: HTMLDivElement | null;
  labelOffsetPx: { x: number; y: number };
  labelRotation: number;
  labelScale: number;
  baseZoom: number;
}

type DragMode = 
  | { type: "label"; measurement: Measurement }
  | { type: "endpoint"; measurement: Measurement; which: "start" | "end" }
  | { type: "rotate"; measurement: Measurement }
  | { type: "scale"; measurement: Measurement };

export class MeasurementTool {
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private camera: THREE.OrthographicCamera | THREE.PerspectiveCamera;
  
  private isActive: boolean = false;
  private isMeasuring: boolean = false;
  private measureShiftHeld: boolean = false;
  private currentStart: THREE.Vector3 | null = null;
  private currentEnd: THREE.Vector3 | null = null;
  
  private measurements: Measurement[] = [];
  private nextId: number = 0;
  private activeMeasurement: Measurement | null = null;
  private selectedMeasurement: Measurement | null = null;
  
  private dragMode: DragMode | null = null;
  private dragStartMouse: { x: number; y: number } | null = null;
  private dragStartOffset: { x: number; y: number } | null = null;
  private dragStartScale: number = 1;
  
  private lineGroup: THREE.Group;
  private lineMaterial: LineMaterial;
  private controls: OrbitControls | null = null;
  
  private labelContainer: HTMLDivElement;
  private styles: MeasurementStyles = { ...DEFAULT_STYLES };
  private hostElement: HTMLElement | null = null;

  constructor(container: HTMLElement, canvas: HTMLCanvasElement, scene: THREE.Scene) {
    this.container = container;
    this.canvas = canvas;
    this.camera = new THREE.OrthographicCamera();
    
    this.lineGroup = new THREE.Group();
    this.lineGroup.name = "measurement";
    this.lineGroup.renderOrder = 1000;
    scene.add(this.lineGroup);
    
    this.lineMaterial = new LineMaterial({
      color: parseInt(DEFAULT_STYLES.color.replace("#", ""), 16),
      linewidth: DEFAULT_STYLES.lineWidth,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      worldUnits: false,
    });

    this.labelContainer = document.createElement("div");
    this.labelContainer.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      overflow: hidden;
    `;
    this.container.appendChild(this.labelContainer);

    this.setupEventListeners();
  }

  private setupEventListeners() {
    this.canvas.addEventListener("mousedown", this.onMouseDown);
    this.canvas.addEventListener("mousemove", this.onMouseMove);
    this.canvas.addEventListener("mouseup", this.onMouseUp);
    this.canvas.addEventListener("contextmenu", this.onContextMenu);
    
    document.addEventListener("mousemove", this.onDocumentMouseMove);
    document.addEventListener("mouseup", this.onDocumentMouseUp);
  }

  private onContextMenu = (e: MouseEvent) => {
    if (this.isActive) {
      e.preventDefault();
    }
  };
  
  private onDocumentMouseMove = (e: MouseEvent) => {
    if (!this.dragMode || !this.dragStartMouse) return;
    
    if (this.dragMode.type === "label" && this.dragStartOffset) {
      const scale = this.getZoom() / this.dragMode.measurement.baseZoom;
      const dx = (e.clientX - this.dragStartMouse.x) / scale;
      const dy = (e.clientY - this.dragStartMouse.y) / scale;
      
      this.dragMode.measurement.labelOffsetPx.x = this.dragStartOffset.x + dx;
      this.dragMode.measurement.labelOffsetPx.y = this.dragStartOffset.y + dy;
      this.updateLabelPosition(this.dragMode.measurement);
    } else if (this.dragMode.type === "endpoint") {
      const worldPos = this.screenToWorld(e.clientX, e.clientY);
      if (this.dragMode.which === "start") {
        this.dragMode.measurement.startPoint.copy(worldPos);
      } else {
        this.dragMode.measurement.endPoint.copy(worldPos);
      }
      this.rebuildMeasurementLines(this.dragMode.measurement);
      this.updateLabel(this.dragMode.measurement);
    } else if (this.dragMode.type === "rotate") {
      const center = this.getLabelScreenCenter(this.dragMode.measurement);
      const angle = Math.atan2(
        e.clientY - center.y,
        e.clientX - center.x
      );
      this.dragMode.measurement.labelRotation = angle + Math.PI / 2;
      this.updateLabelPosition(this.dragMode.measurement);
    } else if (this.dragMode.type === "scale") {
      const dx = e.clientX - this.dragStartMouse.x;
      const dy = e.clientY - this.dragStartMouse.y;
      const delta = (dx + dy) / 100;
      this.dragMode.measurement.labelScale = Math.max(0.25, Math.min(4, this.dragStartScale + delta));
      this.updateLabelPosition(this.dragMode.measurement);
    }
  };
  
  private onDocumentMouseUp = (e: MouseEvent) => {
    if (e.button !== 0 || !this.dragMode) return;
    
    if (this.controls) this.controls.enabled = true;
    this.canvas.style.cursor = "";
    this.dragMode = null;
    this.dragStartMouse = null;
    this.dragStartOffset = null;
  };

  private onMouseDown = (e: MouseEvent) => {
    if (!this.isActive) return;
    
    if (e.button === 0) {
      const endpoint = this.getEndpointAtScreenPos(e.clientX, e.clientY);
      if (endpoint) {
        e.preventDefault();
        e.stopPropagation();
        if (this.controls) this.controls.enabled = false;
        this.dragMode = { type: "endpoint", measurement: endpoint.measurement, which: endpoint.which };
        this.dragStartMouse = { x: e.clientX, y: e.clientY };
        this.canvas.style.cursor = "move";
        return;
      }
      
      this.setSelectedMeasurement(null);
    }
    
    if (e.button !== 2) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    this.isMeasuring = true;
    this.measureShiftHeld = e.shiftKey;
    this.currentStart = this.screenToWorld(e.clientX, e.clientY);
    this.currentEnd = this.currentStart.clone();
    
    this.activeMeasurement = {
      id: this.nextId++,
      startPoint: this.currentStart.clone(),
      endPoint: this.currentEnd.clone(),
      lines: [],
      labelDiv: null,
      labelOffsetPx: { x: 0, y: 0 },
      labelRotation: 0,
      labelScale: 1,
      baseZoom: this.getZoom(),
    };
    
    this.updateActiveMeasurementLines();
  };

  private onMouseMove = (e: MouseEvent) => {
    if (!this.isActive) return;
    
    if (!this.isMeasuring && !this.dragMode) {
      const endpoint = this.getEndpointAtScreenPos(e.clientX, e.clientY);
      this.canvas.style.cursor = endpoint ? "move" : "";
    }
    
    if (!this.isMeasuring || !this.currentStart || !this.activeMeasurement) return;
    
    let endPoint = this.screenToWorld(e.clientX, e.clientY);
    
    if (!this.measureShiftHeld) {
      endPoint = this.applyAxisSnap(this.currentStart, endPoint);
    }
    
    this.currentEnd = endPoint;
    this.activeMeasurement.endPoint.copy(this.currentEnd);
    this.updateActiveMeasurementLines();
    this.updateLabel(this.activeMeasurement);
  };

  private applyAxisSnap(start: THREE.Vector3, end: THREE.Vector3): THREE.Vector3 {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const angle = Math.atan2(Math.abs(dy), Math.abs(dx)) * (180 / Math.PI);
    
    const snapThreshold = SNAP_ANGLE_DEG;
    
    if (angle < snapThreshold) {
      return new THREE.Vector3(end.x, start.y, 0);
    } else if (angle > 90 - snapThreshold) {
      return new THREE.Vector3(start.x, end.y, 0);
    }
    
    return end;
  }

  private onMouseUp = (e: MouseEvent) => {
    if (!this.isActive || e.button !== 2 || !this.isMeasuring) return;
    
    this.isMeasuring = false;
    this.measureShiftHeld = false;
    
    if (this.activeMeasurement) {
      const dist = this.activeMeasurement.startPoint.distanceTo(this.activeMeasurement.endPoint);
      if (dist > 0.001) {
        this.measurements.push(this.activeMeasurement);
        this.setSelectedMeasurement(this.activeMeasurement);
      } else {
        this.clearMeasurementGeometry(this.activeMeasurement);
      }
      this.activeMeasurement = null;
    }
    
    this.currentStart = null;
    this.currentEnd = null;
  };

  private setSelectedMeasurement(measurement: Measurement | null) {
    if (this.selectedMeasurement === measurement) return;
    
    if (this.selectedMeasurement?.labelDiv) {
      this.setHandlesVisible(this.selectedMeasurement.labelDiv, false);
    }
    
    this.selectedMeasurement = measurement;
    
    if (this.selectedMeasurement?.labelDiv) {
      this.setHandlesVisible(this.selectedMeasurement.labelDiv, true);
    }
  }

  private setHandlesVisible(labelDiv: HTMLDivElement, visible: boolean) {
    const handles = labelDiv.querySelectorAll(".scale-handle, .rotate-handle") as NodeListOf<HTMLElement>;
    handles.forEach(h => h.style.display = visible ? "block" : "none");
  }

  private getEndpointAtScreenPos(clientX: number, clientY: number): { measurement: Measurement; which: "start" | "end" } | null {
    const rect = this.canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    
    for (const m of this.measurements) {
      const startScreen = this.worldToScreen(m.startPoint);
      const endScreen = this.worldToScreen(m.endPoint);
      
      if (Math.hypot(mx - startScreen.x, my - startScreen.y) < ENDPOINT_HIT_RADIUS_PX) {
        return { measurement: m, which: "start" };
      }
      if (Math.hypot(mx - endScreen.x, my - endScreen.y) < ENDPOINT_HIT_RADIUS_PX) {
        return { measurement: m, which: "end" };
      }
    }
    return null;
  }

  private getLabelScreenCenter(measurement: Measurement): { x: number; y: number } {
    if (!measurement.labelDiv) {
      return { x: 0, y: 0 };
    }
    
    const labelText = measurement.labelDiv.querySelector(".label-text") as HTMLElement;
    if (!labelText) {
      return { x: 0, y: 0 };
    }
    
    const baseWidth = labelText.offsetWidth;
    const baseHeight = labelText.offsetHeight;
    
    const wrapperLeft = parseFloat(measurement.labelDiv.style.left) || 0;
    const wrapperTop = parseFloat(measurement.labelDiv.style.top) || 0;
    
    const labelContainerRect = this.labelContainer.getBoundingClientRect();
    
    return {
      x: labelContainerRect.left + wrapperLeft + baseWidth / 2,
      y: labelContainerRect.top + wrapperTop + baseHeight / 2,
    };
  }

  private screenToWorld(clientX: number, clientY: number): THREE.Vector3 {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;
    
    const vector = new THREE.Vector3(x, y, 0);
    vector.unproject(this.camera);
    
    return new THREE.Vector3(vector.x, vector.y, 0);
  }

  private worldToScreen(point: THREE.Vector3): { x: number; y: number } {
    const vector = point.clone().project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    
    return {
      x: ((vector.x + 1) / 2) * rect.width,
      y: ((-vector.y + 1) / 2) * rect.height,
    };
  }

  private getZoom(): number {
    if (this.camera instanceof THREE.OrthographicCamera) {
      return this.camera.zoom;
    }
    return 1;
  }

  private getWorldUnitsPerPixel(): number {
    if (this.camera instanceof THREE.OrthographicCamera) {
      const width = this.camera.right - this.camera.left;
      const rect = this.canvas.getBoundingClientRect();
      return width / this.camera.zoom / rect.width;
    }
    return 1;
  }

  private updateActiveMeasurementLines() {
    if (!this.activeMeasurement) return;
    
    this.clearMeasurementLines(this.activeMeasurement);
    this.activeMeasurement.lines = this.createMeasurementLines(
      this.activeMeasurement.startPoint,
      this.activeMeasurement.endPoint
    );
  }

  private rebuildMeasurementLines(measurement: Measurement) {
    this.clearMeasurementLines(measurement);
    measurement.lines = this.createMeasurementLines(measurement.startPoint, measurement.endPoint);
  }

  private createMeasurementLines(start: THREE.Vector3, end: THREE.Vector3): Line2[] {
    const lines: Line2[] = [];
    const worldPerPx = this.getWorldUnitsPerPixel();
    const capLength = CAP_LENGTH_PX * worldPerPx;

    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    
    if (len < 0.0001) return lines;

    const perpX = -dy / len * capLength / 2;
    const perpY = dx / len * capLength / 2;

    const mainGeom = new LineGeometry();
    mainGeom.setPositions([start.x, start.y, 0, end.x, end.y, 0]);
    const mainLine = new Line2(mainGeom, this.lineMaterial);
    mainLine.computeLineDistances();
    mainLine.renderOrder = 9999;
    this.lineGroup.add(mainLine);
    lines.push(mainLine);

    const startCapGeom = new LineGeometry();
    startCapGeom.setPositions([
      start.x + perpX, start.y + perpY, 0,
      start.x - perpX, start.y - perpY, 0,
    ]);
    const startCap = new Line2(startCapGeom, this.lineMaterial);
    startCap.computeLineDistances();
    startCap.renderOrder = 9999;
    this.lineGroup.add(startCap);
    lines.push(startCap);

    const endCapGeom = new LineGeometry();
    endCapGeom.setPositions([
      end.x + perpX, end.y + perpY, 0,
      end.x - perpX, end.y - perpY, 0,
    ]);
    const endCap = new Line2(endCapGeom, this.lineMaterial);
    endCap.computeLineDistances();
    endCap.renderOrder = 9999;
    this.lineGroup.add(endCap);
    lines.push(endCap);

    return lines;
  }

  private clearMeasurementLines(measurement: Measurement) {
    for (const line of measurement.lines) {
      line.geometry.dispose();
      this.lineGroup.remove(line);
    }
    measurement.lines = [];
  }

  private clearMeasurementGeometry(measurement: Measurement) {
    this.clearMeasurementLines(measurement);
    if (measurement.labelDiv) {
      this.labelContainer.removeChild(measurement.labelDiv);
      measurement.labelDiv = null;
    }
  }

  private updateLabelPosition(measurement: Measurement) {
    if (!measurement.labelDiv) return;
    
    const midpoint = new THREE.Vector3().addVectors(
      measurement.startPoint,
      measurement.endPoint
    ).multiplyScalar(0.5);
    
    const screenPos = this.worldToScreen(midpoint);
    const zoomScale = this.getZoom() / measurement.baseZoom;
    const totalScale = zoomScale * measurement.labelScale;
    
    const labelContent = measurement.labelDiv.querySelector(".label-content") as HTMLElement;
    if (!labelContent) return;
    
    const labelText = labelContent.querySelector(".label-text") as HTMLElement;
    if (!labelText) return;

    const baseWidth = labelText.offsetWidth;
    const baseHeight = labelText.offsetHeight;
    
    const centerX = screenPos.x + measurement.labelOffsetPx.x * zoomScale;
    const centerY = screenPos.y + measurement.labelOffsetPx.y * zoomScale;
    
    const x = centerX - baseWidth / 2;
    const y = centerY - baseHeight / 2;
    
    measurement.labelDiv.style.left = `${x}px`;
    measurement.labelDiv.style.top = `${y}px`;
    
    labelContent.style.transform = `scale(${totalScale}) rotate(${measurement.labelRotation}rad)`;
  }

  private updateLabel(measurement: Measurement) {
    const distance = measurement.startPoint.distanceTo(measurement.endPoint);
    const text = this.formatDistanceText(distance);
    
    if (distance < 0.001) {
      if (measurement.labelDiv) {
        this.labelContainer.removeChild(measurement.labelDiv);
        measurement.labelDiv = null;
      }
      return;
    }
    
    if (!measurement.labelDiv) {
      measurement.labelDiv = this.createLabelElement(measurement);
      this.labelContainer.appendChild(measurement.labelDiv);
    }
    
    const labelText = measurement.labelDiv.querySelector(".label-text") as HTMLElement;
    if (labelText) {
      labelText.textContent = text;
    }
    this.updateLabelPosition(measurement);
  }

  private createLabelElement(measurement: Measurement): HTMLDivElement {
    const wrapper = document.createElement("div");
    wrapper.style.cssText = `position: absolute; pointer-events: auto;`;
    
    const labelContent = document.createElement("div");
    labelContent.className = "label-content";
    labelContent.style.cssText = `
      position: relative;
      display: inline-block;
      transform-origin: center center;
    `;
    
    const labelText = document.createElement("div");
    labelText.className = "label-text";
    labelText.style.cssText = `
      color: ${this.styles.color};
      font-family: ${this.styles.font};
      font-size: ${this.styles.fontSize};
      font-weight: bold;
      background: ${this.styles.labelBg};
      padding: 2px 6px;
      border-radius: ${this.styles.labelRadius};
      border: 1px solid ${this.styles.color};
      white-space: nowrap;
      user-select: none;
      cursor: grab;
    `;
    
    labelText.addEventListener("mousedown", (e) => {
      if (e.button === 0) {
        e.preventDefault();
        e.stopPropagation();
        this.setSelectedMeasurement(measurement);
        this.dragMode = { type: "label", measurement };
        this.dragStartMouse = { x: e.clientX, y: e.clientY };
        this.dragStartOffset = { ...measurement.labelOffsetPx };
        this.canvas.style.cursor = "grabbing";
      } else if (e.button === 2) {
        e.preventDefault();
        e.stopPropagation();
        this.removeMeasurement(measurement.id);
      }
    });
    labelText.addEventListener("contextmenu", (e) => e.preventDefault());
    
    labelContent.appendChild(labelText);
    
    const scaleHandle = document.createElement("div");
    scaleHandle.className = "scale-handle";
    scaleHandle.style.cssText = `
      position: absolute;
      right: -2px;
      bottom: -2px;
      width: 12px;
      height: 12px;
      cursor: nwse-resize;
      display: none;
    `;
    
    const scaleSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    scaleSvg.setAttribute("width", "12");
    scaleSvg.setAttribute("height", "12");
    scaleSvg.setAttribute("viewBox", "0 0 12 12");
    scaleSvg.innerHTML = `<path d="M 0 12 Q 12 12 12 0" fill="none" stroke="${this.styles.color}" stroke-width="2"/>`;
    scaleHandle.appendChild(scaleSvg);
    
    scaleHandle.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.dragMode = { type: "scale", measurement };
      this.dragStartMouse = { x: e.clientX, y: e.clientY };
      this.dragStartScale = measurement.labelScale;
    });
    
    labelContent.appendChild(scaleHandle);
    
    const rotateHandle = document.createElement("div");
    rotateHandle.className = "rotate-handle";
    rotateHandle.style.cssText = `
      position: absolute;
      left: 50%;
      top: -20px;
      transform: translateX(-50%);
      width: 12px;
      height: 12px;
      background: ${this.styles.color};
      border: 1px solid white;
      border-radius: 50%;
      cursor: crosshair;
      display: none;
    `;
    
    rotateHandle.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.dragMode = { type: "rotate", measurement };
      this.dragStartMouse = { x: e.clientX, y: e.clientY };
    });
    
    labelContent.appendChild(rotateHandle);
    
    wrapper.appendChild(labelContent);
    
    const isSelected = this.selectedMeasurement === measurement;
    this.setHandlesVisible(wrapper, isSelected);
    
    return wrapper;
  }

  private formatDistanceText(um: number): string {
    const { value, unit } = this.formatDistance(um);
    return `${value} ${unit}`;
  }

  private formatDistance(um: number): { value: string; unit: string } {
    if (um >= 1000) {
      return { value: (um / 1000).toFixed(2), unit: "mm" };
    } else if (um >= 1) {
      return { value: um.toFixed(2), unit: "µm" };
    } else {
      return { value: (um * 1000).toFixed(2), unit: "nm" };
    }
  }

  private removeMeasurement(id: number) {
    const index = this.measurements.findIndex(m => m.id === id);
    if (index === -1) return;
    
    const measurement = this.measurements[index]!;
    if (this.selectedMeasurement === measurement) {
      this.selectedMeasurement = null;
    }
    this.clearMeasurementGeometry(measurement);
    this.measurements.splice(index, 1);
  }

  updateLabels() {
    for (const measurement of this.measurements) {
      this.updateLabelPosition(measurement);
    }
    if (this.activeMeasurement) {
      this.updateLabelPosition(this.activeMeasurement);
    }
  }

  setCamera(camera: THREE.OrthographicCamera | THREE.PerspectiveCamera) {
    this.camera = camera;
  }

  setControls(controls: OrbitControls) {
    this.controls = controls;
  }

  setActive(active: boolean) {
    this.isActive = active;
    this.labelContainer.style.display = active ? "block" : "none";
    if (!active) {
      this.clearAll();
    }
  }

  setResolution(width: number, height: number) {
    this.lineMaterial.resolution.set(width, height);
  }

  setHostElement(host: HTMLElement) {
    this.hostElement = host;
    this.updateStylesFromCSS();
  }

  updateStylesFromCSS() {
    if (!this.hostElement) return;
    
    const computed = getComputedStyle(this.hostElement);
    
    const color = computed.getPropertyValue("--gds-measure-color").trim();
    const lineWidth = computed.getPropertyValue("--gds-measure-line-width").trim();
    const font = computed.getPropertyValue("--gds-measure-font").trim();
    const fontSize = computed.getPropertyValue("--gds-measure-font-size").trim();
    const labelBg = computed.getPropertyValue("--gds-measure-label-bg").trim();
    const labelRadius = computed.getPropertyValue("--gds-measure-label-radius").trim();
    
    this.styles = {
      color: color || DEFAULT_STYLES.color,
      lineWidth: lineWidth ? parseInt(lineWidth, 10) : DEFAULT_STYLES.lineWidth,
      font: font || DEFAULT_STYLES.font,
      fontSize: fontSize || DEFAULT_STYLES.fontSize,
      labelBg: labelBg || DEFAULT_STYLES.labelBg,
      labelRadius: labelRadius || DEFAULT_STYLES.labelRadius,
    };
    
    const colorNum = parseInt(this.styles.color.replace("#", ""), 16);
    this.lineMaterial.color.setHex(colorNum);
    this.lineMaterial.linewidth = this.styles.lineWidth;
    
    this.updateAllLabelStyles();
  }

  private updateAllLabelStyles() {
    for (const measurement of this.measurements) {
      if (measurement.labelDiv) {
        this.applyStylesToLabel(measurement.labelDiv);
      }
    }
  }

  private applyStylesToLabel(labelDiv: HTMLDivElement) {
    const labelText = labelDiv.querySelector(".label-text") as HTMLElement;
    if (labelText) {
      labelText.style.color = this.styles.color;
      labelText.style.fontFamily = this.styles.font;
      labelText.style.fontSize = this.styles.fontSize;
      labelText.style.background = this.styles.labelBg;
      labelText.style.borderRadius = this.styles.labelRadius;
      labelText.style.borderColor = this.styles.color;
    }
    
    const scaleHandle = labelDiv.querySelector(".scale-handle svg path") as SVGPathElement;
    if (scaleHandle) {
      scaleHandle.setAttribute("stroke", this.styles.color);
    }
    
    const rotateHandle = labelDiv.querySelector(".rotate-handle") as HTMLElement;
    if (rotateHandle) {
      rotateHandle.style.background = this.styles.color;
    }
  }

  clearAll() {
    this.isMeasuring = false;
    this.measureShiftHeld = false;
    this.currentStart = null;
    this.currentEnd = null;
    this.canvas.style.cursor = "";
    this.selectedMeasurement = null;
    
    if (this.activeMeasurement) {
      this.clearMeasurementGeometry(this.activeMeasurement);
      this.activeMeasurement = null;
    }
    
    for (const measurement of this.measurements) {
      this.clearMeasurementGeometry(measurement);
    }
    this.measurements = [];
  }

  dispose() {
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
    this.canvas.removeEventListener("mousemove", this.onMouseMove);
    this.canvas.removeEventListener("mouseup", this.onMouseUp);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    document.removeEventListener("mousemove", this.onDocumentMouseMove);
    document.removeEventListener("mouseup", this.onDocumentMouseUp);
    this.clearAll();
    this.lineMaterial.dispose();
    this.container.removeChild(this.labelContainer);
  }
}
