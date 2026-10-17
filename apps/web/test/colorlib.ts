/**
 * Spec 023: colour measurements for the palette tests. WCAG 2.x relative luminance and contrast,
 * and a reader for the custom properties of `apps/web/styles.css`.
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

/** Custom properties declared in the stylesheet's `:root` blocks, by name (`--accent` → raw value). */
export function rootTokens(css: string): Map<string, string> {
  const tokens = new Map<string, string>();
  const clean = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  for (const block of clean.matchAll(/(?:^|[}\s]):root\s*\{([^}]*)\}/gu)) {
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
