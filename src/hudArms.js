// Weapon panel (bottom right, beside the X-ray): one column per weapon, its key number on top, the weapon pointing up.
// Guns: the cannon, infinite ammo. Missiles: one standing silhouette per missile in a row; spent ones go hollow.
// Rockets (a jet with pods): small rocket silhouettes in two stacked rows; spent ones go hollow.

// side view traced from the missile model itself (triangles projected sideways and rasterised), nose to the right
export const MISSILE = `<svg viewBox="0 0 200 34" width="60" height="10.2" aria-hidden="true"><path d="M137 0h6v1h-6zM1 1h28v1h-28zM137 1h7v1h-7zM1 2h29v1h-29zM137 2h7v1h-7zM1 3h30v1h-30zM137 3h7v1h-7zM1 4h31v1h-31zM138 4h7v1h-7zM1 5h32v1h-32zM138 5h8v1h-8zM1 6h33v1h-33zM138 6h10v1h-10zM1 7h34v1h-34zM138 7h13v1h-13zM1 8h35v1h-35zM138 8h15v1h-15zM1 9h36v1h-36zM138 9h17v1h-17zM1 10h37v1h-37zM139 10h19v1h-19zM1 11h38v1h-38zM139 11h21v1h-21zM1 12h39v1h-39zM139 12h24v1h-24zM0 13h192v1h-192zM0 14h198v1h-198zM0 15h199v1h-199zM0 16h200v1h-200zM0 17h200v1h-200zM0 18h199v1h-199zM0 19h198v1h-198zM1 20h188v1h-188zM1 21h39v1h-39zM139 21h22v1h-22zM1 22h38v1h-38zM139 22h20v1h-20zM1 23h37v1h-37zM138 23h19v1h-19zM1 24h36v1h-36zM138 24h16v1h-16zM1 25h35v1h-35zM138 25h14v1h-14zM1 26h34v1h-34zM138 26h12v1h-12zM1 27h33v1h-33zM138 27h9v1h-9zM1 28h32v1h-32zM138 28h7v1h-7zM1 29h31v1h-31zM138 29h6v1h-6zM1 30h30v1h-30zM137 30h7v1h-7zM1 31h29v1h-29zM137 31h7v1h-7zM137 32h7v1h-7zM137 33h6v1h-6z"/></svg>`;

// side view of the 20 mm revolver cannon: feed and receiver box, gas housing, drum, collars, long barrel
export const GUN = `<svg viewBox="0 0 124 22" width="112" height="20" aria-hidden="true"><path fill-rule="evenodd" d="
  M0 9 H3 V14 H0 Z
  M3 6 H40 V16 H3 Z  M7 7.5 H13 V10 H7 Z  M15 7.5 H21 V10 H15 Z  M7 12 H34 V14 H7 Z
  M9 2.5 H26 V6 H9 Z  M11 1.2 H14 V2.5 H11 Z
  M5 16 H38 V18 H5 Z  M28 18 H33 V20.5 H28 Z
  M40 6 L47 3.5 L52 3.5 L52 16 L40 16 Z
  M52 5.2 H66 Q67.5 9.75 66 14.3 H52 Z  M57 7 H61 V8.5 H57 Z
  M66.5 6.6 H69 V12.9 H66.5 Z  M70 7.2 H72.5 V12.3 H70 Z
  M72.5 8.4 H119 V11.1 H72.5 Z
  M118 7.8 H122.5 V11.7 H118 Z"/></svg>`;

// a slim unguided rocket, side view, nose to the right
export const ROCKET = `<svg viewBox="0 0 60 10" aria-hidden="true"><path d="M0 2.5 L6 3.6 H48 Q55 4 60 5 Q55 6 48 6.4 H6 L0 7.5 Z"/></svg>`;

export function createArmsHud(root, missileCount, onSelect, rocketCount = 0) {
  root.innerHTML = `
    <div class="col" data-w="1"><b class="key">1</b><span class="gun">${GUN}</span></div>
    <div class="col" data-w="2"><b class="key">2</b><span class="msl">${Array.from({ length: missileCount }, () => `<i>${MISSILE}</i>`).join('')}</span></div>` +
    (rocketCount ? `<div class="col" data-w="3"><b class="key">3</b><span class="rkt">${[0, 1].map(r => `<span>${Array.from({ length: Math.ceil(rocketCount / 2) }, () => `<i>${ROCKET}</i>`).join('')}</span>`).join('')}</span></div>` : '');
  const cols = [...root.querySelectorAll('.col')];
  cols.forEach(r => r.addEventListener('pointerdown', (e) => { e.preventDefault(); onSelect?.(+r.dataset.w); }));   // (touch screens: tap a weapon to select it)
  const mis = [...root.querySelectorAll('.msl i')];
  // rockets go top row first (left to right), then the bottom row
  const rk = [...root.querySelectorAll('.rkt i')];
  let lastSel = -1, lastStock = -1, lastLock = null, lastR = -1;
  return (selected, stock, locked, rockets = 0) => {
    if (rockets !== lastR) { rk.forEach((m, k) => m.classList.toggle('spent', k >= rockets)); lastR = rockets; }
    if (selected !== lastSel) { cols.forEach(r => r.classList.toggle('sel', +r.dataset.w === selected)); lastSel = selected; }
    if (stock !== lastStock) { mis.forEach((m, k) => m.classList.toggle('spent', k >= stock)); lastStock = stock; }
    if (locked !== lastLock) { root.classList.toggle('locked', locked); lastLock = locked; }
  };
}
