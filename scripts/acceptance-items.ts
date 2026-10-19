/**
 * The acceptance items of a spec marked `Traceability: enforced`: the bullets `- <ID>: [tag]?` of its
 * `## Acceptance` section. Shared by the traceability gate and the feature-map site (Spec 020 B22),
 * so both count the same items. No Bun API: the site's generator also typechecks without Bun types.
 */
export interface AcceptanceItem {
  readonly spec: string;
  readonly id: string;
  readonly tag?: "deploy" | "measure" | "pending";
}

export function acceptanceItems(spec: string, markdown: string): readonly AcceptanceItem[] {
  if (!/^Traceability:\s*enforced\s*$/mu.test(markdown)) return [];
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => /^## Acceptance\s*$/u.test(line));
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && /^## /u.test(line));
  const section = lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
  return [...section.matchAll(/^- ([A-Z]+\d+):\s*(\[(deploy|measure|pending)\])?/gmu)].map((match) => ({
    spec,
    id: match[1]!,
    ...(match[3] === undefined ? {} : { tag: match[3] as "deploy" | "measure" | "pending" }),
  }));
}

