// What can be told about a flash image without booting it: size, SoC family
// from the file name or the U-Boot strings in the first megabyte, and the
// SPL header's flash type.
export const MACHINES = {
  t10: 'ingenic-t10', t20: 'ingenic-t20', t21: 'ingenic-t21', t23: 'ingenic-t23',
  t30: 'ingenic-t30', t31: 'ingenic-t31', t32: 'ingenic-t32', t33: 'ingenic-t33',
  t40: 'ingenic-t40', t41: 'ingenic-t41', a1: 'ingenic-a1',
  c100: 'ingenic-t31', cw080: 'ingenic-t32',
};
const SOC = /(t[1-4]\d|a1|c100|cw080)([a-z]*)/;

export function socFromText(text) {
  // Names run brand_model_soc_sensor_wifi and a model can look like a SoC,
  // so the last match wins.
  const words = text.toLowerCase().split(/[_.+\-\s]/);
  let found = null;
  for (const w of words) {
    const m = SOC.exec(w);
    if (m && m[0] === w) found = { family: m[1], variant: m[0] };
  }
  return found;
}

export function describeImage(bytes, name) {
  const info = { size: bytes.length, name, soc: null, variant: '', flash: '?', uboot: '', source: '' };
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, 1 << 20));
  const spl = bytes.length > 8 && bytes[0] === 6 && bytes[1] === 5 && bytes[2] === 4 && bytes[3] === 3;
  if (spl) info.flash = bytes[8] === 0 ? 'SPI NAND' : bytes[8] === 0xaa ? 'SPI NOR' : '?';
  const ub = /U-Boot [^\0\n]{3,60}/.exec(text);
  if (ub) info.uboot = ub[0].trim();
  let hit = socFromText(name || '');
  if (hit) info.source = 'file name';
  if (!hit) {
    const m = /ISVP-(T\d+[A-Z]*)|isvp-(t\d+)/i.exec(text);
    if (m) { hit = socFromText(m[1] || m[2]); info.source = 'U-Boot strings'; }
  }
  if (hit) { info.soc = hit.family; info.variant = hit.variant; }
  return info;
}

export const fmtBytes = (n) =>
  n >= 1 << 20 ? (n / (1 << 20)).toFixed(n % (1 << 20) ? 2 : 0) + ' MiB' : (n / 1024).toFixed(1) + ' KiB';
