import * as THREE from 'three';

// A thin ring around the reticle. Each item (for now: the nearest enemy) is a pointer on the ring toward something
// outside it or off screen: a red triangle with the aircraft type and distance just outside. Items are generic
// ({ pos, kind, label }) so friendlies and missile warnings can live on the same ring later.
const R = 104;                         // ring radius (px)
const _v = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion();

export function createRing(root) {
  const el = document.createElement('div');
  el.id = 'ring';
  el.innerHTML = `<svg class="circ" width="${2 * R + 4}" height="${2 * R + 4}"><circle cx="${R + 2}" cy="${R + 2}" r="${R}"/></svg>`;
  root.appendChild(el);
  const ptrs = [];
  const ptr = (k) => {
    if (ptrs[k]) return ptrs[k];
    const p = document.createElement('div');
    p.className = 'ptr';
    p.innerHTML = `<svg width="16" height="14" viewBox="0 0 16 14"><path d="M8 0 L16 14 L0 14 Z"/></svg><b><i></i><span></span></b>`;
    el.appendChild(p);
    p._t = p.querySelector('i'); p._d = p.querySelector('span'); p._txt = '';
    return (ptrs[k] = p);
  };

  // centre: [x, y] on screen (the reticle); items: [{ pos, kind: 'foe', type, dist }]
  return function update(center, items, camera) {
    el.style.display = center && items.length ? '' : 'none';
    let n = 0;
    if (center && items.length) {
      el.style.transform = `translate(${center[0]}px, ${center[1]}px)`;
      _q.copy(camera.quaternion).invert();
      for (const it of items) {
        _v.subVectors(it.pos, camera.position).applyQuaternion(_q);          // camera space: x right, y up, -z ahead
        const s = _s.copy(_v).applyMatrix4(camera.projectionMatrix);
        const sx = (s.x * 0.5) * innerWidth, sy = -(s.y * 0.5) * innerHeight;
        const behind = _v.z > 0, scr = [innerWidth / 2 + sx - center[0], innerHeight / 2 + sy - center[1]];
        if (!behind && Math.hypot(scr[0], scr[1]) < R) continue;              // inside the ring: the marker on it is enough
        const ang = behind ? Math.atan2(_v.x, _v.y) : Math.atan2(scr[0], -scr[1]);   // 0 = up, clockwise
        const p = ptr(n++);
        p.style.display = '';
        p.className = 'ptr ' + (it.kind || 'foe');
        const x = Math.sin(ang) * R, y = -Math.cos(ang) * R;
        p.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
        p.firstChild.style.transform = `translate(-8px, -7px) rotate(${ang}rad)`;
        // the label sits just outside the ring, kept upright
        const lx = Math.sin(ang) * 30, ly = -Math.cos(ang) * 22;
        p.lastChild.style.transform = `translate(calc(${lx.toFixed(1)}px - 50%), calc(${ly.toFixed(1)}px - 50%))`;
        const txt = it.type + '|' + it.dist;
        if (txt !== p._txt) { p._t.textContent = it.type; p._d.innerHTML = it.dist; p._txt = txt; }
        p._at = [center[0] + x, center[1] + y];
      }
    }
    for (let k = n; k < ptrs.length; k++) { ptrs[k].style.display = 'none'; ptrs[k]._at = null; }
  };
}
// the first pointer's screen position (for the tutorial spotlight), or null
export function ringPointer() { const p = document.querySelector('#ring .ptr'); return p && p.style.display !== 'none' && p._at ? p._at : null; }
