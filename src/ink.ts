import * as THREE from 'three';

/**
 * Manga-ink post pass. The scene renders three times' worth of data:
 *   1. colour (toon lit) + depth
 *   2. view-space normals
 * then a fullscreen shader draws ink where normals or depth jump (silhouettes AND creases),
 * adds halftone screentone in the shade, and misregisters the colour plates toward the frame edge.
 */
const vert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const frag = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tColor;
uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform vec2 uRes;
uniform float uNear;
uniform float uFar;
uniform float uTime;
uniform float uLine;      // line width in px
uniform float uDot;       // halftone cell size in px
uniform vec3 uInk;
uniform vec3 uPaper;

float lin(float d) {
  float z = d * 2.0 - 1.0;
  return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec2 px = 1.0 / uRes;

  // hand-drawn wobble: re-rolled 10x/second
  float tick = floor(uTime * 10.0);
  vec2 wob = (vec2(hash(vUv * 91.0 + tick), hash(vUv * 57.0 - tick)) - 0.5) * px * 1.2;
  vec2 uv = vUv + wob;

  // --- ink lines: normal + depth discontinuities ---
  vec2 o = px * uLine;
  vec3 n0 = texture2D(tNormal, uv).rgb;
  vec3 n1 = texture2D(tNormal, uv + vec2( o.x, 0.0)).rgb;
  vec3 n2 = texture2D(tNormal, uv + vec2(-o.x, 0.0)).rgb;
  vec3 n3 = texture2D(tNormal, uv + vec2(0.0,  o.y)).rgb;
  vec3 n4 = texture2D(tNormal, uv + vec2(0.0, -o.y)).rgb;
  float d0 = lin(texture2D(tDepth, uv).r);
  float d1 = lin(texture2D(tDepth, uv + vec2( o.x, 0.0)).r);
  float d2 = lin(texture2D(tDepth, uv + vec2(-o.x, 0.0)).r);
  float d3 = lin(texture2D(tDepth, uv + vec2(0.0,  o.y)).r);
  float d4 = lin(texture2D(tDepth, uv + vec2(0.0, -o.y)).r);

  float eN = length(n1 - n0) + length(n2 - n0) + length(n3 - n0) + length(n4 - n0);
  // depth edge relative to distance so far things don't turn to soup
  float eD = (abs(d1 - d0) + abs(d2 - d0) + abs(d3 - d0) + abs(d4 - d0)) / max(d0, 0.5);
  float crease = smoothstep(0.35, 0.8, eN);          // folds >~ 40deg
  float sil    = smoothstep(0.025, 0.08, eD);         // silhouettes / occlusion
  float haze   = 1.0 - smoothstep(60.0, 160.0, d0);  // lines fade into the distance
  float line   = max(crease, sil) * mix(0.35, 1.0, haze);

  // --- colour with plate misregistration toward frame edges ---
  vec2 c = vUv - 0.5;
  float edge = dot(c, c) * 4.0;
  vec2 mis = c * edge * px * 6.0;
  vec3 col = vec3(
    texture2D(tColor, vUv + mis).r,
    texture2D(tColor, vUv).g,
    texture2D(tColor, vUv - mis).b
  );

  // --- halftone screentone in shadow ---
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  float ca = 0.7071, sa = 0.7071; // 45 deg screen
  vec2 g = gl_FragCoord.xy / uDot;
  vec2 r = vec2(g.x * ca - g.y * sa, g.x * sa + g.y * ca);
  vec2 cell = fract(r) - 0.5;
  float dist = length(cell);
  float shade = 1.0 - smoothstep(0.12, 0.6, lum);     // 0 = lit, 1 = deep shade
  float radius = shade * 0.5;
  float dots = 1.0 - smoothstep(radius - 0.08, radius + 0.04, dist);
  dots *= step(0.02, shade);
  col = mix(col, col * 0.45 + uInk * 0.2, dots * 0.6);

  // paper tint + grain
  col = mix(col, col * uPaper, 0.35);
  col += (hash(gl_FragCoord.xy + tick) - 0.5) * 0.025;

  // ink on top
  col = mix(col, uInk, line);

  // vignette
  col *= 1.0 - smoothstep(0.35, 1.1, edge) * 0.35;

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

export class InkPipeline {
  private rtColor: THREE.WebGLRenderTarget;
  private rtNormal: THREE.WebGLRenderTarget;
  private quad: THREE.Mesh;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private normalMat = new THREE.MeshNormalMaterial();
  private mat: THREE.ShaderMaterial;
  private size = new THREE.Vector2();
  /** objects drawn in colour only (rain, light beams): kept out of the normal pass so they don't get inked */
  readonly hide: THREE.Object3D[] = [];

  constructor(private renderer: THREE.WebGLRenderer) {
    const mk = () => {
      const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
      rt.depthTexture = new THREE.DepthTexture(4, 4);
      rt.depthTexture.type = THREE.UnsignedIntType;
      rt.texture.minFilter = rt.texture.magFilter = THREE.NearestFilter;
      return rt;
    };
    this.rtColor = mk();
    this.rtNormal = mk();
    this.rtColor.texture.minFilter = this.rtColor.texture.magFilter = THREE.LinearFilter;

    this.mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tColor: { value: this.rtColor.texture },
        tNormal: { value: this.rtNormal.texture },
        tDepth: { value: this.rtColor.depthTexture },
        uRes: { value: new THREE.Vector2(1, 1) },
        uNear: { value: 0.1 },
        uFar: { value: 300 },
        uTime: { value: 0 },
        uLine: { value: 1.2 },
        uDot: { value: 5 },
        uInk: { value: new THREE.Color(0x14121c) },
        uPaper: { value: new THREE.Color(0xf6ecd4) },
      },
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  resize(): void {
    this.renderer.getDrawingBufferSize(this.size);
    const w = this.size.x, h = this.size.y;
    this.rtColor.setSize(w, h);
    this.rtNormal.setSize(w, h);
    this.mat.uniforms.uRes.value.set(w, h);
    // keep line weight visually constant across pixel ratios
    this.mat.uniforms.uLine.value = Math.max(1, h / 900);
    this.mat.uniforms.uDot.value = Math.max(4, Math.round(h / 190));
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, time: number): void {
    const r = this.renderer;
    this.mat.uniforms.uNear.value = camera.near;
    this.mat.uniforms.uFar.value = camera.far;
    this.mat.uniforms.uTime.value = time;

    r.setRenderTarget(this.rtColor);
    r.render(scene, camera);

    const bg = scene.background;
    const fog = scene.fog;
    scene.background = null;
    scene.fog = null;
    for (const o of this.hide) o.visible = false;
    scene.overrideMaterial = this.normalMat;
    r.setRenderTarget(this.rtNormal);
    r.setClearColor(0x000000, 1);
    r.clear();
    // the normal pass never samples shadows: don't let three re-render the shadow map a second time this frame
    const shadowAuto = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;
    r.render(scene, camera);
    r.shadowMap.autoUpdate = shadowAuto;
    scene.overrideMaterial = null;
    for (const o of this.hide) o.visible = true;
    scene.background = bg;
    scene.fog = fog;

    r.setRenderTarget(null);
    r.render(this.quadScene, this.quadCam);
  }
}
