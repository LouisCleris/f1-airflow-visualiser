// Thin three.js wrapper around trailBuffers.js: owns the actual
// THREE.LineSegments object (geometry + material) and re-fills its
// attributes from a particle system every frame. This is the only file in
// src/particles/ that touches three.js rendering objects; the buffer-
// filling math itself lives in trailBuffers.js so it stays testable without
// a renderer.
//
// Per-vertex alpha: three.js honours a 4-component (RGBA) `color`
// BufferAttribute on any vertexColors-enabled material (confirmed in
// node_modules/three/src/renderers/webgl/WebGLPrograms.js --
// `vertexAlphas: material.vertexColors === true && geometry.attributes
// .color.itemSize === 4`, which turns on the USE_COLOR_ALPHA shader path).
// That is what gives each trail its "fading ribbon" look -- LineBasicMaterial
// with transparent:true, vertexColors:true, and a 4-wide color attribute --
// without a custom ShaderMaterial.

import * as THREE from 'three';
import { createTrailBuffers, fillTrailBuffers, segmentsPerParticle } from './trailBuffers.js';

/**
 * @param {{ maxCount: number, trailLength: number, color: [number, number, number],
 *   minAlpha: number, maxAlpha: number }} config
 */
export function createTrailRenderer(config) {
  const buffers = createTrailBuffers(config.maxCount, config.trailLength, config.color);

  const geometry = new THREE.BufferGeometry();
  const positionAttr = new THREE.BufferAttribute(buffers.positions, 3);
  const colorAttr = new THREE.BufferAttribute(buffers.colors, 4);
  positionAttr.setUsage(THREE.DynamicDrawUsage);
  colorAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positionAttr);
  geometry.setAttribute('color', colorAttr);
  geometry.setDrawRange(0, 0);

  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    // depthTest true (three.js's own Material default -- nothing here was
    // overriding it, but stated explicitly per the author's review) + depthWrite
    // false: trails are correctly hidden behind the opaque car/road (which
    // render first and populate the depth buffer) without themselves
    // punching holes in that depth buffer for other trails behind them.
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });

  const object3D = new THREE.LineSegments(geometry, material);
  object3D.name = 'Particle Trails';
  object3D.frustumCulled = false; // domain can be larger than the car's own bounds

  /**
   * @param {ReturnType<import('./particleSystem.js').createParticleSystem>} system
   */
  function sync(system) {
    const drawnVerts = fillTrailBuffers(system, buffers, {
      minAlpha: config.minAlpha,
      maxAlpha: config.maxAlpha,
    });
    positionAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
    geometry.setDrawRange(0, drawnVerts);
  }

  return { object3D, sync, segmentsPerParticle: segmentsPerParticle(config.trailLength) };
}
