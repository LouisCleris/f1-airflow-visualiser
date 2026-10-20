// Continuous wheel rotation. Spins each wheel-corner mesh (tire, wheelover
// rim, inside cover -- see WHEEL_SPIN_COMPONENTS in car.js) around its own
// axle axis every frame.
//
// Axle axis derivation: the GLB's wheel nodes carry a static -90 degree
// rotation about Z (quaternion (0,0,-0.707,0.707)). Direct inspection of
// the "Front Tire" mesh's local-space bounding box (x/z spans ~ +-1.6,
// y span ~2.0 offset from 0) shows the wheel disc lies in the local X/Z
// plane with the rotational axis along local Y -- i.e. the tire's own
// unrotated model-space Y axis is its axle. Object3D.rotateY() rotates
// about exactly that axis (it post-multiplies the current quaternion by a
// rotation about local Y as authored, independent of whatever static
// orientation is already applied), so it spins the wheel correctly
// regardless of the static -90 degree Z placement rotation.
//
// Mirrored wheels (see car.js) need the NEGATED angle to look like a true
// mirror image rolling the same physical direction as the original --
// mirroring a rotation about an axis that lies in the mirror plane (Y does,
// since the mirror plane is world X=0) negates the rotation angle. Without
// this, the reconstructed left-side wheels would visibly spin backwards
// relative to the real right-side wheels.

/**
 * Rolling without slipping (Phase 5 review): the road moves past the car at the speed of the oncoming air (the rolling
 * road of an F1 wind tunnel, src/track.js), so each wheel turns at the road's speed under it divided by its own
 * tyre's rolling radius -- half the height of that tyre, measured from its vertices on the car as displayed.
 *
 * @param {Array<{ mesh: import('three').Object3D, mirrored: boolean }>} wheels
 * @param {typeof import('three')} THREE
 * @param {number} roadSpeed world units per second of simulated time, at the car
 * @returns {(deltaSeconds: number, speedFactorAt?: (x: number, z: number) => number) => void} deltaSeconds is
 *   simulated time (the Speed slider scales it, Pause zeroes it); speedFactorAt, if given, scales the road speed
 *   under each tyre (in a corner the outside tyres run on faster-moving road than the inside ones)
 */
export function createWheelSpinner(wheels, THREE, roadSpeed) {
  // each wheel-corner part spins with its own corner's tyre: same axle (Front/Rear), same side
  const tyres = {};
  for (const w of wheels) {
    const name = w.mesh.userData.name || '';
    if (!name.endsWith('Tire')) continue;
    w.mesh.updateWorldMatrix(true, false);
    const box = new THREE.Box3().setFromObject(w.mesh, true);
    tyres[`${name.split(' ')[0]}|${w.mirrored}`] = { radius: (box.max.y - box.min.y) / 2, centre: box.getCenter(new THREE.Vector3()) };
  }
  const fallback = Object.values(tyres)[0] || { radius: 0.36, centre: new THREE.Vector3() };
  const corner = wheels.map((w) => tyres[`${String(w.mesh.userData.name || '').split(' ')[0]}|${w.mirrored}`] || fallback);
  return function updateWheelSpin(deltaSeconds, speedFactorAt = null) {
    if (!deltaSeconds) return;
    wheels.forEach(({ mesh, mirrored }, i) => {
      const { radius, centre } = corner[i];
      const angle = (roadSpeed * (speedFactorAt ? speedFactorAt(centre.x, centre.z) : 1) * deltaSeconds) / radius;
      mesh.rotateY(mirrored ? -angle : angle);
    });
  };
}

const FRONT_WHEEL_PARTS = new Set(['Front Wheelover', 'Front Tire', 'Front Inside Cover']);

/**
 * Front-wheel steer (Phase 5, cornering). Each front corner's rotating parts turn together about a vertical axis
 * through the centre of that corner's tyre. The turn is applied on top of whatever the wheel's spin has reached,
 * as a change from the current steer angle, so it composes with createWheelSpinner (which spins about the axle).
 *
 * @param {Array<{ mesh: import('three').Object3D, mirrored: boolean }>} wheels
 * @param {typeof import('three')} THREE
 * @returns {(deg: number) => void} sets the steer angle; positive steers to the car's left (+x, the nose is +z)
 */
export function createFrontSteer(wheels, THREE) {
  const corners = [false, true].map((mirrored) => {
    const parts = wheels.filter((w) => w.mirrored === mirrored && FRONT_WHEEL_PARTS.has(w.mesh.userData.name)).map((w) => w.mesh);
    const tyre = parts.find((m) => m.userData.name === 'Front Tire') || parts[0];
    const centre = tyre ? new THREE.Box3().setFromObject(tyre).getCenter(new THREE.Vector3()) : new THREE.Vector3();
    return { parts, centre };
  }).filter((c) => c.parts.length);
  let current = 0;
  const turn = new THREE.Matrix4(), toPivot = new THREE.Matrix4(), fromPivot = new THREE.Matrix4(), m = new THREE.Matrix4(), parentInv = new THREE.Matrix4();
  return function setSteer(deg) {
    const delta = ((deg - current) * Math.PI) / 180;
    if (delta === 0) return;
    current = deg;
    for (const { parts, centre } of corners) {
      // world-space turn about the tyre's vertical axis: T(centre) * Ry(delta) * T(-centre)
      turn.makeTranslation(centre.x, centre.y, centre.z).multiply(m.makeRotationY(delta)).multiply(fromPivot.makeTranslation(-centre.x, -centre.y, -centre.z));
      for (const mesh of parts) {
        mesh.updateWorldMatrix(true, false);
        parentInv.copy(mesh.parent.matrixWorld).invert();
        toPivot.multiplyMatrices(turn, mesh.matrixWorld); // new world matrix
        m.multiplyMatrices(parentInv, toPivot).decompose(mesh.position, mesh.quaternion, mesh.scale);
      }
    }
  };
}
