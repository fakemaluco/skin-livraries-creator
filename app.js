/**
 * CS:Craft Skin Maker — 3D Shader Projection
 * Live planar projection directly over the weapon pixels, CS2 style!
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

'use strict';

const S = {
  // Data
  texW: 64, texH: 64,
  geoMeta: null,
  allMeshes: [],
  allBoxes: [], // for baking

  // Three.js
  renderer: null, scene: null, camera: null, controls: null, raycaster: null,
  meshGroup: null,

  // Shader Projection State
  userImg: null,
  userTex: null,
  stickerPos: new THREE.Vector3(),
  stickerNormal: new THREE.Vector3(0,0,1),
  stickerUp: new THREE.Vector3(0,1,0),
  stickerRight: new THREE.Vector3(1,0,0),
  stickerScale: 1.0,
  stickerRot: 0,
  stickerOpacity: 1.0,
  xray: true, // Project through the entire mesh
  active: false, // Has the user placed/moved the projection?

  mode: 'orbit', // orbit | move
  viewportWrap: null,
};

const SCALE = 1 / 16;
const $ = id => document.getElementById(id);

// ════════════════════════════════
// INIT
// ════════════════════════════════
function init() {
  const vp = document.querySelector('.viewport');
  S.viewportWrap = vp;

  S.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  S.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  S.renderer.setClearColor(0x05070a, 1);
  $('three-container').appendChild(S.renderer.domElement);

  S.scene = new THREE.Scene();

  S.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 300);
  S.camera.position.set(3, 2, 4);

  S.controls = new OrbitControls(S.camera, S.renderer.domElement);
  S.controls.enableDamping = true;
  S.controls.dampingFactor = 0.08;

  S.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(5, 10, 8);
  S.scene.add(sun);
  const fill = new THREE.DirectionalLight(0x63b3ed, 0.3);
  fill.position.set(-5, -5, -5);
  S.scene.add(fill);

  const grid = new THREE.GridHelper(20, 20, 0x111a26, 0x0d1420);
  S.scene.add(grid);

  S.raycaster = new THREE.Raycaster();

  new ResizeObserver(() => {
    const w = vp.clientWidth, h = vp.clientHeight;
    S.renderer.setSize(w, h, false);
    S.camera.aspect = w / h || 1;
    S.camera.updateProjectionMatrix();
  }).observe(vp);

  (function loop() {
    requestAnimationFrame(loop);
    S.controls.update();

    // Update shaders
    S.allMeshes.forEach(m => {
      const ud = m.material.userData;
      if (ud && ud.uActive) {
        ud.uActive.value  = S.active ? 1 : 0;
        ud.uScale.value   = S.stickerScale;
        ud.uRot.value     = S.stickerRot * (Math.PI / 180);
        ud.uOpacity.value = S.stickerOpacity;
        ud.uXray.value    = S.xray ? 1 : 0;
        ud.uPos.value.copy(S.stickerPos);
        ud.uNormal.value.copy(S.stickerNormal);
        ud.uUp.value.copy(S.stickerUp);
        ud.uRight.value.copy(S.stickerRight);
      }
    });

    S.renderer.render(S.scene, S.camera);
  })();

  attachEvents();
  wireControls();
}

// ════════════════════════════════
// SHADER MATERIAL
// ════════════════════════════════
function createProjectionMaterial() {
  const mat = new THREE.MeshLambertMaterial({
    color: 0x939ba6, // Default gun color
    side: THREE.FrontSide,
    transparent: false // Fixing depth sorting bugs explicitly
  });

  // Store uniforms in userData so we can update them in the render loop
  mat.userData = {
    uActive:    { value: 0 },
    uTex:       { value: S.userTex },
    uPos:       { value: new THREE.Vector3() },
    uNormal:    { value: new THREE.Vector3() },
    uUp:        { value: new THREE.Vector3() },
    uRight:     { value: new THREE.Vector3() },
    uScale:     { value: 1.0 },
    uRot:       { value: 0.0 },
    uOpacity:   { value: 1.0 },
    uXray:      { value: 1 },
    uAspect:    { value: S.userImg ? S.userImg.naturalWidth / S.userImg.naturalHeight : 1.0 }
  };

  mat.onBeforeCompile = (shader) => {
    // Inject our uniforms
    Object.assign(shader.uniforms, mat.userData);

    // Variables shared between our injected vertex & fragment chunks
    shader.vertexShader = `
      varying vec3 vMyWorldPos;
      varying vec3 vMyWorldNormal;
    ` + shader.vertexShader;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `
      #include <begin_vertex>
      vMyWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
      vMyWorldNormal = normalize(mat3(modelMatrix) * normal);
      `
    );

    // Fragment Shader setup
    shader.fragmentShader = `
      uniform int uActive;
      uniform sampler2D uTex;
      uniform vec3 uPos;
      uniform vec3 uNormal;
      uniform vec3 uUp;
      uniform vec3 uRight;
      uniform float uScale;
      uniform float uRot;
      uniform float uOpacity;
      uniform int uXray;
      uniform float uAspect;

      varying vec3 vMyWorldPos;
      varying vec3 vMyWorldNormal;
    ` + shader.fragmentShader;

    // Apply projection math over the base diffuse color
    shader.fragmentShader = shader.fragmentShader.replace(
      'vec4 diffuseColor = vec4( diffuse, opacity );',
      `
      vec4 diffuseColor = vec4( diffuse, opacity );
      
      if (uActive == 1) {
        float facing = dot(vMyWorldNormal, uNormal);
        if (uXray == 1 || facing > 0.01) {
          vec3 toFrag = vMyWorldPos - uPos;
          
          float localX = dot(toFrag, uRight) / uScale;
          float localY = dot(toFrag, uUp)    / uScale;
          localY *= uAspect;
          
          float c = cos(-uRot);
          float s = sin(-uRot);
          float rx = localX * c - localY * s;
          float ry = localX * s + localY * c;
          
          if (abs(rx) <= 0.5 && abs(ry) <= 0.5) {
            vec2 texUv = vec2(rx + 0.5, ry + 0.5);
            vec4 texColor = texture2D(uTex, texUv);
            
            if (texColor.a > 0.0) {
               diffuseColor.rgb = mix(diffuseColor.rgb, texColor.rgb, texColor.a * uOpacity);
            }
          }
        }
      }
      `
    );
  };

  return mat;
}

// ════════════════════════════════
// LOADERS
// ════════════════════════════════
$('btn-json').addEventListener('click', () => $('inp-json').click());
$('inp-json').addEventListener('change', e => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = ev => {
    parseGeo(JSON.parse(ev.target.result));
    $('json-text').textContent = f.name;
    $('btn-json').classList.add('loaded');
  };
  r.readAsText(f);
});

$('btn-img').addEventListener('click', () => $('inp-img').click());
$('inp-img').addEventListener('change', e => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = ev => {
    const img = new Image();
    img.onload = () => {
      S.userImg = img;
      S.userTex = new THREE.Texture(img);
      S.userTex.colorSpace = THREE.SRGBColorSpace;
      S.userTex.magFilter = THREE.LinearFilter;
      S.userTex.minFilter = THREE.LinearMipmapLinearFilter;
      S.userTex.needsUpdate = true;

      // Update shader uniforms using userData reference
      S.allMeshes.forEach(m => {
        if (m.material.userData) {
          m.material.userData.uTex.value = S.userTex;
          m.material.userData.uAspect.value = img.naturalWidth / img.naturalHeight;
        }
      });

      $('img-thumb').src = ev.target.result;
      $('img-preview').style.display = 'block';
      $('img-text').textContent = f.name;
      $('btn-img').classList.add('loaded');

      $('panel-transform').style.display = 'flex';
      $('panel-export').style.display = 'flex';

      // Auto-activate mode move
      window.setMode('move');
      toast('🎨 Imagem carregada! Arraste ela pela arma para projetar.');
    };
    img.src = ev.target.result;
  };
  r.readAsDataURL(f);
});

// ════════════════════════════════
// BUILD 3D
// ════════════════════════════════
function parseGeo(data) {
  const geos = data['minecraft:geometry'];
  if(!geos) return;
  const geo = geos[0];
  const desc = geo.description;
  S.texW = desc.texture_width || 64;
  S.texH = desc.texture_height || 64;
  S.geoMeta = desc;

  if (S.meshGroup) S.scene.remove(S.meshGroup);
  S.allMeshes.forEach(m => { m.geometry.dispose(); m.material.dispose(); });
  S.allMeshes = [];
  S.allBoxes = [];
  S.meshGroup = new THREE.Group();

  let cubesCount = 0;

  // 1. Build pivots map
  const pivotOf = {};
  (geo.bones || []).forEach(bone => {
    const p = bone.pivot || [0,0,0];
    pivotOf[bone.name] = [-p[0]*SCALE, p[1]*SCALE, p[2]*SCALE]; // Negate X for Three.js
  });

  // 2. Build bone groups
  const boneGroup = {};
  (geo.bones || []).forEach(bone => {
    const g = new THREE.Group();
    g.name = bone.name;

    const myPiv = pivotOf[bone.name];
    if (bone.parent && pivotOf[bone.parent]) {
      const parPiv = pivotOf[bone.parent];
      g.position.set(myPiv[0] - parPiv[0], myPiv[1] - parPiv[1], myPiv[2] - parPiv[2]);
    } else {
      g.position.set(myPiv[0], myPiv[1], myPiv[2]);
    }

    if (bone.rotation) {
      g.rotation.set(
        THREE.MathUtils.degToRad(bone.rotation[0]),
        THREE.MathUtils.degToRad(-bone.rotation[1]), // Negate Y
        THREE.MathUtils.degToRad(-bone.rotation[2]), // Negate Z
        'ZYX'
      );
    }
    boneGroup[bone.name] = g;
  });

  // 3. Attach bones in hierarchy
  (geo.bones || []).forEach(bone => {
    if (bone.parent && boneGroup[bone.parent]) {
      boneGroup[bone.parent].add(boneGroup[bone.name]);
    } else {
      S.meshGroup.add(boneGroup[bone.name]);
    }
  });

  // 4. Build cubes and attach to their bones
  (geo.bones || []).forEach(bone => {
    const g = boneGroup[bone.name];
    const myPiv = pivotOf[bone.name];

    (bone.cubes || []).forEach(cube => {
      cubesCount++;
      const [ox, oy, oz] = cube.origin ?? [0,0,0];
      const [sx, sy, sz] = cube.size ?? [1,1,1];
      const inf = cube.inflate ?? 0;

      const rw = (sx+inf*2)*SCALE;
      const rh = (sy+inf*2)*SCALE;
      const rd = (sz+inf*2)*SCALE;
      
      const geom = buildCubeGeometry(rw, rh, rd, cube.uv || {}, S.texW, S.texH);
      const mat = createProjectionMaterial();
      const mesh = new THREE.Mesh(geom, mat);

      const cx = -(ox + sx/2)*SCALE; // Negate X
      const cy = (oy + sy/2)*SCALE;
      const cz = (oz + sz/2)*SCALE;

      let pivGrp = null;
      if (cube.rotation) {
        const p = cube.pivot || [0,0,0];
        const px = -p[0]*SCALE; // Negate X
        const py = p[1]*SCALE;
        const pz = p[2]*SCALE;

        const rx = THREE.MathUtils.degToRad(cube.rotation[0]);
        const ry = THREE.MathUtils.degToRad(-cube.rotation[1]); // Negate Y
        const rz = THREE.MathUtils.degToRad(-cube.rotation[2]); // Negate Z
        
        pivGrp = new THREE.Group();
        pivGrp.position.set(px - myPiv[0], py - myPiv[1], pz - myPiv[2]);
        pivGrp.rotation.set(rx, ry, rz, 'ZYX');
        
        mesh.position.set(cx - px, cy - py, cz - pz);
        pivGrp.add(mesh);
        g.add(pivGrp);
      } else {
        mesh.position.set(cx - myPiv[0], cy - myPiv[1], cz - myPiv[2]);
        g.add(mesh);
      }

      S.allMeshes.push(mesh);
      S.allBoxes.push({ mesh, pivGrp }); // for bake traversal
    });
  });

  S.scene.add(S.meshGroup);
  
  const box = new THREE.Box3().setFromObject(S.meshGroup);
  if(!box.isEmpty()){
    const c = box.getCenter(new THREE.Vector3());
    S.meshGroup.position.sub(c);
  }
  window.resetCam();

  $('vp-empty').style.display = 'none';
  $('vp-toolbar').style.display = 'flex';
  $('header-info').textContent = desc.identifier;
  toast(`✅ ${cubesCount} cubos montados na raiz geométrica!`);
}

function buildCubeGeometry(w, h, d, uvMap, texW, texH) {
  const geom = new THREE.BoxGeometry(w, h, d);
  const uvs = geom.attributes.uv;
  
  // Three.js BoxGeometry face order: +x, -x, +y, -y, +z, -z
  const faces = ['east', 'west', 'up', 'down', 'south', 'north'];
  
  for (let i = 0; i < 6; i++) {
    const face = faces[i];
    const base = i * 4;
    const fd = uvMap[face];
    
    if (!fd?.uv) {
      for(let j=0; j<4; j++) uvs.setXY(base+j, 0, 0); // Unmapped = 0,0
      continue;
    }
    
    const [ux, uy] = fd.uv;
    const [uw, uh] = fd.uv_size ?? [1,1];
    
    // UV space (respecting negative flip sizes)
    let uL = ux / texW;
    let uR = (ux + uw) / texW;
    let vT = 1 - (uy / texH);
    let vB = 1 - ((uy + uh) / texH);

    // BoxGeometry vertices order for each plane: TL, TR, BL, BR
    uvs.setXY(base + 0, uL, vT);
    uvs.setXY(base + 1, uR, vT);
    uvs.setXY(base + 2, uL, vB);
    uvs.setXY(base + 3, uR, vB);
  }
  
  uvs.needsUpdate = true;
  return geom;
}

// ════════════════════════════════
// INTERACTIONS
// ════════════════════════════════
function updateStickerBasis(normal) {
  S.stickerNormal.copy(normal);
  // Create orthogonal basis
  if (Math.abs(normal.y) > 0.99) {
    S.stickerRight.set(1,0,0);
  } else {
    S.stickerRight.copy(new THREE.Vector3(0,1,0)).cross(normal).normalize();
  }
  S.stickerUp.copy(normal).cross(S.stickerRight).normalize();
}

function attachEvents() {
  let isDraggingImg = false;

  S.viewportWrap.addEventListener('mousedown', e => {
    if (S.mode !== 'move' || e.button !== 0 || !S.userImg) return;
    
    // Raycast to find exact position
    const ndc = new THREE.Vector2(
      (e.offsetX / S.viewportWrap.clientWidth) * 2 - 1,
      -(e.offsetY / S.viewportWrap.clientHeight) * 2 + 1
    );
    S.raycaster.setFromCamera(ndc, S.camera);
    const hits = S.raycaster.intersectObjects(S.allMeshes, false);
    
    if (hits.length) {
      isDraggingImg = true;
      S.active = true;
      const h = hits[0];
      const worldNorm = h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize();
      S.stickerPos.copy(h.point);
      updateStickerBasis(worldNorm);
    }
  });

  window.addEventListener('mousemove', e => {
    if (!isDraggingImg) return;
    const rect = S.viewportWrap.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    S.raycaster.setFromCamera(ndc, S.camera);
    const hits = S.raycaster.intersectObjects(S.allMeshes, false);
    
    if (hits.length) {
      const h = hits[0];
      const worldNorm = h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize();
      S.stickerPos.copy(h.point);
      updateStickerBasis(worldNorm);
    }
  });

  window.addEventListener('mouseup', () => { isDraggingImg = false; });
}

window.setMode = (m) => {
  S.mode = m;
  $('mode-orbit').classList.toggle('active', m === 'orbit');
  $('mode-move').classList.toggle('active', m === 'move');
  S.controls.enabled = (m === 'orbit');
  S.viewportWrap.style.cursor = m === 'move' ? 'crosshair' : '';
};

window.resetCam = () => {
  const box = new THREE.Box3().setFromObject(S.meshGroup);
  const size = box.getSize(new THREE.Vector3());
  const d = Math.max(size.x, size.y, size.z) * 1.8;
  S.camera.position.set(d*0.6, d*0.35, d);
  S.controls.target.set(0,0,0);
};

// ════════════════════════════════
// CONTROLS
// ════════════════════════════════
function wireControls() {
  function b(id, vId, set, fmt) {
    $(id).addEventListener('input', e=>{ set(parseFloat(e.target.value)); $(vId).textContent=fmt(e.target.value); });
  }
  b('sl-scale', 'val-scale', v=>S.stickerScale=v, v=>parseFloat(v).toFixed(2));
  b('sl-rot', 'val-rot', v=>S.stickerRot=v, v=>Math.round(v)+'°');
  b('sl-opacity', 'val-opacity', v=>S.stickerOpacity=v, v=>Math.round(v*100)+'%');
}

window.resetTransform = () => {
  S.stickerScale = 1; S.stickerRot = 0; S.stickerOpacity = 1;
  $('sl-scale').value = 1; $('val-scale').textContent = '1.00';
  $('sl-rot').value = 0; $('val-rot').textContent = '0°';
  $('sl-opacity').value = 1; $('val-opacity').textContent = '100%';
};

window.toggleXray = () => {
  S.xray = !S.xray;
  $('btn-xray').textContent = S.xray ? 'ON' : 'OFF';
  $('btn-xray').classList.toggle('active', S.xray);
};

// ════════════════════════════════
// BAKE & EXPORT (Pixel Raycaster)
// ════════════════════════════════
window.bakeAndExport = () => {
  if (!S.active || !S.userImg) { toast('⚠️ Posicione a imagem na arma primeiro!'); return; }
  
  const res = parseInt($('sl-res').value);
  const canvas = $('bake-canvas');
  canvas.width = res; canvas.height = res;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  
  // Fill background invisible
  ctx.clearRect(0,0,res,res);
  const imgData = ctx.getImageData(0,0,res,res);
  const buf = imgData.data;

  // Draw user image onto an offscreen canvas to sample pixels easily
  const srcCv = document.createElement('canvas');
  srcCv.width = S.userImg.naturalWidth; srcCv.height = S.userImg.naturalHeight;
  const srcCtx = srcCv.getContext('2d');
  srcCtx.drawImage(S.userImg, 0, 0);
  const srcData = srcCtx.getImageData(0,0,srcCv.width, srcCv.height).data;

  const getPixel = (u, v) => {
    // u, v are 0 to 1
    let px = Math.floor(u * srcCv.width);
    let py = Math.floor((1 - v) * srcCv.height);
    if(px<0)px=0; if(px>=srcCv.width)px=srcCv.width-1;
    if(py<0)py=0; if(py>=srcCv.height)py=srcCv.height-1;
    const i = (py * srcCv.width + px) * 4;
    return [srcData[i], srcData[i+1], srcData[i+2], srcData[i+3]];
  };

  let painted = 0;
  
  // A tiny dummy camera to reuse Raycaster against UVs (screen-space inverse projection)
  // We iterate over every pixel grid of the output atlas.
  
  // To avoid complex raycasting, we project the fragments directly!
  // Iterate every mesh's BufferGeometry vertices, rasterize the triangles into the UV space.
  // Actually, simplest is: loop all pixels [x, y], raycast into 3D using the UV? No.
  // Easiest is to just brute force sample 3D world points for each pixel mapped inside UV rects!

  // Re-parse the geometry to get exact UV rect boxes
  const geoObj = JSON.parse(localStorage.getItem('last_geo') || '{}'); 
  // Wait, we don't need localstorage, we have S.allMeshes!
  
  S.allMeshes.forEach(mesh => {
     // Prepare matrix
     mesh.updateMatrixWorld(true);
     const mat = mesh.matrixWorld;
     const normMat = new THREE.Matrix3().getNormalMatrix(mat);
     
     const posAttr = mesh.geometry.attributes.position;
     const uvAttr = mesh.geometry.attributes.uv;
     const normAttr = mesh.geometry.attributes.normal;
     const index = mesh.geometry.index;

     const count = index ? index.count : posAttr.count;

     for (let i = 0; i < count; i += 3) {
        const a = index ? index.getX(i) : i;
        const b = index ? index.getX(i+1) : i+1;
        const c = index ? index.getX(i+2) : i+2;

        // Triangle in local space
        const v0 = new THREE.Vector3().fromBufferAttribute(posAttr, a);
        const v1 = new THREE.Vector3().fromBufferAttribute(posAttr, b);
        const v2 = new THREE.Vector3().fromBufferAttribute(posAttr, c);
        
        // UVs
        const uv0 = new THREE.Vector2().fromBufferAttribute(uvAttr, a);
        const uv1 = new THREE.Vector2().fromBufferAttribute(uvAttr, b);
        const uv2 = new THREE.Vector2().fromBufferAttribute(uvAttr, c);

        // Normal
        const targetNorm = new THREE.Vector3().fromBufferAttribute(normAttr, a).applyMatrix3(normMat).normalize();

        // Convert locally to world space
        v0.applyMatrix4(mat); v1.applyMatrix4(mat); v2.applyMatrix4(mat);

        // Bounding box in UV space
        const minU = Math.min(uv0.x, uv1.x, uv2.x);
        const maxU = Math.max(uv0.x, uv1.x, uv2.x);
        const minV = Math.min(uv0.y, uv1.y, uv2.y);
        const maxV = Math.max(uv0.y, uv1.y, uv2.y);
        
        // Pixel bounds
        const startX = Math.floor(minU * res);
        const endX = Math.ceil(maxU * res);
        // Remember Three.js V is inverted relative to canvas Y!
        const startY = Math.floor((1 - maxV) * res);
        const endY = Math.ceil((1 - minV) * res);

        for (let py = startY; py <= endY; py++) {
           for (let px = startX; px <= endX; px++) {
              if(px<0 || py<0 || px>=res || py>=res) continue;

              const u = (px + 0.5) / res;
              const v = 1 - (py + 0.5) / res;

              // Barycentric coordinates to interpolate 3D position
              const det = (uv1.y - uv2.y)*(uv0.x - uv2.x) + (uv2.x - uv1.x)*(uv0.y - uv2.y);
              if (det === 0) continue;
              const l1 = ((uv1.y - uv2.y)*(u - uv2.x) + (uv2.x - uv1.x)*(v - uv2.y)) / det;
              const l2 = ((uv2.y - uv0.y)*(u - uv2.x) + (uv0.x - uv2.x)*(v - uv2.y)) / det;
              const l3 = 1.0 - l1 - l2;

              if (l1 < -0.01 || l2 < -0.01 || l3 < -0.01) continue; // Outside triangle

              // Interpolate world position
              const wPos = new THREE.Vector3(
                v0.x*l1 + v1.x*l2 + v2.x*l3,
                v0.y*l1 + v1.y*l2 + v2.y*l3,
                v0.z*l1 + v1.z*l2 + v2.z*l3
              );

              // ── PLANAR PROJECTION MATH (same as shader) ──
              const facing = targetNorm.dot(S.stickerNormal);
              if (!S.xray && facing <= 0.01) continue;

              const toFrag = wPos.clone().sub(S.stickerPos);
              let localX = toFrag.dot(S.stickerRight) / S.stickerScale;
              let localY = toFrag.dot(S.stickerUp) / S.stickerScale;

              const aspect = srcCv.width / srcCv.height;
              localY *= aspect;

              const c = Math.cos(-S.stickerRot * Math.PI/180);
              const s = Math.sin(-S.stickerRot * Math.PI/180);
              const rx = localX * c - localY * s;
              const ry = localX * s + localY * c;

              if (Math.abs(rx) <= 0.5 && Math.abs(ry) <= 0.5) {
                const sampleU = rx + 0.5;
                const sampleV = ry + 0.5; // (in sample space, 0=bottom, 1=top!)
                
                const [sr,sg,sb,sa] = getPixel(sampleU, sampleV);
                if (sa > 10) {
                   const alpha = (sa/255) * S.stickerOpacity;
                   const i = (py * res + px) * 4;
                   
                   const oldA = buf[i+3]/255;
                   const outA = alpha + oldA * (1 - alpha);
                   
                   buf[i]   = (sr * alpha + buf[i]   * oldA * (1 - alpha)) / outA;
                   buf[i+1] = (sg * alpha + buf[i+1] * oldA * (1 - alpha)) / outA;
                   buf[i+2] = (sb * alpha + buf[i+2] * oldA * (1 - alpha)) / outA;
                   buf[i+3] = Math.round(outA * 255);
                   
                   painted++;
                }
              }
           }
        }
     }
  });

  ctx.putImageData(imgData, 0, 0);

  canvas.toBlob(blob => {
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: (S.geoMeta?.identifier?.replace('geometry.','') || 'skin') + '.png'
    });
    a.click(); URL.revokeObjectURL(a.href);
    toast(`✅ PNG Exportado! (${painted} pixels pintados)`);
  }, 'image/png');
};

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3500);
}

init();
