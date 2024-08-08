import * as THREE from "three";

const vertexShader = `
varying vec4 vUv;

uniform float uScale;
uniform float uMajorGridFactor;

void main() {
    vec4 worldPos4 = modelMatrix * vec4(position, 1.0);
    vec3 worldPos = worldPos4.xyz;

    float division = uScale * uMajorGridFactor;
    vec3 cameraCenteringOffset = floor(cameraPosition / division) * division;
    
    vUv.xy = (worldPos - cameraCenteringOffset).xy;
    vUv.zw = worldPos.xy;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = `
varying vec4 vUv;

uniform float uScale;
uniform float uMajorGridFactor;
uniform float uMinorLineWidth;
uniform float uMajorLineWidth;
uniform vec3 uMinorLineColor;
uniform vec3 uMajorLineColor;
uniform float uOpacity;

vec2 saturate2(vec2 value) {
    return clamp(value, 0.0, 1.0);
}

void main() {
    float majorGridSize = uScale * uMajorGridFactor;

    vec4 uvDDXY = vec4(dFdx(vUv.xy), dFdy(vUv.xy));
    vec2 uvDeriv = vec2(length(uvDDXY.xz), length(uvDDXY.yw));

    // Major grid
    float majorDiv = max(0.1, majorGridSize);
    vec2 majorUVDeriv = uvDeriv / majorDiv;
    float majorLineWidth = uMajorLineWidth * uScale / majorDiv;
    vec2 majorDrawWidth = clamp(vec2(majorLineWidth), majorUVDeriv, vec2(0.5));
    vec2 majorLineAA = majorUVDeriv * 1.5;
    vec2 majorGridUV = 1.0 - abs(fract(vUv.xy / majorDiv) * 2.0 - 1.0);
    vec2 majorGrid2 = smoothstep(majorDrawWidth + majorLineAA, majorDrawWidth - majorLineAA, majorGridUV);
    majorGrid2 *= saturate2(majorLineWidth / majorDrawWidth);
    majorGrid2 = mix(majorGrid2, vec2(majorLineWidth), saturate2(majorUVDeriv * 2.0 - 1.0));

    // Minor grid
    float minorDiv = max(0.1, uScale);
    vec2 minorUVDeriv = uvDeriv / minorDiv;
    float minorLineWidth = uMinorLineWidth * uScale / minorDiv;
    vec2 minorDrawWidth = clamp(vec2(minorLineWidth), minorUVDeriv, vec2(0.5));
    vec2 minorLineAA = minorUVDeriv * 1.5;
    vec2 minorGridUV = 1.0 - abs(fract(vUv.xy / minorDiv) * 2.0 - 1.0);
    vec2 minorGrid2 = smoothstep(minorDrawWidth + minorLineAA, minorDrawWidth - minorLineAA, minorGridUV);
    minorGrid2 *= saturate2(minorLineWidth / minorDrawWidth);
    minorGrid2 = mix(minorGrid2, vec2(minorLineWidth), saturate2(minorUVDeriv * 2.0 - 1.0));

    // Combine grids
    float minorGrid = mix(minorGrid2.x, 1.0, minorGrid2.y);
    float majorGrid = mix(majorGrid2.x, 1.0, majorGrid2.y);

    vec4 col = vec4(uMinorLineColor, minorGrid);
    col = mix(col, vec4(uMajorLineColor, 1.0), majorGrid);
    col.a *= uOpacity;

    if (col.a < 0.01) discard;
    
    gl_FragColor = col;
}
`;

export class GridOverlay {
  private mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private gridSize: number = 100000;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uScale: { value: 1.0 },
        uMajorGridFactor: { value: 10.0 },
        uMinorLineWidth: { value: 0.02 },
        uMajorLineWidth: { value: 0.04 },
        uMinorLineColor: { value: new THREE.Color(0x888888) },
        uMajorLineColor: { value: new THREE.Color(0x666666) },
        uOpacity: { value: 0.4 },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
    });

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
    this.material.uniforms.uMinorLineColor!.value = c;
    this.material.uniforms.uMajorLineColor!.value = c.clone().multiplyScalar(0.7);
    this.material.uniforms.uOpacity!.value = opacity;
  }

  setVisible(visible: boolean) {
    this.mesh.visible = visible;
  }

  update(controlsTarget: THREE.Vector3, gridSpacing: number) {
    this.material.uniforms.uScale!.value = gridSpacing;
    this.mesh.position.set(controlsTarget.x, controlsTarget.y, -0.01);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
