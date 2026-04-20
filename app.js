/**
 * CS:Craft Skin Maker — Projection Painter
 *
 * Fluxo:
 *  1. Carrega geometria JSON (bones + cubes com UV).
 *  2. A imagem aparece como um DECAL flutuante em cima do viewport 3D.
 *  3. Você orbita a arma pra mirar, move/escala/gira o decal na tela.
 *  4. "Gravar" faz raycasting: cada pixel do decal vira um raio pela câmera.
 *     O primeiro hit (ou todos, se X-Ray) é pintado na UV atlas.
 *  5. Baixa a PNG já no formato (texture_width × texture_height) do JSON.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

'use strict';

const SCALE = 1 / 16;
const $ = id => document.getElementById(id);

const S = {
  // Geometry
  geo: null,
  geoMeta: null,
  texW: 64,
  texH: 64,
  allMeshes: [],

  // Three.js
  renderer: null,
  scene: null,
  camera: null,
  controls: null,
  meshGroup: null,

  // Persistent baked texture (applied to the 3D model)
  bakeCanvas: null,
  bakeCtx: null,
  bakeTex: null,

  // Atlas preview (read-only)
  atlasCanvas: null,
  atlasCtx: null,
  uvRects: [],
  uvBBox: null,

  // User image + cached pixel buffer
  userImg: null,
  userImgW: 0,
  userImgH: 0,
  userImgPixels: null,
  decalTex: null,          // THREE.Texture of userImg (for live projection shader)

  // Screen-space decal state (viewport pixel coords)
  decal: null,   // { cx, cy, baseW, baseH, scale, rot, opacity }

  // X-Ray mode (paint through model onto back faces too)
  xray: false,

  // Live projection (second pass on each cube)
  decalPassMeshes: [],     // THREE.Mesh[] sharing decalUniforms
  decalUniforms: null,     // shared uniforms object

  // Drag state
  dragMode: null,          // 'move' | 'scale' | 'rotate'
  dragStart: null,
};

// Vertex shader for the live decal pass — just passes clip-space position
const DECAL_VERT = /* glsl */`
  varying vec4 vClip;
  void main() {
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vClip = clip;
    gl_Position = clip;
  }
`;

// Fragment shader: projects the decal image onto the fragment in screen space.
// fragPx comes from the fragment's clip-space position, and we test if it falls
// inside the (possibly rotated) decal rectangle on screen.
const DECAL_FRAG = /* glsl */`
  precision mediump float;
  uniform sampler2D uDecalMap;
  uniform float uHasDecal;
  uniform vec2 uCenterPx;
  uniform vec2 uSizePx;
  uniform float uRotRad;
  uniform float uOpacity;
  uniform vec2 uViewportPx;
  varying vec4 vClip;

  void main() {
    if (uHasDecal < 0.5) discard;
    if (vClip.w <= 0.0) discard;
    vec2 ndc = vClip.xy / vClip.w;
    vec2 fragPx = vec2(
      (ndc.x * 0.5 + 0.5) * uViewportPx.x,
      (1.0 - (ndc.y * 0.5 + 0.5)) * uViewportPx.y
    );
    vec2 local = fragPx - uCenterPx;
    float c = cos(-uRotRad);
    float s = sin(-uRotRad);
    vec2 rotated = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
    vec2 uv = rotated / uSizePx + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
    vec4 decal = texture2D(uDecalMap, vec2(uv.x, 1.0 - uv.y));
    if (decal.a < 0.01) discard;
    gl_FragColor = vec4(decal.rgb, decal.a * uOpacity);
  }
`;

function makeDecalUniforms() {
  return {
    uDecalMap:    { value: null },
    uHasDecal:    { value: 0 },
    uCenterPx:    { value: new THREE.Vector2() },
    uSizePx:      { value: new THREE.Vector2(1, 1) },
    uRotRad:      { value: 0 },
    uOpacity:     { value: 1 },
    uViewportPx:  { value: new THREE.Vector2(1, 1) },
  };
}

function makeDecalMaterial(uniforms, xray) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: DECAL_VERT,
    fragmentShader: DECAL_FRAG,
    transparent: true,
    depthTest: !xray,
    depthWrite: false,
    side: xray ? THREE.DoubleSide : THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
}

// ════════════════════════════════
// INIT
// ════════════════════════════════
function init() {
  initBakeTexture();
  initThree();
  initAtlasPreview();
  wireUi();
  positionDecalOverlay();
}

function initBakeTexture() {
  S.bakeCanvas = document.createElement('canvas');
  S.bakeCanvas.width = S.texW;
  S.bakeCanvas.height = S.texH;
  S.bakeCtx = S.bakeCanvas.getContext('2d', { willReadFrequently: true });
  S.bakeTex = new THREE.CanvasTexture(S.bakeCanvas);
  S.bakeTex.colorSpace = THREE.SRGBColorSpace;
  S.bakeTex.magFilter = THREE.NearestFilter;
  S.bakeTex.minFilter = THREE.NearestFilter;
  S.bakeTex.generateMipmaps = false;
}

function resizeBakeTexture(w, h) {
  S.bakeCanvas.width = w;
  S.bakeCanvas.height = h;
}

function initThree() {
  const vp = $('viewport-3d');
  S.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  S.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  S.renderer.setClearColor(0x070a12, 1);
  vp.appendChild(S.renderer.domElement);

  S.scene = new THREE.Scene();
  S.camera = new THREE.PerspectiveCamera(38, 1, 0.01, 300);
  S.camera.position.set(3, 2, 4);

  S.controls = new OrbitControls(S.camera, S.renderer.domElement);
  S.controls.enableDamping = true;
  S.controls.dampingFactor = 0.08;
  S.controls.minDistance = 0.4;
  S.controls.maxDistance = 30;

  // Soft, even lighting so the texture reads cleanly
  S.scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  const key = new THREE.DirectionalLight(0xffffff, 0.55);
  key.position.set(6, 10, 8);
  S.scene.add(key);
  const rim = new THREE.DirectionalLight(0x9ecbff, 0.25);
  rim.position.set(-6, -3, -7);
  S.scene.add(rim);

  const grid = new THREE.GridHelper(20, 20, 0x12202e, 0x0a131c);
  grid.position.y = -1.2;
  S.scene.add(grid);

  new ResizeObserver(() => {
    const w = vp.clientWidth, h = vp.clientHeight;
    if (!w || !h) return;
    S.renderer.setSize(w, h, false);
    S.camera.aspect = w / h;
    S.camera.updateProjectionMatrix();
  }).observe(vp);

  (function loop() {
    requestAnimationFrame(loop);
    S.controls.update();
    updateDecalUniforms();
    S.renderer.render(S.scene, S.camera);
  })();
}

function updateDecalUniforms() {
  const u = S.decalUniforms;
  if (!u) return;
  const vp = S.renderer.domElement;
  u.uViewportPx.value.set(vp.clientWidth, vp.clientHeight);
  if (!S.decal || !S.decalTex) {
    u.uHasDecal.value = 0;
    return;
  }
  u.uHasDecal.value = 1;
  u.uDecalMap.value = S.decalTex;
  u.uCenterPx.value.set(S.decal.cx, S.decal.cy);
  u.uSizePx.value.set(
    S.decal.baseW * S.decal.scale,
    S.decal.baseH * S.decal.scale
  );
  u.uRotRad.value = (S.decal.rot || 0) * Math.PI / 180;
  u.uOpacity.value = S.decal.opacity;
}

// ════════════════════════════════
// GEOMETRY
// ════════════════════════════════
function parseGeo(data) {
  const geos = data['minecraft:geometry'];
  if (!geos || !geos[0]) {
    toast('JSON sem minecraft:geometry');
    return;
  }
  const geo = geos[0];
  const desc = geo.description || {};
  S.geo = geo;
  S.geoMeta = desc;
  S.texW = desc.texture_width || 64;
  S.texH = desc.texture_height || 64;

  resizeBakeTexture(S.texW, S.texH);
  computeUvRects();
  buildModel();
  S.bakeTex.needsUpdate = true;
  drawAtlasPreview();

  $('vp-empty').style.display = 'none';
  $('header-info').textContent = desc.identifier || '(geometry)';
  $('atlas-meta').textContent = `${S.texW} × ${S.texH} · ${S.uvRects.length} faces UV`;
  toast(`${S.allMeshes.length} cubos carregados`);
}

// Expand Bedrock/Java "box UV" (single [u,v] offset) into per-face UV rects,
// always using POSITIVE uv_size. Orientation handling happens in the cube
// geometry builder (per-face TL/TR/BL/BR vertex assignment).
//
// Layout on the atlas (no mirror):
//   y=v            [  UP (W×D)   ][  DOWN (W×D)  ]
//   y=v+D  [WEST(D×H)][NORTH(W×H)][ EAST(D×H)  ][ SOUTH(W×H) ]
function expandBoxUv(cube) {
  const uv = cube.uv;
  if (!uv) return {};
  if (!Array.isArray(uv)) return uv; // already per-face

  const [u, v] = uv;
  const [W, H, D] = cube.size || [1, 1, 1];
  const out = {
    up:    { uv: [u + D,         v],         uv_size: [W, D] },
    down:  { uv: [u + D + W,     v],         uv_size: [W, D] },
    west:  { uv: [u,             v + D],     uv_size: [D, H] },
    north: { uv: [u + D,         v + D],     uv_size: [W, H] },
    east:  { uv: [u + D + W,     v + D],     uv_size: [D, H] },
    south: { uv: [u + 2 * D + W, v + D],     uv_size: [W, H] },
  };
  if (cube.mirror === true) {
    // Mirrored cubes: swap east/west textures (the common convention)
    const e = out.east; out.east = out.west; out.west = e;
  }
  return out;
}

function computeUvRects() {
  const rects = [];
  (S.geo.bones || []).forEach((bone, bi) => {
    (bone.cubes || []).forEach((cube, ci) => {
      const uvMap = expandBoxUv(cube);
      Object.entries(uvMap).forEach(([face, fd]) => {
        if (!fd || !fd.uv) return;
        const [ux, uy] = fd.uv;
        const [uw, uh] = fd.uv_size || [1, 1];
        rects.push({
          x: Math.min(ux, ux + uw),
          y: Math.min(uy, uy + uh),
          w: Math.abs(uw),
          h: Math.abs(uh),
          face,
          bone: bi,
          cube: ci,
        });
      });
    });
  });
  S.uvRects = rects;
  S.uvBBox = computeBBox(rects);
}

function computeBBox(rects) {
  if (!rects.length) return { x: 0, y: 0, w: S.texW, h: S.texH };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  rects.forEach(r => {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  });
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function buildModel() {
  if (S.meshGroup) S.scene.remove(S.meshGroup);
  S.allMeshes.forEach(m => {
    m.geometry.dispose();
    if (m.material.map !== S.bakeTex) m.material.dispose();
  });
  // Decal pass meshes share geometry with their base sibling (disposed above),
  // so we only dispose the ShaderMaterial here.
  S.decalPassMeshes.forEach(m => m.material.dispose());
  S.allMeshes = [];
  S.decalPassMeshes = [];
  S.decalUniforms = makeDecalUniforms();
  S.meshGroup = new THREE.Group();

  const pivotOf = {};
  (S.geo.bones || []).forEach(bone => {
    const p = bone.pivot || [0, 0, 0];
    pivotOf[bone.name] = [p[0] * SCALE, p[1] * SCALE, p[2] * SCALE];
  });

  const boneGroup = {};
  (S.geo.bones || []).forEach(bone => {
    const g = new THREE.Group();
    g.name = bone.name;
    const myPiv = pivotOf[bone.name];
    if (bone.parent && pivotOf[bone.parent]) {
      const par = pivotOf[bone.parent];
      g.position.set(myPiv[0] - par[0], myPiv[1] - par[1], myPiv[2] - par[2]);
    } else {
      g.position.set(myPiv[0], myPiv[1], myPiv[2]);
    }
    if (bone.rotation) {
      g.rotation.set(
        THREE.MathUtils.degToRad(bone.rotation[0]),
        THREE.MathUtils.degToRad(bone.rotation[1]),
        THREE.MathUtils.degToRad(bone.rotation[2]),
        'ZYX'
      );
    }
    boneGroup[bone.name] = g;
  });

  (S.geo.bones || []).forEach(bone => {
    if (bone.parent && boneGroup[bone.parent]) {
      boneGroup[bone.parent].add(boneGroup[bone.name]);
    } else {
      S.meshGroup.add(boneGroup[bone.name]);
    }
  });

  const sharedMat = new THREE.MeshLambertMaterial({
    map: S.bakeTex,
    color: 0xffffff,
    transparent: true,
    alphaTest: 0.01,
    side: THREE.DoubleSide,
  });

  (S.geo.bones || []).forEach(bone => {
    const g = boneGroup[bone.name];
    const myPiv = pivotOf[bone.name];

    (bone.cubes || []).forEach(cube => {
      const [ox, oy, oz] = cube.origin || [0, 0, 0];
      const [sx, sy, sz] = cube.size || [1, 1, 1];
      const inf = cube.inflate || 0;

      const rw = (sx + inf * 2) * SCALE;
      const rh = (sy + inf * 2) * SCALE;
      const rd = (sz + inf * 2) * SCALE;

      const uvMap = expandBoxUv(cube);
      const geom = buildCubeGeometry(rw, rh, rd, uvMap, S.texW, S.texH);
      const mesh = new THREE.Mesh(geom, sharedMat);

      // Sibling mesh that renders ONLY the live decal projection on top of
      // the main mesh. Shares geometry transform via being added to the same
      // parent; uses a ShaderMaterial with shared uniforms so updating the
      // decal state on a single uniform set animates every cube at once.
      const decalMat = makeDecalMaterial(S.decalUniforms, S.xray);
      const decalMesh = new THREE.Mesh(geom, decalMat);
      decalMesh.renderOrder = 2;

      const cx = (ox + sx / 2) * SCALE;
      const cy = (oy + sy / 2) * SCALE;
      const cz = (oz + sz / 2) * SCALE;

      if (cube.rotation) {
        const p = cube.pivot || [0, 0, 0];
        const px = p[0] * SCALE;
        const py = p[1] * SCALE;
        const pz = p[2] * SCALE;

        const pivGrp = new THREE.Group();
        pivGrp.position.set(px - myPiv[0], py - myPiv[1], pz - myPiv[2]);
        pivGrp.rotation.set(
          THREE.MathUtils.degToRad(cube.rotation[0]),
          THREE.MathUtils.degToRad(cube.rotation[1]),
          THREE.MathUtils.degToRad(cube.rotation[2]),
          'ZYX'
        );
        mesh.position.set(cx - px, cy - py, cz - pz);
        decalMesh.position.copy(mesh.position);
        pivGrp.add(mesh);
        pivGrp.add(decalMesh);
        g.add(pivGrp);
      } else {
        mesh.position.set(cx - myPiv[0], cy - myPiv[1], cz - myPiv[2]);
        decalMesh.position.copy(mesh.position);
        g.add(mesh);
        g.add(decalMesh);
      }

      S.allMeshes.push(mesh);
      S.decalPassMeshes.push(decalMesh);
    });
  });

  S.scene.add(S.meshGroup);

  const box = new THREE.Box3().setFromObject(S.meshGroup);
  if (!box.isEmpty()) {
    const c = box.getCenter(new THREE.Vector3());
    S.meshGroup.position.sub(c);
  }
  resetCam();
}

// Build a cube with explicit per-face vertices, normals, and UVs.
// Each face stores 4 vertices ordered TL, TR, BL, BR in atlas space, with the
// spatial-to-atlas mapping following Blockbench/Bedrock conventions:
//
//   NORTH (-Z, seen from -Z): U+ -> +X, V+ -> -Y
//   SOUTH (+Z, seen from +Z): U+ -> -X, V+ -> -Y
//   EAST  (+X, seen from +X): U+ -> -Z, V+ -> -Y
//   WEST  (-X, seen from -X): U+ -> +Z, V+ -> -Y
//   UP    (+Y, looking down): U+ -> +X, V+ -> -Z  (bottom-of-atlas edge meets NORTH top)
//   DOWN  (-Y, looking down): U+ -> +X, V+ -> +Z  (DOWN flipped vs UP in Z)
function buildCubeGeometry(w, h, d, uvMap, texW, texH) {
  const hx = w / 2, hy = h / 2, hz = d / 2;

  // For each face: 4 vertices ordered [TL, TR, BL, BR] of the atlas rect.
  const FACE_VERTS = {
    east:  [[ hx,  hy,  hz], [ hx,  hy, -hz], [ hx, -hy,  hz], [ hx, -hy, -hz]],
    west:  [[-hx,  hy, -hz], [-hx,  hy,  hz], [-hx, -hy, -hz], [-hx, -hy,  hz]],
    up:    [[-hx,  hy,  hz], [ hx,  hy,  hz], [-hx,  hy, -hz], [ hx,  hy, -hz]],
    down:  [[-hx, -hy, -hz], [ hx, -hy, -hz], [-hx, -hy,  hz], [ hx, -hy,  hz]],
    south: [[ hx,  hy,  hz], [-hx,  hy,  hz], [ hx, -hy,  hz], [-hx, -hy,  hz]],
    north: [[-hx,  hy, -hz], [ hx,  hy, -hz], [-hx, -hy, -hz], [ hx, -hy, -hz]],
  };
  const FACE_NORMAL = {
    east:  [1, 0, 0],
    west:  [-1, 0, 0],
    up:    [0, 1, 0],
    down:  [0, -1, 0],
    south: [0, 0, 1],
    north: [0, 0, -1],
  };

  const order = ['east', 'west', 'up', 'down', 'south', 'north'];
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  order.forEach((face, fi) => {
    const verts = FACE_VERTS[face];
    const nrm = FACE_NORMAL[face];
    verts.forEach(p => positions.push(p[0], p[1], p[2]));
    for (let j = 0; j < 4; j++) normals.push(nrm[0], nrm[1], nrm[2]);

    const fd = uvMap[face];
    if (!fd || !fd.uv) {
      for (let j = 0; j < 4; j++) uvs.push(0, 0);
    } else {
      const [ux, uy] = fd.uv;
      const [uw, uh] = fd.uv_size || [0, 0];
      // Normalize (handle possibly-negative sizes that might still leak in).
      const x0 = Math.min(ux, ux + uw);
      const x1 = Math.max(ux, ux + uw);
      const y0 = Math.min(uy, uy + uh);
      const y1 = Math.max(uy, uy + uh);
      const uL = x0 / texW;
      const uR = x1 / texW;
      const vTop = 1 - y0 / texH;   // atlas top  (v larger)
      const vBot = 1 - y1 / texH;   // atlas base (v smaller)
      // TL, TR, BL, BR
      uvs.push(uL, vTop);
      uvs.push(uR, vTop);
      uvs.push(uL, vBot);
      uvs.push(uR, vBot);
    }

    // CCW triangles viewed from outside the cube:  TL -> BL -> BR, TL -> BR -> TR
    const base = fi * 4;
    indices.push(base + 0, base + 2, base + 3);
    indices.push(base + 0, base + 3, base + 1);
  });

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('normal',   new THREE.Float32BufferAttribute(normals,   3));
  geom.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs,       2));
  geom.setIndex(indices);
  return geom;
}

window.resetCam = function resetCam() {
  if (!S.meshGroup) return;
  const box = new THREE.Box3().setFromObject(S.meshGroup);
  const size = box.getSize(new THREE.Vector3());
  const d = Math.max(size.x, size.y, size.z) * 2.0;
  S.camera.position.set(d * 0.55, d * 0.30, d);
  S.controls.target.set(0, 0, 0);
};

// ════════════════════════════════
// ATLAS PREVIEW  (read-only)
// ════════════════════════════════
function initAtlasPreview() {
  S.atlasCanvas = $('atlas-canvas');
  S.atlasCtx = S.atlasCanvas.getContext('2d');
  new ResizeObserver(() => drawAtlasPreview()).observe(S.atlasCanvas.parentElement);
  drawAtlasPreview();
}

function drawAtlasPreview() {
  const cv = S.atlasCanvas;
  const ctx = S.atlasCtx;
  const wrap = cv.parentElement;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  const aspect = S.texW / S.texH;
  let dispW, dispH;
  if (W / H > aspect) { dispH = H; dispW = H * aspect; }
  else { dispW = W; dispH = W / aspect; }

  const sx = dispW / S.texW;
  const sy = dispH / S.texH;

  const dpr = Math.min(devicePixelRatio, 2);
  cv.width = Math.max(1, Math.floor(dispW * dpr));
  cv.height = Math.max(1, Math.floor(dispH * dpr));
  cv.style.width = dispW + 'px';
  cv.style.height = dispH + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Checker background (transparency indicator)
  ctx.fillStyle = '#141a24';
  ctx.fillRect(0, 0, dispW, dispH);
  ctx.fillStyle = '#1c2333';
  const tile = 8;
  for (let y = 0; y < dispH; y += tile) {
    for (let x = (y / tile) % 2 === 0 ? 0 : tile; x < dispW; x += tile * 2) {
      ctx.fillRect(x, y, tile, tile);
    }
  }

  // Baked texture
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(S.bakeCanvas, 0, 0, dispW, dispH);

  // UV outlines
  ctx.strokeStyle = 'rgba(99, 179, 237, 0.55)';
  ctx.lineWidth = 1;
  S.uvRects.forEach(r => {
    ctx.strokeRect(
      Math.round(r.x * sx) + 0.5,
      Math.round(r.y * sy) + 0.5,
      Math.max(1, Math.round(r.w * sx) - 1),
      Math.max(1, Math.round(r.h * sy) - 1),
    );
  });
}

// ════════════════════════════════
// DECAL OVERLAY  (screen-space sticker)
// ════════════════════════════════
function positionDecalOverlay() {
  const el = $('decal-box');
  if (!el) return;
  if (!S.decal) {
    el.style.display = 'none';
    return;
  }
  const d = S.decal;
  el.style.display = 'block';
  el.style.left = d.cx + 'px';
  el.style.top = d.cy + 'px';
  el.style.width = d.baseW + 'px';
  el.style.height = d.baseH + 'px';
  el.style.transform =
    `translate(-50%, -50%) rotate(${d.rot}deg) scale(${d.scale})`;
  el.style.opacity = d.opacity;
  $('decal-img').src = S.userImg ? S.userImg.src : '';
}

function autoPlaceDecal() {
  const vp = S.renderer.domElement;
  const w = vp.clientWidth, h = vp.clientHeight;
  const target = Math.min(w, h) * 0.35;
  const aspect = S.userImg.naturalWidth / S.userImg.naturalHeight;
  let baseW, baseH;
  if (aspect >= 1) { baseW = target; baseH = target / aspect; }
  else { baseH = target; baseW = target * aspect; }
  S.decal = {
    cx: w / 2, cy: h / 2,
    baseW, baseH,
    scale: 1, rot: 0, opacity: 1,
  };
  $('sl-scale').value = 1;
  $('val-scale').textContent = '1.00';
  $('sl-rot').value = 0;
  $('val-rot').textContent = '0°';
  $('sl-opacity').value = 1;
  $('val-opacity').textContent = '100%';
  positionDecalOverlay();
}

// --- Decal drag handling ---------------------------------------------------
function startDrag(e, mode) {
  if (!S.decal) return;
  e.preventDefault();
  e.stopPropagation();
  S.dragMode = mode;
  S.dragStart = {
    x: e.clientX,
    y: e.clientY,
    decal: { ...S.decal },
  };
  S.controls.enabled = false;
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragUp);
  window.addEventListener('pointercancel', onDragUp);
}

function onDragMove(e) {
  if (!S.dragMode || !S.decal || !S.dragStart) return;
  const dx = e.clientX - S.dragStart.x;
  const dy = e.clientY - S.dragStart.y;
  const start = S.dragStart.decal;

  if (S.dragMode === 'move') {
    S.decal.cx = start.cx + dx;
    S.decal.cy = start.cy + dy;
  } else if (S.dragMode === 'scale') {
    const vp = S.renderer.domElement.getBoundingClientRect();
    const cxAbs = vp.left + start.cx;
    const cyAbs = vp.top + start.cy;
    const d0 = Math.hypot(S.dragStart.x - cxAbs, S.dragStart.y - cyAbs);
    const d1 = Math.hypot(e.clientX - cxAbs, e.clientY - cyAbs);
    if (d0 > 1) {
      const ns = Math.max(0.05, Math.min(20, start.scale * (d1 / d0)));
      S.decal.scale = ns;
      $('sl-scale').value = ns;
      $('val-scale').textContent = ns.toFixed(2);
    }
  } else if (S.dragMode === 'rotate') {
    const vp = S.renderer.domElement.getBoundingClientRect();
    const cxAbs = vp.left + start.cx;
    const cyAbs = vp.top + start.cy;
    const a0 = Math.atan2(S.dragStart.y - cyAbs, S.dragStart.x - cxAbs);
    const a1 = Math.atan2(e.clientY - cyAbs, e.clientX - cxAbs);
    const deg = start.rot + ((a1 - a0) * 180 / Math.PI);
    const clamped = ((deg + 180) % 360 + 360) % 360 - 180;
    S.decal.rot = clamped;
    $('sl-rot').value = clamped;
    $('val-rot').textContent = Math.round(clamped) + '°';
  }

  positionDecalOverlay();
}

function onDragUp() {
  S.dragMode = null;
  S.dragStart = null;
  S.controls.enabled = true;
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragUp);
  window.removeEventListener('pointercancel', onDragUp);
}

// ════════════════════════════════
// PROJECTION BAKE (the magic)
// ════════════════════════════════
function cacheUserImgPixels() {
  if (!S.userImg) return;
  if (S.userImgPixels && S.userImgW === S.userImg.naturalWidth) return;
  const cv = document.createElement('canvas');
  cv.width = S.userImgW = S.userImg.naturalWidth;
  cv.height = S.userImgH = S.userImg.naturalHeight;
  const c = cv.getContext('2d');
  c.drawImage(S.userImg, 0, 0);
  S.userImgPixels = c.getImageData(0, 0, cv.width, cv.height).data;
}

// Convert a viewport pixel (px, py) to decal-local [0..1] coords.
function screenToDecalUV(px, py) {
  const d = S.decal;
  const w = d.baseW * d.scale;
  const h = d.baseH * d.scale;
  const rad = -d.rot * Math.PI / 180;
  const dx = px - d.cx;
  const dy = py - d.cy;
  const c = Math.cos(rad), s = Math.sin(rad);
  const rx = c * dx - s * dy;
  const ry = s * dx + c * dy;
  return {
    u: rx / w + 0.5,
    v: ry / h + 0.5,
  };
}

function decalScreenAABB() {
  const d = S.decal;
  const w = d.baseW * d.scale / 2;
  const h = d.baseH * d.scale / 2;
  const rad = d.rot * Math.PI / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const corners = [
    [-w, -h], [w, -h], [w, h], [-w, h],
  ].map(([x, y]) => [d.cx + c * x - s * y, d.cy + s * x + c * y]);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of corners) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

// Paint the decal onto the UV atlas by raycasting through the current camera.
async function projectBake() {
  if (!S.userImg || !S.decal || !S.allMeshes.length) {
    toast('Carregue JSON e imagem primeiro');
    return;
  }
  cacheUserImgPixels();

  const canvas = S.renderer.domElement;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const bbox = decalScreenAABB();
  const minX = Math.max(0, Math.floor(bbox.minX));
  const minY = Math.max(0, Math.floor(bbox.minY));
  const maxX = Math.min(W, Math.ceil(bbox.maxX));
  const maxY = Math.min(H, Math.ceil(bbox.maxY));
  if (maxX <= minX || maxY <= minY) {
    toast('O decal está fora da janela 3D');
    return;
  }

  // Aim for a reasonable number of rays: subsample large decals so a huge
  // sticker doesn't freeze the browser. We then smear each sample onto a
  // small area in the texture atlas.
  const decalPxW = maxX - minX;
  const decalPxH = maxY - minY;
  const MAX_RAYS = 280 * 280;
  let stride = 1;
  while ((decalPxW * decalPxH) / (stride * stride) > MAX_RAYS) stride++;

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const texPixels = new Uint8ClampedArray(S.texW * S.texH * 4);
  const imgPx = S.userImgPixels;
  const imgW = S.userImgW, imgH = S.userImgH;
  const opacity = S.decal.opacity;

  // Flash decal opacity indicator
  $('btn-bake').classList.add('working');

  let painted = 0;

  for (let py = minY; py < maxY; py += stride) {
    for (let px = minX; px < maxX; px += stride) {
      const { u, v } = screenToDecalUV(px + 0.5, py + 0.5);
      if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;

      const ix = Math.min(imgW - 1, Math.max(0, Math.floor(u * imgW)));
      const iy = Math.min(imgH - 1, Math.max(0, Math.floor(v * imgH)));
      const sIdx = (iy * imgW + ix) * 4;
      const a = imgPx[sIdx + 3];
      if (a === 0) continue;

      ndc.x = (px / W) * 2 - 1;
      ndc.y = -(py / H) * 2 + 1;
      raycaster.setFromCamera(ndc, S.camera);
      const hits = raycaster.intersectObjects(S.allMeshes, false);
      if (!hits.length) continue;

      const targets = S.xray ? hits : [hits[0]];
      for (const hit of targets) {
        if (!hit.uv) continue;
        const tx = Math.floor(hit.uv.x * S.texW);
        const ty = Math.floor((1 - hit.uv.y) * S.texH);
        if (tx < 0 || tx >= S.texW || ty < 0 || ty >= S.texH) continue;

        // Smear over a (stride × stride) region so sampling gaps still cover
        // their pixels on the atlas. Also write to a ±1 neighborhood to
        // avoid single-pixel holes along seams.
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const nx = tx + ox;
            const ny = ty + oy;
            if (nx < 0 || nx >= S.texW || ny < 0 || ny >= S.texH) continue;
            const tIdx = (ny * S.texW + nx) * 4;
            const aOut = Math.max(texPixels[tIdx + 3], a);
            texPixels[tIdx + 0] = imgPx[sIdx + 0];
            texPixels[tIdx + 1] = imgPx[sIdx + 1];
            texPixels[tIdx + 2] = imgPx[sIdx + 2];
            texPixels[tIdx + 3] = aOut;
          }
        }
        painted++;
      }
    }
  }

  // Composite onto the persistent bake canvas with the decal's opacity
  if (painted > 0) {
    const layer = document.createElement('canvas');
    layer.width = S.texW;
    layer.height = S.texH;
    const lctx = layer.getContext('2d');
    const id = new ImageData(texPixels, S.texW, S.texH);
    lctx.putImageData(id, 0, 0);

    S.bakeCtx.globalAlpha = opacity;
    S.bakeCtx.imageSmoothingEnabled = false;
    S.bakeCtx.drawImage(layer, 0, 0);
    S.bakeCtx.globalAlpha = 1;
    S.bakeTex.needsUpdate = true;
    drawAtlasPreview();
    toast(`Gravado: ${painted} pixels pintados`);
  } else {
    toast('Nenhum pixel atingiu a arma — aproxime o decal');
  }

  $('btn-bake').classList.remove('working');
}

function clearBake() {
  S.bakeCtx.clearRect(0, 0, S.bakeCanvas.width, S.bakeCanvas.height);
  S.bakeTex.needsUpdate = true;
  drawAtlasPreview();
  toast('Textura limpa');
}

// ════════════════════════════════
// UI WIRING
// ════════════════════════════════
function wireUi() {
  // JSON
  $('btn-json').addEventListener('click', () => $('inp-json').click());
  $('inp-json').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = ev => {
      try {
        parseGeo(JSON.parse(ev.target.result));
        $('json-text').textContent = f.name;
        $('btn-json').classList.add('loaded');
        $('panel-image').style.display = 'flex';
      } catch (err) {
        toast('JSON inválido: ' + err.message);
      }
    };
    r.readAsText(f);
  });

  // Image
  $('btn-img').addEventListener('click', () => $('inp-img').click());
  $('inp-img').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    loadImage(f);
  });

  // Drag-and-drop image into the 3D viewport
  const dropZone = $('viewport-3d-wrap');
  ['dragenter', 'dragover'].forEach(ev =>
    dropZone.addEventListener(ev, e => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      dropZone.classList.add('drag-hover');
    })
  );
  ['dragleave', 'drop'].forEach(ev =>
    dropZone.addEventListener(ev, e => {
      e.preventDefault();
      dropZone.classList.remove('drag-hover');
    })
  );
  dropZone.addEventListener('drop', e => {
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('image/')) loadImage(f);
  });

  // Decal interactions
  const decalBox = $('decal-box');
  decalBox.addEventListener('pointerdown', e => {
    if (e.target.dataset.handle) return; // handles manage themselves
    startDrag(e, 'move');
  });
  $('handle-scale').addEventListener('pointerdown', e => startDrag(e, 'scale'));
  $('handle-rot').addEventListener('pointerdown', e => startDrag(e, 'rotate'));

  // Wheel on decal = scale
  decalBox.addEventListener('wheel', e => {
    if (!S.decal) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.06 : 1 / 1.06;
    S.decal.scale = Math.max(0.05, Math.min(20, S.decal.scale * factor));
    $('sl-scale').value = S.decal.scale;
    $('val-scale').textContent = S.decal.scale.toFixed(2);
    positionDecalOverlay();
  }, { passive: false });

  // Sliders
  $('sl-scale').addEventListener('input', e => {
    if (!S.decal) return;
    S.decal.scale = parseFloat(e.target.value);
    $('val-scale').textContent = S.decal.scale.toFixed(2);
    positionDecalOverlay();
  });
  $('sl-rot').addEventListener('input', e => {
    if (!S.decal) return;
    S.decal.rot = parseFloat(e.target.value);
    $('val-rot').textContent = Math.round(S.decal.rot) + '°';
    positionDecalOverlay();
  });
  $('sl-opacity').addEventListener('input', e => {
    if (!S.decal) return;
    S.decal.opacity = parseFloat(e.target.value);
    $('val-opacity').textContent = Math.round(S.decal.opacity * 100) + '%';
    positionDecalOverlay();
  });

  $('btn-reset-tx').addEventListener('click', () => {
    if (!S.decal) return;
    S.decal.rot = 0;
    S.decal.scale = 1;
    S.decal.opacity = 1;
    $('sl-rot').value = 0; $('val-rot').textContent = '0°';
    $('sl-scale').value = 1; $('val-scale').textContent = '1.00';
    $('sl-opacity').value = 1; $('val-opacity').textContent = '100%';
    positionDecalOverlay();
  });
  $('btn-recenter').addEventListener('click', () => {
    if (!S.userImg) return;
    autoPlaceDecal();
  });

  // X-Ray toggle
  $('chk-xray').addEventListener('change', e => {
    S.xray = e.target.checked;
    $('btn-bake').classList.toggle('xray', S.xray);
    // Update live-projection materials so preview behaves like the baked result
    S.decalPassMeshes.forEach(m => {
      m.material.depthTest = !S.xray;
      m.material.side = S.xray ? THREE.DoubleSide : THREE.FrontSide;
      m.material.needsUpdate = true;
    });
  });

  // Bake + clear + export
  $('btn-bake').addEventListener('click', () => projectBake());
  $('btn-clear').addEventListener('click', () => clearBake());
  $('btn-export').addEventListener('click', exportPng);

  // Reposition decal when window resizes
  window.addEventListener('resize', () => {
    if (S.decal) positionDecalOverlay();
  });
}

function loadImage(file) {
  const r = new FileReader();
  r.onload = ev => {
    const img = new Image();
    img.onload = () => {
      S.userImg = img;
      S.userImgPixels = null; // invalidate cache
      // Replace live-projection texture
      if (S.decalTex) S.decalTex.dispose();
      S.decalTex = new THREE.Texture(img);
      S.decalTex.colorSpace = THREE.SRGBColorSpace;
      S.decalTex.magFilter = THREE.LinearFilter;
      S.decalTex.minFilter = THREE.LinearFilter;
      S.decalTex.generateMipmaps = false;
      S.decalTex.needsUpdate = true;
      $('img-thumb').src = ev.target.result;
      $('img-preview').style.display = 'block';
      $('img-text').textContent = file.name;
      $('btn-img').classList.add('loaded');
      $('panel-transform').style.display = 'flex';
      $('panel-bake').style.display = 'flex';
      $('panel-export').style.display = 'flex';

      autoPlaceDecal();
      toast('Mire a arma e clique em "Gravar na arma"');
    };
    img.src = ev.target.result;
  };
  r.readAsDataURL(file);
}

function exportPng() {
  if (!S.geo) {
    toast('Carregue um JSON primeiro');
    return;
  }
  S.bakeCanvas.toBlob(blob => {
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: ((S.geoMeta && S.geoMeta.identifier) || 'skin').replace(/^geometry\./, '') + '.png',
    });
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`Textura ${S.texW}×${S.texH} exportada`);
  }, 'image/png');
}

// ════════════════════════════════
// TOAST
// ════════════════════════════════
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 3200);
}

init();
