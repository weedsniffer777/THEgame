import * as THREE from 'three';

// Our own rocket pod (B-13 style, drawn here, no third-party model): a grey tube with two bands and its hanging lugs,
// the front face cut by five launch tubes round a central hub, each with a rocket's nose sitting in it; a short
// tapered tail. Nose toward +Z, centred on its middle. userData.tips: the five rocket noses (hidden as they're fired).
export const POD = { length: 2.4, radius: 0.2, rockets: 5, ring: 0.115, tube: 0.062 };

let mats = null;
export function makePod() {
  mats ||= {
    body: new THREE.MeshStandardMaterial({ color: 0xb6bbc0, metalness: 0.55, roughness: 0.42 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x17191b, metalness: 0.2, roughness: 0.85, side: THREE.DoubleSide }),
    tip: new THREE.MeshStandardMaterial({ color: 0x55603f, metalness: 0.35, roughness: 0.55 }),
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
  // tail: a short taper and a closing disc
  const tail = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 0.8, 0.14, 32, 1, true).rotateX(-Math.PI / 2), mats.body);
  tail.position.z = -L / 2 - 0.07; g.add(tail);
  const cap = new THREE.Mesh(new THREE.CircleGeometry(R * 0.8, 32).rotateY(Math.PI), mats.body); cap.position.z = -L / 2 - 0.14; g.add(cap);
  // two bands and the lugs it hangs by
  for (const z of [-0.55, 0.55]) { const b = new THREE.Mesh(new THREE.TorusGeometry(R + 0.004, 0.011, 6, 32), mats.body); b.position.z = z; g.add(b); }
  for (const z of [-0.36, 0.36]) { const l = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.09), mats.body); l.position.set(0, R + 0.02, z); g.add(l); }
  g.traverse(o => { if (o.isMesh) o.userData.noSplit = o.userData.noBulk = true; });
  g.userData.tips = tips;
  g.userData.mouths = at.map(([x, y]) => new THREE.Vector3(x, y, L / 2 + 0.05));   // where each rocket leaves (pod space)
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
