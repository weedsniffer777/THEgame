// International Standard Atmosphere, troposphere and lower stratosphere.
export const RHO0 = 1.225;

export function atmosphere(h, out = {}) {
  let T, rho;
  if (h < 11000) {
    T = 288.15 - 0.0065 * h;
    const p = 101325 * Math.pow(T / 288.15, 5.2559);
    rho = p / (287.05 * T);
  } else {
    T = 216.65;
    rho = 0.3639 * Math.exp(-(h - 11000) / 6341.6);
  }
  out.rho = rho;
  out.soundSpeed = Math.sqrt(1.4 * 287.05 * T);
  return out;
}
