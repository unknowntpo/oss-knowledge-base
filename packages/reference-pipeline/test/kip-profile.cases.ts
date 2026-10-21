/**
 * Spec 019 amendment (7) test plan, the profile page (`PEOPLE_KIPS`, slice C): the section
 * `[data-section="kips"]`, its notes, and the reads it adds. Run by `apps/web/test/people-kips.test.ts`.
 */
export const testPlanRows = [
  { id: "W74", case: "own KIPs on a dev@ page", data: "recorded", input: "PEOPLE_KIPS=true; mail:arnab nandy", expected: "[data-section=kips] lists KIP-1381 and KIP-1382 with titles, 2026-10-16 and thread links" },
  { id: "W74", case: "linked KIPs on a GitHub page", data: "constructed", input: "PEOPLE_KIPS=true; github:x corroborated to mail:x", expected: "KIPs of mail:x with basis corroborated and the evidence links" },
  { id: "W74", case: "a starter-only line's title", data: "constructed", input: "no KIP page; subjects \"[DISCUSS] KIP-9201: First title\", \"DISCUSS: KIP-9202 - Second title\", \"[discuss] KIP-9203：Third title\"", expected: "titles \"First title\", \"Second title\", \"Third title\"" },
  { id: "W74", case: "flag off", data: "constructed", input: "PEOPLE_KIPS unset", expected: "no kips section; links.json not read" },
  { id: "W75", case: "the note", data: "constructed", input: "coverageFrom 2026-09-10, table generatedAt 2026-10-22T02:17Z", expected: "definition, \"KIPs started before 2026-09-10 are not listed\", links computed 2026-10-22" },
  { id: "W80", case: "link table missing or corrupt", data: "constructed", input: "links.json absent / not JSON", expected: "200; own KIPs listed; \"links not available\"" },
  { id: "W83", case: "rows written before the flag", data: "constructed", input: "month with dev@ rows and no opens field", expected: "no starter from them; note states the start" },
  { id: "W87", case: "profile reads", data: "constructed", input: "cold, then within 10 min", expected: "at most 28 reads (links.json and authors.json), then 0" },
];
