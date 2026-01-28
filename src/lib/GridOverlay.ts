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
  max,
} from "three/tsl";

// Ben Golus's "Pristine Grid" algorithm: https://bgolus.medium.com/the-best-darn-grid-shader-yet-727f9278b9d8
const pristineGridWGSL = wgslFn(/* wgsl */ `
  fn pristineGrid(uv: vec2f, lineWidthPx: f32, gridDiv: f32, pixelRatio: f32) -> f32 {
    let div = max(0.0001, gridDiv);
    let uvScaled = uv / div;

    let uvDDX = dpdx(uvScaled);
    let uvDDY = dpdy(uvScaled);
    let uvDeriv = vec2f(length(vec2f(uvDDX.x, uvDDY.x)), length(vec2f(uvDDX.y, uvDDY.y)));

    let lineWidthScaled = pixelRatio * lineWidthPx * uvDeriv;
    let targetWidth = clamp(lineWidthScaled, vec2f(0.0), vec2f(0.5));
    let drawWidth = clamp(targetWidth, uvDeriv, vec2f(0.5));

    let lineAA = uvDeriv * 1.5;
    let gridUV = 1.0 - abs(fract(uvScaled) * 2.0 - 1.0);

    var grid2 = smoothstep(drawWidth + lineAA, drawWidth - lineAA, gridUV);
    grid2 = grid2 * clamp(targetWidth / drawWidth, vec2f(0.0), vec2f(1.0));
    grid2 = mix(grid2, targetWidth, clamp(uvDeriv * 2.0 - 1.0, vec2f(0.0), vec2f(1.0)));

    return mix(grid2.x, 1.0, grid2.y);
  }
`);

function createInfiniteGridGeometry(): THREE.BufferGeometry {
  // Near quad (unit size, will be scaled by shader/update) + far quad (200x larger)
  // Forms a ring pattern: far quad with near quad hole, plus near quad
  //
  //  x-----------------x
  //  |\\             //|
  //  | \\           // |
  //  |  \\         //  |
  //  |   x---------x   |
  //  |   |         |   |
  //  |   |  NEAR   |   |
  //  |   |         |   |
  //  |   x---------x   |
  //  |  //         \\  |
  //  | //           \\ |
  //  |//             \\|
  //  x-----------------x

  const nearScale = 1.0;
  const farScale = 200.0;

  const positions = new Float32Array([
    -nearScale, -nearScale, 0,
     nearScale, -nearScale, 0,
    -nearScale,  nearScale, 0,
     nearScale,  nearScale, 0,
    -farScale, -farScale, 0,
     farScale, -farScale, 0,
    -farScale,  farScale, 0,
     farScale,  farScale, 0,
  ]);

  const indices = new Uint16Array([
    0, 1, 2, 2, 1, 3,
    4, 5, 0, 0, 5, 1,
    5, 7, 1, 1, 7, 3,
    7, 6, 3, 3, 6, 2,
    6, 4, 2, 2, 4, 0,
  ]);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}

export class GridOverlay {
  private mesh: THREE.Mesh;
  private material: MeshBasicNodeMaterial;

  private uScale = uniform(1.0);
  private uMajorGridFactor = uniform(10.0);
  private uMinorLineWidthPx = uniform(1.0);
  private uMajorLineWidthPx = uniform(2.0);
  private uMajorLineColor = uniform(new THREE.Color(0x666666));
  private uMinorLineColor = uniform(new THREE.Color(0x888888));
  private uOpacity = uniform(0.4);
  private uPixelRatio = uniform(1.0);

  constructor() {
    const gridShader = Fn(() => {
      const scale = this.uScale;
      const majorGridFactor = this.uMajorGridFactor;
      const minorLineWidthPx = this.uMinorLineWidthPx;
      const majorLineWidthPx = this.uMajorLineWidthPx;
      const majorLineColor = this.uMajorLineColor;
      const minorLineColor = this.uMinorLineColor;
      const opacity = this.uOpacity;
      const pixelRatio = this.uPixelRatio;

      const majorGridSize = max(scale.mul(majorGridFactor), 0.0001);
      const cameraCenteringOffset = floor(cameraPosition.xy.div(majorGridSize)).mul(majorGridSize);
      const worldPos = positionWorld.xy;
      const uv = worldPos.sub(cameraCenteringOffset);

      const majorAlpha = pristineGridWGSL({
        uv: uv,
        lineWidthPx: majorLineWidthPx,
        gridDiv: majorGridSize,
        pixelRatio: pixelRatio,
      });

      const minorScale = max(scale, 0.0001);
      const minorAlpha = pristineGridWGSL({
        uv: uv,
        lineWidthPx: minorLineWidthPx,
        gridDiv: minorScale,
        pixelRatio: pixelRatio,
      });

      const minorCol = vec4(minorLineColor, minorAlpha);
      const col = mix(minorCol, vec4(majorLineColor, 1.0), majorAlpha);
      const finalAlpha = col.w.mul(opacity);

      If(finalAlpha.lessThan(0.001), () => {
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

    const geometry = createInfiniteGridGeometry();
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
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

  update(
    camera: THREE.OrthographicCamera | THREE.PerspectiveCamera,
    controlsTarget: THREE.Vector3,
    gridSpacing: number,
    pixelRatio: number = 1.0,
  ) {
    this.uScale.value = gridSpacing;
    this.uPixelRatio.value = pixelRatio;

    let gridMultiplier: number;
    if (camera instanceof THREE.OrthographicCamera) {
      const viewWidth = (camera.right - camera.left) / camera.zoom;
      const viewHeight = (camera.top - camera.bottom) / camera.zoom;
      gridMultiplier = Math.max(viewWidth, viewHeight);
    } else {
      const distance = camera.position.distanceTo(controlsTarget);
      gridMultiplier = distance * 2;
    }

    this.mesh.scale.set(gridMultiplier, gridMultiplier, 1);
    this.mesh.position.set(camera.position.x, camera.position.y, -0.01);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
