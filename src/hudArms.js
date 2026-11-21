// Weapon panel (bottom right): one row per weapon, key hint, white silhouette, and what's left.
// Guns: infinite ammo, so an infinity sign. Missiles: one silhouette per missile; spent ones go hollow.

// side view of the short-range missile, nose to the right (2.9 m long, 0.13 m body, canards and finned tail)
const MISSILE = `<svg viewBox="0 0 100 14" width="60" height="9" aria-hidden="true"><path d="
  M5 5.4 H88 Q95 5.6 98.5 7 Q95 8.4 88 8.6 H5 Z
  M77 5.4 L85.5 5.4 L82.5 0.9 Z  M77 8.6 L85.5 8.6 L82.5 13.1 Z
  M5.5 5.4 L17 5.4 L12.5 0.4 L6.5 0.4 Z  M5.5 8.6 L17 8.6 L12.5 13.6 L6.5 13.6 Z
  M2.5 5.9 H5 V8.1 H2.5 Z"/></svg>`;

// side view of the 20 mm revolver cannon: feed and receiver box, gas housing, drum, collars, long barrel
const GUN = `<svg viewBox="0 0 124 22" width="112" height="20" aria-hidden="true"><path fill-rule="evenodd" d="
  M0 9 H3 V14 H0 Z
  M3 6 H40 V16 H3 Z  M7 7.5 H13 V10 H7 Z  M15 7.5 H21 V10 H15 Z  M7 12 H34 V14 H7 Z
  M9 2.5 H26 V6 H9 Z  M11 1.2 H14 V2.5 H11 Z
  M5 16 H38 V18 H5 Z  M28 18 H33 V20.5 H28 Z
  M40 6 L47 3.5 L52 3.5 L52 16 L40 16 Z
  M52 5.2 H66 Q67.5 9.75 66 14.3 H52 Z  M57 7 H61 V8.5 H57 Z
  M66.5 6.6 H69 V12.9 H66.5 Z  M70 7.2 H72.5 V12.3 H70 Z
  M72.5 8.4 H119 V11.1 H72.5 Z
  M118 7.8 H122.5 V11.7 H118 Z"/></svg>`;

const INF = `<svg viewBox="0 0 24 12" width="22" height="11" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"
  d="M12 6 C9.5 1.5 3 1.5 3 6 C3 10.5 9.5 10.5 12 6 C14.5 1.5 21 1.5 21 6 C21 10.5 14.5 10.5 12 6 Z"/></svg>`;

export function createArmsHud(root, missileCount) {
  root.innerHTML = `
    <div class="row" data-w="1"><b class="key">1</b><span class="gun">${GUN}</span><span class="inf">${INF}</span></div>
    <div class="row" data-w="2"><b class="key">2</b><span class="msl">${Array.from({ length: missileCount }, () => `<i>${MISSILE}</i>`).join('')}</span></div>`;
  const rows = [...root.querySelectorAll('.row')];
  const mis = [...root.querySelectorAll('.msl i')];
  let lastSel = -1, lastStock = -1, lastLock = null;
  return (selected, stock, locked) => {
    if (selected !== lastSel) { rows.forEach(r => r.classList.toggle('sel', +r.dataset.w === selected)); lastSel = selected; }
    if (stock !== lastStock) { mis.forEach((m, k) => m.classList.toggle('spent', k >= stock)); lastStock = stock; }
    if (locked !== lastLock) { root.classList.toggle('locked', locked); lastLock = locked; }
  };
}
