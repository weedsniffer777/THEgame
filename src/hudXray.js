// X-ray damage view (bottom left): a top-down silhouette of the jet, each part tinted by its health:
// green, yellow, red, then dark when it's gone. Parts match the damage model.
const SHAPES = {
  // top view, nose up; x across (left wing on the left), y down the jet. viewBox 0 0 100 120
  nose:       'M50 2 L55 22 L45 22 Z',
  body:       'M45 22 L55 22 L57 50 L58 96 L56 108 L44 108 L42 96 L43 50 Z',
  wingInnerL: 'M43 52 L27 62 L25 74 L43 74 Z',
  wingInnerR: 'M57 52 L73 62 L75 74 L57 74 Z',
  wingOuterL: 'M27 62 L6 72 L5 76 L25 74 Z',
  wingOuterR: 'M73 62 L94 72 L95 76 L75 74 Z',
  stabL:      'M43 96 L31 106 L31 110 L44 106 Z',
  stabR:      'M57 96 L69 106 L69 110 L56 106 Z',
  fin:        'M49 86 L51 86 L51.5 110 L48.5 110 Z',
};
const ORDER = ['body', 'nose', 'wingInnerL', 'wingInnerR', 'wingOuterL', 'wingOuterR', 'stabL', 'stabR', 'fin'];

function tint(f) {   // health 1 -> 0: green, yellow, red
  const g = [96, 220, 120], y = [240, 210, 70], r = [235, 70, 55];
  const [a, b, t] = f > 0.5 ? [y, g, (f - 0.5) * 2] : [r, y, f * 2];
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;
}

export function createXray(root, damage, maxHp) {
  root.innerHTML = `<svg viewBox="0 0 100 120" width="64" height="77" aria-hidden="true">${ORDER.map(n => `<path data-p="${n}" d="${SHAPES[n]}"/>`).join('')}</svg>`;
  const els = Object.fromEntries([...root.querySelectorAll('path')].map(p => [p.dataset.p, p]));
  const last = {};
  return () => {
    for (const n of ORDER) {
      let fill;
      if (n === 'body') fill = tint(Math.max(0, damage.bodyHp) / maxHp.body);
      else {
        const p = damage.parts[n];
        if (!p) continue;
        fill = p.broken ? 'rgba(20,20,22,0.55)' : tint(p.hp / (maxHp[n] || 1));
      }
      if (last[n] !== fill) { els[n].setAttribute('fill', fill); last[n] = fill; }
    }
  };
}
