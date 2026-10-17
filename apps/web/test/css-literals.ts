/**
 * Spec 023 DS10: finds colour literals that bypass the tokens of `apps/web/styles.css`: in a
 * stylesheet outside its `:root` blocks, in a Vue `<style>` block or `style`/`fill`/`stroke`
 * attribute, in `index.html`, and as a hex or colour-function string in TypeScript.
 */

/** The CSS named colours (CSS Color 4), except `transparent` and `currentcolor`, which are not palette colours. */
export const NAMED_COLOURS = [
  "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque", "black", "blanchedalmond", "blue",
  "blueviolet", "brown", "burlywood", "cadetblue", "chartreuse", "chocolate", "coral", "cornflowerblue", "cornsilk",
  "crimson", "cyan", "darkblue", "darkcyan", "darkgoldenrod", "darkgray", "darkgreen", "darkgrey", "darkkhaki",
  "darkmagenta", "darkolivegreen", "darkorange", "darkorchid", "darkred", "darksalmon", "darkseagreen",
  "darkslateblue", "darkslategray", "darkslategrey", "darkturquoise", "darkviolet", "deeppink", "deepskyblue",
  "dimgray", "dimgrey", "dodgerblue", "firebrick", "floralwhite", "forestgreen", "fuchsia", "gainsboro",
  "ghostwhite", "gold", "goldenrod", "gray", "green", "greenyellow", "grey", "honeydew", "hotpink", "indianred",
  "indigo", "ivory", "khaki", "lavender", "lavenderblush", "lawngreen", "lemonchiffon", "lightblue", "lightcoral",
  "lightcyan", "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey", "lightpink", "lightsalmon",
  "lightseagreen", "lightskyblue", "lightslategray", "lightslategrey", "lightsteelblue", "lightyellow", "lime",
  "limegreen", "linen", "magenta", "maroon", "mediumaquamarine", "mediumblue", "mediumorchid", "mediumpurple",
  "mediumseagreen", "mediumslateblue", "mediumspringgreen", "mediumturquoise", "mediumvioletred", "midnightblue",
  "mintcream", "mistyrose", "moccasin", "navajowhite", "navy", "oldlace", "olive", "olivedrab", "orange",
  "orangered", "orchid", "palegoldenrod", "palegreen", "paleturquoise", "palevioletred", "papayawhip", "peachpuff",
  "peru", "pink", "plum", "powderblue", "purple", "rebeccapurple", "red", "rosybrown", "royalblue", "saddlebrown",
  "salmon", "sandybrown", "seagreen", "seashell", "sienna", "silver", "skyblue", "slateblue", "slategray",
  "slategrey", "snow", "springgreen", "steelblue", "tan", "teal", "thistle", "tomato", "turquoise", "violet",
  "wheat", "white", "whitesmoke", "yellow", "yellowgreen",
] as const;

/** Hex colours and colour functions anywhere in a value (`color-mix()` mixes tokens and is allowed). */
const COLOUR_VALUE = /#[0-9a-f]{3,8}(?![\w-])|(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/iu;
/** Named colours count only in properties that take a colour, so `white-space` or a font name never matches. */
const COLOUR_PROPERTY = /^(?:color|background(?:-color)?|border(?:-[a-z]+)*|outline(?:-color)?|fill|stroke|box-shadow|text-shadow|text-decoration(?:-color)?|caret-color|accent-color|column-rule(?:-color)?)$/u;
const NAMED = new RegExp(`(?<![\\w-])(?:${NAMED_COLOURS.join("|")})(?![\\w-])`, "iu");

function hasLiteral(property: string, value: string): boolean {
  return COLOUR_VALUE.test(value) || (COLOUR_PROPERTY.test(property.toLowerCase()) && NAMED.test(value));
}

/** Declarations (`property: value`) that hold a colour literal. */
export function literalDeclarations(declarations: string): string[] {
  return declarations.split(";").map((part) => part.trim())
    .filter((part) => part.includes(":") && hasLiteral(part.slice(0, part.indexOf(":")).trim(), part.slice(part.indexOf(":") + 1)));
}

/** Rules outside `:root` blocks with a colour literal, as `selector { declaration }`. */
export function literalsIn(css: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .map((m) => [m[1]!.trim(), m[2]!] as const)
    .filter(([selector]) => !selector.startsWith(":root"))
    .flatMap(([selector, body]) => literalDeclarations(body).map((declaration) => `${selector} { ${declaration} }`));
}

/** Literals in markup (a `.vue` file or `index.html`): `<style>` blocks, `style` attributes, `fill`/`stroke` attributes. */
export function literalsInMarkup(markup: string): string[] {
  const found: string[] = [];
  for (const block of markup.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/giu)) found.push(...literalsIn(block[1]!));
  for (const attribute of markup.matchAll(/(?<![\w:-])style="([^"]*)"/gu)) found.push(...literalDeclarations(attribute[1]!).map((d) => `style="${d}"`));
  for (const attribute of markup.matchAll(/(?<![\w:-])(fill|stroke|color)="([^"]*)"/giu)) {
    if (hasLiteral(attribute[1]!, attribute[2]!)) found.push(`${attribute[1]}="${attribute[2]}"`);
  }
  return found;
}

/** Hex colour strings and colour-function strings in TypeScript (or a `.vue` script), e.g. `["#3a53b0"]`. */
export function colourStringsIn(source: string): string[] {
  return [...source.matchAll(/(["'`])(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|[^"'`\n]*(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^"'`\n]*)\1/giu)]
    .map((m) => m[0]);
}
