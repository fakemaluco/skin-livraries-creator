/**
 * CS:Craft Skin Maker — UV-Space Sticker
 * Drop an image, it adapts to the UV layout of the .json geometry.
 * The 3D viewport is a live preview; all editing happens on the UV atlas.
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

  // Texture pipeline
  bakeCanvas: null,
  bakeCtx: null,
  bakeTex: null,

  // UV atlas
  atlasCanvas: null,
  atlasCtx: null,
  uvRects: [],
  uvBBox: null,

  // Sticker
  userImg: null,
  // {cx, cy} center in tex px; baseW/baseH = autofit size; scale relative to base
  sticker: null,

  // Drag state
  drag: null,
};

// ════════════════════════════════
// INIT
// ════════════════════════════════
function init() {
  initBakeTexture();
  initThree();
  initAtlas();
  wireUi();
}

function initBakeTexture() {
  S.bakeCanvas = document.createElement('canvas');
  S.bakeCanvas.width = S.texW;
  S.bakeCanvas.height = S.texH;
  S.bakeCtx = S.bakeCanvas.getContext('2d');
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
    S.renderer.render(S.scene, S.camera);
  })();
}

// ════════════════════════════════
// GEOMETRY
// ════════════════════════════════
function parseGeo(data) {
  const geos = data['minecraft:geometry'];
  if (!geos || !geos[0]) {
    toast('⚠️ JSON sem minecraft:geometry');
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
  if (S.userImg) autoFitSticker('cover');
  bake();
  drawAtlas();

  $('vp-empty').style.display = 'none';
  $('header-info').textContent = desc.identifier || '(geometry)';
  $('atlas-meta').textContent = `${S.texW} × ${S.texH} · ${S.uvRects.length} faces UV`;
  toast(`✅ ${S.allMeshes.length} cubos carregados`);
}

function computeUvRects() {
  const rects = [];
  (S.geo.bones || []).forEach((bone, bi) => {
    (bone.cubes || []).forEach((cube, ci) => {
      const uvMap = cube.uv || {};
      // Box-style UV (single offset, all 6 faces auto-laid-out) is not handled here;
      // we focus on per-face uv used by Bedrock weapon models.
      if (Array.isArray(uvMap)) return;
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
  const disposedMats = new Set();
  S.allMeshes.forEach(m => {
    m.geometry.dispose();
    if (m.material && !disposedMats.has(m.material)) {
      m.material.dispose();
      disposedMats.add(m.material);
    }
  });
  S.allMeshes = [];
  S.meshGroup = new THREE.Group();

  // Build pivots map (Bedrock → Three.js: negate X)
  const pivotOf = {};
  (S.geo.bones || []).forEach(bone => {
    const p = bone.pivot || [0, 0, 0];
    pivotOf[bone.name] = [-p[0] * SCALE, p[1] * SCALE, p[2] * SCALE];
  });

  // Bone groups
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
        THREE.MathUtils.degToRad(-bone.rotation[1]),
        THREE.MathUtils.degToRad(-bone.rotation[2]),
        'ZYX'
      );
    }
    boneGroup[bone.name] = g;
  });

  // Hierarchy
  (S.geo.bones || []).forEach(bone => {
    if (bone.parent && boneGroup[bone.parent]) {
      boneGroup[bone.parent].add(boneGroup[bone.name]);
    } else {
      S.meshGroup.add(boneGroup[bone.name]);
    }
  });

  // Cubes
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

      const geom = buildCubeGeometry(rw, rh, rd, cube.uv || {}, S.texW, S.texH);
      const mesh = new THREE.Mesh(geom, sharedMat);

      const cx = -(ox + sx / 2) * SCALE;
      const cy = (oy + sy / 2) * SCALE;
      const cz = (oz + sz / 2) * SCALE;

      if (cube.rotation) {
        const p = cube.pivot || [0, 0, 0];
        const px = -p[0] * SCALE;
        const py = p[1] * SCALE;
        const pz = p[2] * SCALE;

        const pivGrp = new THREE.Group();
        pivGrp.position.set(px - myPiv[0], py - myPiv[1], pz - myPiv[2]);
        pivGrp.rotation.set(
          THREE.MathUtils.degToRad(cube.rotation[0]),
          THREE.MathUtils.degToRad(-cube.rotation[1]),
          THREE.MathUtils.degToRad(-cube.rotation[2]),
          'ZYX'
        );
        mesh.position.set(cx - px, cy - py, cz - pz);
        pivGrp.add(mesh);
        g.add(pivGrp);
      } else {
        mesh.position.set(cx - myPiv[0], cy - myPiv[1], cz - myPiv[2]);
        g.add(mesh);
      }

      S.allMeshes.push(mesh);
    });
  });

  S.scene.add(S.meshGroup);

  // Center on origin
  const box = new THREE.Box3().setFromObject(S.meshGroup);
  if (!box.isEmpty()) {
    const c = box.getCenter(new THREE.Vector3());
    S.meshGroup.position.sub(c);
  }
  resetCam();
}

function buildCubeGeometry(w, h, d, uvMap, texW, texH) {
  const geom = new THREE.BoxGeometry(w, h, d);
  const uvs = geom.attributes.uv;

  // Three BoxGeometry face order: +x, -x, +y, -y, +z, -z
  const faces = ['east', 'west', 'up', 'down', 'south', 'north'];

  for (let i = 0; i < 6; i++) {
    const face = faces[i];
    const base = i * 4;
    const fd = uvMap[face];

    if (!fd || !fd.uv) {
      // Unmapped face → degenerate UV (samples (0,0) which is transparent)
      for (let j = 0; j < 4; j++) uvs.setXY(base + j, 0, 0);
      continue;
    }

    const [ux, uy] = fd.uv;
    const [uw, uh] = fd.uv_size || [1, 1];

    const uL = ux / texW;
    const uR = (ux + uw) / texW;
    const vT = 1 - (uy / texH);
    const vB = 1 - ((uy + uh) / texH);

    uvs.setXY(base + 0, uL, vT);
    uvs.setXY(base + 1, uR, vT);
    uvs.setXY(base + 2, uL, vB);
    uvs.setXY(base + 3, uR, vB);
  }
  uvs.needsUpdate = true;
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
// ATLAS EDITOR
// ════════════════════════════════
function initAtlas() {
  S.atlasCanvas = $('atlas-canvas');
  S.atlasCtx = S.atlasCanvas.getContext('2d');

  S.atlasCanvas.addEventListener('mousedown', onAtlasDown);
  window.addEventListener('mousemove', onAtlasMove);
  window.addEventListener('mouseup', onAtlasUp);
  S.atlasCanvas.addEventListener('wheel', onAtlasWheel, { passive: false });

  new ResizeObserver(() => drawAtlas()).observe(S.atlasCanvas.parentElement);

  drawAtlas();
}

function atlasMetrics() {
  const wrap = S.atlasCanvas.parentElement;
  const W = wrap.clientWidth;
  const H = wrap.clientHeight;
  const aspect = S.texW / S.texH;
  let dispW, dispH;
  if (W / H > aspect) {
    dispH = H;
    dispW = H * aspect;
  } else {
    dispW = W;
    dispH = W / aspect;
  }
  return { dispW, dispH, sx: dispW / S.texW, sy: dispH / S.texH };
}

function drawAtlas() {
  const cv = S.atlasCanvas;
  const ctx = S.atlasCtx;
  const { dispW, dispH, sx, sy } = atlasMetrics();

  const dpr = Math.min(devicePixelRatio, 2);
  cv.width = Math.max(1, Math.floor(dispW * dpr));
  cv.height = Math.max(1, Math.floor(dispH * dpr));
  cv.style.width = dispW + 'px';
  cv.style.height = dispH + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Checker bg
  ctx.fillStyle = '#141a24';
  ctx.fillRect(0, 0, dispW, dispH);
  ctx.fillStyle = '#1c2333';
  const tile = 8;
  for (let y = 0; y < dispH; y += tile) {
    for (let x = (y / tile) % 2 === 0 ? 0 : tile; x < dispW; x += tile * 2) {
      ctx.fillRect(x, y, tile, tile);
    }
  }

  // Baked texture (the real export)
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

  // UV bbox highlight
  if (S.uvBBox && S.uvBBox.w > 0) {
    ctx.strokeStyle = 'rgba(104, 211, 145, 0.45)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(
      S.uvBBox.x * sx + 0.5,
      S.uvBBox.y * sy + 0.5,
      S.uvBBox.w * sx - 1,
      S.uvBBox.h * sy - 1,
    );
    ctx.setLineDash([]);
  }

  // Sticker overlay (selection box + handle)
  if (S.sticker && S.userImg) {
    const s = S.sticker;
    const w = s.baseW * s.scale;
    const h = s.baseH * s.scale;
    ctx.save();
    ctx.translate(s.cx * sx, s.cy * sy);
    ctx.rotate((s.rot * Math.PI) / 180);
    ctx.strokeStyle = 'rgba(246, 173, 85, 0.95)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect((-w / 2) * sx, (-h / 2) * sy, w * sx, h * sy);
    ctx.setLineDash([]);
    ctx.fillStyle = '#f6ad55';
    ctx.beginPath();
    ctx.arc(0, 0, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function clientToTex(clientX, clientY) {
  const r = S.atlasCanvas.getBoundingClientRect();
  return [
    ((clientX - r.left) / r.width) * S.texW,
    ((clientY - r.top) / r.height) * S.texH,
  ];
}

function onAtlasDown(e) {
  if (!S.userImg || !S.sticker) return;
  e.preventDefault();
  const [tx, ty] = clientToTex(e.clientX, e.clientY);
  S.drag = {
    mode: 'move',
    startTx: tx,
    startTy: ty,
    startCx: S.sticker.cx,
    startCy: S.sticker.cy,
  };
  S.atlasCanvas.style.cursor = 'grabbing';
}

function onAtlasMove(e) {
  if (!S.drag) return;
  const [tx, ty] = clientToTex(e.clientX, e.clientY);
  if (S.drag.mode === 'move') {
    S.sticker.cx = S.drag.startCx + (tx - S.drag.startTx);
    S.sticker.cy = S.drag.startCy + (ty - S.drag.startTy);
    bake();
  }
}

function onAtlasUp() {
  S.drag = null;
  S.atlasCanvas.style.cursor = '';
}

function onAtlasWheel(e) {
  if (!S.sticker) return;
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.06 : 1 / 1.06;
  S.sticker.scale = Math.max(0.05, Math.min(20, S.sticker.scale * factor));
  syncScaleSlider();
  bake();
}

function syncScaleSlider() {
  if (!S.sticker) return;
  $('sl-scale').value = S.sticker.scale;
  $('val-scale').textContent = S.sticker.scale.toFixed(2);
}

// ════════════════════════════════
// BAKE TEXTURE
// ════════════════════════════════
function bake() {
  const ctx = S.bakeCtx;
  ctx.clearRect(0, 0, S.bakeCanvas.width, S.bakeCanvas.height);
  if (S.userImg && S.sticker) {
    const s = S.sticker;
    const w = s.baseW * s.scale;
    const h = s.baseH * s.scale;
    ctx.save();
    ctx.globalAlpha = s.opacity;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(s.cx, s.cy);
    ctx.rotate((s.rot * Math.PI) / 180);
    ctx.drawImage(S.userImg, -w / 2, -h / 2, w, h);
    ctx.restore();
  }
  S.bakeTex.needsUpdate = true;
  drawAtlas();
}

// Build sticker baseline from the UV bbox using cover-fit (image keeps aspect).
function autoFitSticker(mode) {
  if (!S.userImg) return;
  const bb = S.uvBBox && S.uvBBox.w > 0 ? S.uvBBox : { x: 0, y: 0, w: S.texW, h: S.texH };
  const imgA = S.userImg.naturalWidth / S.userImg.naturalHeight;
  const bbA = bb.w / bb.h;
  let baseW, baseH;
  if (mode === 'contain') {
    if (imgA > bbA) {
      baseW = bb.w;
      baseH = bb.w / imgA;
    } else {
      baseH = bb.h;
      baseW = bb.h * imgA;
    }
  } else {
    // cover (default)
    if (imgA > bbA) {
      baseH = bb.h;
      baseW = bb.h * imgA;
    } else {
      baseW = bb.w;
      baseH = bb.w / imgA;
    }
  }
  S.sticker = {
    cx: bb.x + bb.w / 2,
    cy: bb.y + bb.h / 2,
    baseW,
    baseH,
    scale: 1,
    rot: 0,
    opacity: 1,
  };
  $('sl-scale').value = 1;
  $('val-scale').textContent = '1.00';
  $('sl-rot').value = 0;
  $('val-rot').textContent = '0°';
  $('sl-opacity').value = 1;
  $('val-opacity').textContent = '100%';
}

// ════════════════════════════════
// UI WIRING
// ════════════════════════════════
function wireUi() {
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
        toast('⚠️ JSON inválido: ' + err.message);
      }
    };
    r.readAsText(f);
  });

  $('btn-img').addEventListener('click', () => $('inp-img').click());
  $('inp-img').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    loadImage(f);
  });

  // Drag-and-drop image into atlas wrapper
  const dropZone = $('atlas-wrap');
  ['dragenter', 'dragover'].forEach(ev =>
    dropZone.addEventListener(ev, e => {
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

  // Sliders
  $('sl-scale').addEventListener('input', e => {
    if (!S.sticker) return;
    S.sticker.scale = parseFloat(e.target.value);
    $('val-scale').textContent = S.sticker.scale.toFixed(2);
    bake();
  });
  $('sl-rot').addEventListener('input', e => {
    if (!S.sticker) return;
    S.sticker.rot = parseFloat(e.target.value);
    $('val-rot').textContent = Math.round(S.sticker.rot) + '°';
    bake();
  });
  $('sl-opacity').addEventListener('input', e => {
    if (!S.sticker) return;
    S.sticker.opacity = parseFloat(e.target.value);
    $('val-opacity').textContent = Math.round(S.sticker.opacity * 100) + '%';
    bake();
  });

  $('btn-fit-cover').addEventListener('click', () => {
    if (!S.userImg) return;
    autoFitSticker('cover');
    bake();
  });
  $('btn-fit-contain').addEventListener('click', () => {
    if (!S.userImg) return;
    autoFitSticker('contain');
    bake();
  });
  $('btn-reset-tx').addEventListener('click', () => {
    if (!S.sticker) return;
    S.sticker.rot = 0;
    S.sticker.scale = 1;
    S.sticker.opacity = 1;
    $('sl-rot').value = 0; $('val-rot').textContent = '0°';
    $('sl-scale').value = 1; $('val-scale').textContent = '1.00';
    $('sl-opacity').value = 1; $('val-opacity').textContent = '100%';
    bake();
  });

  $('btn-export').addEventListener('click', exportPng);
}

function loadImage(file) {
  const r = new FileReader();
  r.onload = ev => {
    const img = new Image();
    img.onload = () => {
      S.userImg = img;
      $('img-thumb').src = ev.target.result;
      $('img-preview').style.display = 'block';
      $('img-text').textContent = file.name;
      $('btn-img').classList.add('loaded');
      $('panel-transform').style.display = 'flex';
      $('panel-export').style.display = 'flex';

      autoFitSticker('cover');
      bake();
      toast('🎨 Imagem ajustada ao UV. Arraste para reposicionar.');
    };
    img.src = ev.target.result;
  };
  r.readAsDataURL(file);
}

function exportPng() {
  if (!S.userImg) {
    toast('⚠️ Carregue uma imagem primeiro');
    return;
  }
  S.bakeCanvas.toBlob(blob => {
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: ((S.geoMeta && S.geoMeta.identifier) || 'skin').replace(/^geometry\./, '') + '.png',
    });
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`✅ Textura ${S.texW}×${S.texH} exportada`);
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
  toast._t = setTimeout(() => t.classList.remove('show'), 3500);
}

init();
