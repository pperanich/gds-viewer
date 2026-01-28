import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import {
  Fn,
  vec4,
  uniform,
  positionWorld,
  cameraPosition,
  floor,
  mix,
  wgslFn,
  Discard,
  If,
} from "three/tsl";

// Ben Golus's "Pristine Grid" algorithm: https://bgolus.medium.com/the-best-darn-grid-shader-yet-727f9278b9d8
const pristineGridWGSL = wgslFn(/* wgsl */ `
  fn pristineGrid(uv: vec2f, lineWidth: f32, gridDiv: f32) -> f32 {
    let div = max(0.1, gridDiv);
    let uvScaled = uv / div;

    let uvDDX = dpdx(uvScaled);
    let uvDDY = dpdy(uvScaled);
    let uvDeriv = vec2f(length(vec2f(uvDDX.x, uvDDY.x)), length(vec2f(uvDDX.y, uvDDY.y)));

    let scaledLineWidth = lineWidth / div;
    let targetWidth = vec2f(clamp(scaledLineWidth, 0.0, 0.5));
    let drawWidth = clamp(targetWidth, uvDeriv, vec2f(0.5));

    let lineAA = uvDeriv * 1.5;
    let gridUV = 1.0 - abs(fract(uvScaled) * 2.0 - 1.0);

    var grid2 = smoothstep(drawWidth + lineAA, drawWidth - lineAA, gridUV);
    grid2 = grid2 * clamp(targetWidth / drawWidth, vec2f(0.0), vec2f(1.0));
    grid2 = mix(grid2, targetWidth, clamp(uvDeriv * 2.0 - 1.0, vec2f(0.0), vec2f(1.0)));

    return mix(grid2.x, 1.0, grid2.y);
  }
`);

export class GridOverlay {
  private mesh: THREE.Mesh;
  private material: MeshBasicNodeMaterial;
  private gridSize: number = 100000;

  private uScale = uniform(1.0);
  private uMajorGridFactor = uniform(10.0);
  private uMinorLineWidth = uniform(0.02);
  private uMajorLineWidth = uniform(0.04);
  private uMajorLineColor = uniform(new THREE.Color(0x666666));
  private uMinorLineColor = uniform(new THREE.Color(0x888888));
  private uOpacity = uniform(0.4);

  constructor() {
    const gridShader = Fn(() => {
      const scale = this.uScale;
      const majorGridFactor = this.uMajorGridFactor;
      const minorLineWidthU = this.uMinorLineWidth;
      const majorLineWidthU = this.uMajorLineWidth;
      const majorLineColor = this.uMajorLineColor;
      const minorLineColor = this.uMinorLineColor;
      const opacity = this.uOpacity;

      const majorGridSize = scale.mul(majorGridFactor);
      const cameraCenteringOffset = floor(cameraPosition.xy.div(majorGridSize)).mul(majorGridSize);
      const worldPos = positionWorld.xy;
      const uv = worldPos.sub(cameraCenteringOffset);

      const majorAlpha = pristineGridWGSL({
        uv: uv,
        lineWidth: majorLineWidthU.mul(scale),
        gridDiv: majorGridSize,
      });

      const minorAlpha = pristineGridWGSL({
        uv: uv,
        lineWidth: minorLineWidthU.mul(scale),
        gridDiv: scale,
      });

      const minorCol = vec4(minorLineColor, minorAlpha);
      const col = mix(minorCol, vec4(majorLineColor, 1.0), majorAlpha);
      const finalAlpha = col.w.mul(opacity);

      If(finalAlpha.lessThan(0.01), () => {
        Discard();
      });

      return vec4(col.xyz, finalAlpha);
    });

    this.material = new MeshBasicNodeMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
    });
    this.material.outputNode = gridShader();

    const geometry = new THREE.PlaneGeometry(this.gridSize, this.gridSize);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.rotation.x = 0;
    this.mesh.renderOrder = 999;
  }

  getObject(): THREE.Mesh {
    return this.mesh;
  }

  setColor(color: string, opacity: number = 0.4) {
    const c = new THREE.Color(color);
    this.uMinorLineColor.value = c;
    this.uMajorLineColor.value = c.clone().multiplyScalar(0.7);
    this.uOpacity.value = opacity;
  }

  setVisible(visible: boolean) {
    this.mesh.visible = visible;
  }

  update(controlsTarget: THREE.Vector3, gridSpacing: number) {
    this.uScale.value = gridSpacing;
    this.mesh.position.set(controlsTarget.x, controlsTarget.y, -0.01);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
