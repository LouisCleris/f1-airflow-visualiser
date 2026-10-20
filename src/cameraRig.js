// Camera moves for the interface: preset and part fly-tos along an arc around the target (so the path does not cut
// through the car), and a guard that keeps the camera outside the car's bounding box at all times.

import * as THREE from 'three';
import { CAMERA_CONFIG } from './uiConfig.js';

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * @param {THREE.PerspectiveCamera} camera
 * @param {import('three/addons/controls/OrbitControls.js').OrbitControls} controls
 * @param {THREE.Box3} carBox world bounding box of the car
 */
export function createCameraRig(camera, controls, carBox, cfg = CAMERA_CONFIG, { hasGround = true } = {}) {
  const keepOut = carBox.clone().expandByScalar(cfg.keepOutMargin);
  let flight = null;

  controls.minDistance = cfg.minDistance;
  controls.maxDistance = cfg.maxDistance;
  controls.addEventListener('start', () => { if (flight) setFov(flight.fov1); flight = null; }); // the user takes over
  const baseFov = cfg.fov ?? 50; // vertical field of view, degrees; a preset may ask for another (a long lens)

  function setFov(f) {
    if (camera.fov === f) return;
    camera.fov = f;
    camera.updateProjectionMatrix();
  }

  /** `fov` (optional): the field of view to arrive with; every other move returns to the normal lens. */
  function flyTo(position, target, immediate = false, fov = baseFov) {
    const p1 = new THREE.Vector3(...position);
    const t1 = new THREE.Vector3(...target);
    if (immediate) {
      flight = null; // a jump replaces any move still under way, which would otherwise carry on from where it was
      camera.position.copy(p1);
      controls.target.copy(t1);
      setFov(fov);
      controls.update();
      return;
    }
    const t0 = controls.target.clone();
    const o0 = camera.position.clone().sub(t0);
    const o1 = p1.clone().sub(t1);
    const q = new THREE.Quaternion().setFromUnitVectors(o0.clone().normalize(), o1.clone().normalize());
    flight = { t0, t1, len0: o0.length(), len1: o1.length(), dir0: o0.normalize(), q, fov0: camera.fov, fov1: fov, start: performance.now() };
  }

  /** A position and target that frame `box` from the front-right (or rear-right for parts behind the middle). */
  function frameBox(box) {
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const rear = sphere.center.z < -0.6;
    const dir = new THREE.Vector3(...(rear ? cfg.rearFrameDirection : cfg.frameDirection)).normalize();
    const dist = Math.max(cfg.minFrameDistance, sphere.radius * cfg.frameDistanceFactor);
    return { position: sphere.center.clone().addScaledVector(dir, dist).toArray(), target: sphere.center.toArray() };
  }

  const identity = new THREE.Quaternion();
  const tmp = new THREE.Vector3();
  function update() {
    if (flight) {
      const k = Math.min(1, (performance.now() - flight.start) / cfg.flyDurationMs);
      const e = ease(k);
      controls.target.lerpVectors(flight.t0, flight.t1, e);
      const q = identity.clone().slerp(flight.q, e);
      tmp.copy(flight.dir0).applyQuaternion(q).multiplyScalar(flight.len0 + (flight.len1 - flight.len0) * e);
      camera.position.copy(controls.target).add(tmp);
      if (flight.fov0 !== flight.fov1) setFov(flight.fov0 + (flight.fov1 - flight.fov0) * e);
      if (k >= 1) flight = null;
    }
    controls.update();
    pushOutOfCar();
  }

  // If the camera is inside the (inflated) bounding box, move it out through the nearest face.
  function pushOutOfCar() {
    const p = camera.position;
    if (!keepOut.containsPoint(p)) return;
    const d = [
      p.x - keepOut.min.x, keepOut.max.x - p.x,
      p.y - keepOut.min.y, keepOut.max.y - p.y,
      p.z - keepOut.min.z, keepOut.max.z - p.z,
    ];
    let best = 0;
    for (let i = 1; i < 6; i++) if (d[i] < d[best]) best = i;
    // never out through the road (a scene without one may leave through the bottom)
    if (hasGround && best === 2) { d[2] = Infinity; best = 0; for (let i = 1; i < 6; i++) if (d[i] < d[best]) best = i; }
    const axis = ['x', 'x', 'y', 'y', 'z', 'z'][best];
    p[axis] = best % 2 === 0 ? keepOut.min[axis] - 0.01 : keepOut.max[axis] + 0.01;
  }

  /** Called when this rig's scene becomes the visible one: its orbit limits apply again. */
  function activate() {
    controls.minDistance = cfg.minDistance;
    controls.maxDistance = cfg.maxDistance;
    flight = null;
  }

  return { flyTo, frameBox, update, keepOut, activate, isFlying: () => !!flight };
}
