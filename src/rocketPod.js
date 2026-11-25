import * as THREE from 'three';

// Our own rocket pod (B-13 style, drawn here, no third-party model): a grey tube with two bands and its hanging lugs,
// the front face cut by five launch tubes round a central hub, each with a rocket's nose sitting in it; a short
// tapered tail with the five tube exits. Nose toward +Z, centred on its middle. userData.tips: the five rocket noses (hidden as they're fired).
export const POD = { length: 2.4, radius: 0.2, rockets: 5, ring: 0.115, tube: 0.062 };

let mats = null;
export function makePod() {
  mats ||= {
    body: new THREE.MeshStandardMaterial({ color: 0xb6bbc0, metalness: 0.55, roughness: 0.42 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x17191b, metalness: 0.2, roughness: 0.85, side: THREE.DoubleSide }),
    tip: new THREE.MeshStandardMaterial({ color: 0x55603f, metalness: 0.35, roughness: 0.55 }),
    nozzle: new THREE.MeshStandardMaterial({ color: 0x4a4744, metalness: 0.6, roughness: 0.5, side: THREE.DoubleSide }),
  };
  const { length: L, radius: R, ring, tube } = POD;
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(R, R, L, 32, 1, true).rotateX(Math.PI / 2), mats.body));
  // the front face, with its five tube openings round the hub
  const face = new THREE.Shape(); face.absarc(0, 0, R, 0, Math.PI * 2, false);
  const at = [];
  for (let k = 0; k < POD.rockets; k++) {
    const a = Math.PI / 2 + k * Math.PI * 2 / POD.rockets, x = Math.cos(a) * ring, y = Math.sin(a) * ring;
    at.push([x, y]);
    const h = new THREE.Path(); h.absarc(x, y, tube, 0, Math.PI * 2, true); face.holes.push(h);
  }
  const front = new THREE.Mesh(new THREE.ShapeGeometry(face, 20), mats.body); front.position.z = L / 2; g.add(front);
  const hub = new THREE.Mesh(new THREE.SphereGeometry(0.045, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2), mats.body);
  hub.position.z = L / 2; g.add(hub);
  const tips = [];
  for (const [x, y] of at) {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(tube, tube, 0.36, 16, 1, true).rotateX(Math.PI / 2), mats.dark);
    t.position.set(x, y, L / 2 - 0.18); g.add(t);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(tube * 0.85, 0.16, 14).rotateX(Math.PI / 2), mats.tip);
    nose.position.set(x, y, L / 2 - 0.1); g.add(nose); tips.push(nose);
  }
  // tail: a short taper to a rear face with the five tube exits (each with the rocket's nozzle deep inside) round a
  // small hub; the motors blast out through these
  const TL = 0.14, RT = R * 0.93, rearZ = -L / 2 - TL;
  const tail = new THREE.Mesh(new THREE.CylinderGeometry(R, RT, TL, 32, 1, true).rotateX(-Math.PI / 2), mats.body);
  tail.position.z = -L / 2 - TL / 2; g.add(tail);
  const back = new THREE.Shape(); back.absarc(0, 0, RT, 0, Math.PI * 2, false);
  const rt = tube * 0.9;
  for (const [x, y] of at) { const h = new THREE.Path(); h.absarc(x, y, rt, 0, Math.PI * 2, true); back.holes.push(h); }
  const rear = new THREE.Mesh(new THREE.ShapeGeometry(back, 20).rotateY(Math.PI), mats.body); rear.position.z = rearZ; g.add(rear);
  const rearHub = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.05, 14).rotateX(-Math.PI / 2), mats.body); rearHub.position.z = rearZ - 0.02; g.add(rearHub);
  for (const [x, y] of at) {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(rt, rt, 0.42, 16, 1, true).rotateX(Math.PI / 2), mats.dark);
    t.position.set(x, y, rearZ + 0.21); g.add(t);
    const lip = new THREE.Mesh(new THREE.TorusGeometry(rt, 0.006, 6, 20), mats.body); lip.position.set(x, y, rearZ); g.add(lip);
    // the rocket's nozzle inside the tube: a ring and its dark throat
    const nz = new THREE.Mesh(new THREE.CylinderGeometry(rt * 0.55, rt * 0.75, 0.05, 14, 1, true).rotateX(-Math.PI / 2), mats.nozzle); nz.position.set(x, y, rearZ + 0.3); g.add(nz);
    const throat = new THREE.Mesh(new THREE.CircleGeometry(rt * 0.55, 14).rotateY(Math.PI), mats.dark); throat.position.set(x, y, rearZ + 0.32); g.add(throat);
    const base = new THREE.Mesh(new THREE.RingGeometry(rt * 0.75, rt, 16).rotateY(Math.PI), mats.nozzle); base.position.set(x, y, rearZ + 0.33); g.add(base);
  }
  // two bands and the lugs it hangs by
  for (const z of [-0.55, 0.55]) { const b = new THREE.Mesh(new THREE.TorusGeometry(R + 0.004, 0.011, 6, 32), mats.body); b.position.z = z; g.add(b); }
  for (const z of [-0.36, 0.36]) { const l = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.09), mats.body); l.position.set(0, R + 0.02, z); g.add(l); }
  g.traverse(o => { if (o.isMesh) o.userData.noSplit = o.userData.noBulk = true; });
  g.userData.tips = tips;
  g.userData.mouths = at.map(([x, y]) => new THREE.Vector3(x, y, L / 2 + 0.05));   // where each rocket leaves (pod space)
  g.userData.rears = at.map(([x, y]) => new THREE.Vector3(x, y, rearZ - 0.02));     // where its motor blasts out behind
  return g;
}

// one rocket in flight: a slim body with four small fins
let rmesh = null;
export function makeRocket() {
  if (!rmesh) {
    const m = new THREE.MeshStandardMaterial({ color: 0x8a9097, metalness: 0.5, roughness: 0.5 });
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 1.6, 10).rotateX(Math.PI / 2), m));
    const n = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.25, 10).rotateX(Math.PI / 2), m); n.position.z = 0.92; g.add(n);
    for (let k = 0; k < 4; k++) { const f = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.16, 0.18), m); f.position.set(0, 0, -0.72); f.rotation.z = k * Math.PI / 2; f.translateY(0.1); g.add(f); }
    rmesh = g;
  }
  return rmesh.clone();
}
