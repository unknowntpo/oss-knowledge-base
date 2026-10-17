/**
 * Spec 023: colour measurements for the palette tests: WCAG 2.x relative luminance and contrast,
 * CIELAB and CIEDE2000, colour-vision-deficiency simulation (Machado, Oliveira & Fernandes 2009,
 * severity 1.0, applied in linear RGB), and a reader for the custom properties of
 * `apps/web/styles.css`. Ported from the design audit's `tools/colorlib.py`.
 */

/** `#rgb` or `#rrggbb` to sRGB channels in 0..1. */
export function hexToRgb(hex: string): readonly [number, number, number] {
  let h = hex.trim().replace(/^#/u, "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/iu.test(h)) throw new Error(`not a hex colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as unknown as [number, number, number];
}

const linear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(linear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, 1..21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const delinear = (v: number) => {
  const c = Math.max(0, Math.min(1, v));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
};

export function rgbToHex(rgb: readonly number[]): string {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0")).join("")}`;
}

/** A hex colour, or sRGB channels in 0..1 (a simulated colour keeps its unrounded channels). */
export type Colour = string | readonly number[];
const rgbOf = (colour: Colour) => (typeof colour === "string" ? hexToRgb(colour) : colour);

/** CIELAB (D65) of an sRGB colour. */
export function toLab(colour: Colour): readonly [number, number, number] {
  const [r, g, b] = rgbOf(colour).map(linear) as [number, number, number];
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** LCh (lightness, chroma, hue in degrees) of an sRGB hex colour. */
export function toLch(hex: string): readonly [number, number, number] {
  const [l, a, b] = toLab(hex);
  return [l, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
}

const rad = (deg: number) => (deg * Math.PI) / 180;

/** CIEDE2000 colour difference. */
export function deltaE2000(hex1: Colour, hex2: Colour): number {
  const [l1, a1, b1] = toLab(hex1);
  const [l2, a2, b2] = toLab(hex2);
  const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const [a1p, a2p] = [(1 + g) * a1, (1 + g) * a2];
  const [c1p, c2p] = [Math.hypot(a1p, b1), Math.hypot(a2p, b2)];
  const hue = (b: number, a: number) => ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  const [h1p, h2p] = [hue(b1, a1p), hue(b2, a2p)];
  const dLp = l2 - l1;
  const dCp = c2p - c1p;
  let dhp = 0;
  if (c1p * c2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin(rad(dhp / 2));
  const lBarP = (l1 + l2) / 2;
  const cBarP = (c1p + c2p) / 2;
  let hBarP: number;
  if (c1p * c2p === 0) hBarP = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hBarP = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) hBarP = (h1p + h2p + 360) / 2;
  else hBarP = (h1p + h2p - 360) / 2;
  const t = 1 - 0.17 * Math.cos(rad(hBarP - 30)) + 0.24 * Math.cos(rad(2 * hBarP))
    + 0.32 * Math.cos(rad(3 * hBarP + 6)) - 0.2 * Math.cos(rad(4 * hBarP - 63));
  const dTheta = 30 * Math.exp(-(((hBarP - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(cBarP ** 7 / (cBarP ** 7 + 25 ** 7));
  const sl = 1 + (0.015 * (lBarP - 50) ** 2) / Math.sqrt(20 + (lBarP - 50) ** 2);
  const sc = 1 + 0.045 * cBarP;
  const sh = 1 + 0.015 * cBarP * t;
  const rt = -Math.sin(rad(2 * dTheta)) * rc;
  return Math.sqrt((dLp / sl) ** 2 + (dCp / sc) ** 2 + (dHp / sh) ** 2 + rt * (dCp / sc) * (dHp / sh));
}

export type Vision = "normal" | "protan" | "deutan";

const MACHADO: Record<Exclude<Vision, "normal">, readonly (readonly number[])[]> = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
};

/** The colour as a reader with full protanopia or deuteranopia sees it (`normal`: unchanged). */
export function simulate(hex: string, vision: Vision): readonly number[] {
  if (vision === "normal") return hexToRgb(hex);
  const l = hexToRgb(hex).map(linear);
  return MACHADO[vision].map((row) => delinear(row.reduce((sum, m, j) => sum + m * l[j]!, 0)));
}

/** Custom properties declared in the stylesheet's `:root` blocks, by name (`--accent` → raw value). */
export function rootTokens(css: string): Map<string, string> {
  const tokens = new Map<string, string>();
  const clean = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  for (const block of clean.matchAll(/(?:^|[}\s]):root\s*\{([^}]*)\}/gu)) {
    for (const decl of block[1]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)) tokens.set(decl[1]!, decl[2]!.trim());
  }
  return tokens;
}

/**
 * The tokens of a theme: the `:root` tokens with the ones of `:root[data-theme="<theme>"]`
 * blocks on top. The app sets no theme today (Spec 023 non-goal); dark tokens are defined ahead.
 */
export function themeTokens(css: string, theme: "light" | "dark"): Map<string, string> {
  const tokens = rootTokens(css);
  if (theme === "light") return tokens;
  const clean = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  for (const block of clean.matchAll(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/gu)) {
    for (const decl of block[1]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)) tokens.set(decl[1]!, decl[2]!.trim());
  }
  return tokens;
}

/** A token's value with `var(--x)` aliases followed to a literal. */
export function resolveToken(tokens: ReadonlyMap<string, string>, value: string): string {
  let current = value;
  for (let depth = 0; depth < 10; depth += 1) {
    const alias = /^var\((--[\w-]+)\)$/u.exec(current.trim());
    if (alias === null) return current.trim();
    const next = tokens.get(alias[1]!);
    if (next === undefined) throw new Error(`undefined token ${alias[1]}`);
    current = next;
  }
  throw new Error(`alias loop at ${value}`);
}
