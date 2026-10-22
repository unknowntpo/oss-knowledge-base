<script setup lang="ts">
/**
 * Spec 019 amendment (7): `[data-section="kips"]`, the KIPs of the identity or of an identity the
 * link table joins to it (W74, W96, W111). One quiet line per KIP: the label of the first basis
 * that holds and the others as "also …" (W94), the link path with its basis and evidence, the page's
 * author list (linked names only by W95's two rules), the Jira issues and the dev@ discussion.
 * Shown only when the response carries `kips` (`PEOPLE_KIPS`).
 */
import type { KipFactV1, KipLinkStepV1, PersonKipsV1 } from "@oss-knowledge-base/reference-pipeline/people";

import { useI18n } from "../i18n";

const props = defineProps<{ readonly kips: PersonKipsV1; readonly projectKey: string }>();
const { t } = useI18n();
const EVIDENCE_SHOWN = 5;

const day = (iso: string) => iso.slice(0, 10);
const personLink = (id: string) => `/${props.projectKey}/people/${encodeURIComponent(id)}`;

function factText(fact: KipFactV1, also: boolean): string {
  const prefix = also ? "also" : "label";
  if (fact.basis === "assignee") return t(`people.kips.${prefix}.assignee`, { issues: fact.issues.join(", ") });
  return t(`people.kips.${prefix}.${fact.basis}`);
}
function stepText(step: KipLinkStepV1): string {
  return t("people.kips.via", { source: t(`people.kips.source.${step.to.source}`), name: step.to.display, basis: t(`people.kips.basis.${step.basis}`) });
}
function evidenceText(id: string): string {
  if (id === "declared") return t("people.kips.evidence.declared");
  if (id === "roster") return t("people.kips.evidence.roster");
  return id;
}
function startsNote(): string | undefined {
  const { startersFrom, startsKnownFrom } = props.kips;
  if (startsKnownFrom === null) return t("people.kips.how.noStarts");
  if (startersFrom !== null && day(startsKnownFrom) > day(startersFrom)) return t("people.kips.how.startsKnown", { date: day(startsKnownFrom) });
  return undefined;
}
</script>

<template>
  <section class="person-section person-kips-section" data-section="kips">
    <h2 class="section-heading">{{ t("people.section.kips") }}</h2>
    <p v-if="kips.lines.length === 0" class="person-note" data-kips-empty>{{ t("people.kips.none") }}</p>
    <ol v-else class="person-kips">
      <li v-for="(line, lineIndex) in kips.lines" :key="`${line.kip}:${lineIndex}`" class="person-kip" :data-kip="line.kip">
        <p class="person-kip-head">
          <a v-if="line.pageUrl" class="person-kip-id" :href="line.pageUrl" target="_blank" rel="noopener noreferrer" data-kip-page>{{ line.kip }}</a>
          <span v-else class="person-kip-id">{{ line.kip }}</span>
          <span class="person-kip-title">{{ line.title }}</span>
        </p>
        <p class="person-kip-basis" :data-basis="line.facts[0]!.basis">
          <span class="person-kip-label">{{ factText(line.facts[0]!, false) }}</span>
          <span v-for="(fact, index) in line.facts.slice(1)" :key="`${fact.basis}:${index}`" class="person-detail" :data-also="fact.basis">· {{ factText(fact, true) }}</span>
        </p>
        <template v-for="(fact, factIndex) in line.facts" :key="`via:${fact.basis}:${factIndex}`">
          <p v-for="(step, index) in fact.via ?? []" :key="index" class="person-kip-via" :data-via="step.basis">{{ stepText(step) }}<template v-for="(item, position) in step.evidence.slice(0, EVIDENCE_SHOWN)" :key="position">{{ position > 0 ? ", " : "" }}<a :href="item.url" target="_blank" rel="noopener noreferrer" data-evidence>{{ evidenceText(item.id) }}</a></template><template v-if="step.evidence.length > EVIDENCE_SHOWN">{{ " " + t("people.kips.more", { count: step.evidence.length - EVIDENCE_SHOWN }) }}</template></p>
        </template>
        <p v-if="line.authors" class="person-kip-authors" data-authors>
          <span class="person-kip-key">{{ t("people.kips.authors") }}</span><template v-for="(author, index) in line.authors" :key="index">{{ index > 0 ? ", " : "" }}<RouterLink v-if="author.person" :to="personLink(author.person.id)" :data-rule="author.person.rule">{{ author.name }}</RouterLink><span v-else>{{ author.name }}</span><span v-if="author.person" class="person-kip-rule">{{ ` (${t(`people.kips.rule.${author.person.rule}`)})` }}</span></template>
        </p>
        <p v-if="line.issues && line.issues.length > 0" class="person-kip-issues" data-issues>
          <span class="person-kip-key">{{ t("people.kips.jira") }}</span><template v-for="(issue, index) in line.issues" :key="index">{{ index > 0 ? ", " : "" }}<a :href="issue.url" target="_blank" rel="noopener noreferrer">{{ issue.key }}</a><span class="person-kip-rule">{{ ` (${issue.assignee ?? t("people.kips.unassigned")})` }}</span></template>
        </p>
        <p v-if="line.discussion" class="person-kip-thread" data-discussion>
          <a :href="line.discussion.url" target="_blank" rel="noopener noreferrer">{{ t("people.kips.discussion") }}</a>{{ " " }}<span class="person-kip-rule">{{ t("people.kips.startedBy", { name: line.discussion.starter, date: day(line.discussion.at) }) }}</span>
        </p>
      </li>
    </ol>
    <ul class="person-kips-notes" data-kips-how>
      <li>{{ t("people.kips.how.definition") }}</li>
      <li v-if="kips.startersFrom">{{ t("people.kips.how.starters", { from: day(kips.startersFrom), date: day(kips.startersFrom) }) }}</li>
      <li v-if="startsNote()" data-starts-known>{{ startsNote() }}</li>
      <li v-if="kips.authorLists.available" data-author-lists>{{ t("people.kips.how.authors", { from: day(kips.authorLists.coverageFrom), read: day(kips.authorLists.generatedAt) }) }}</li>
      <li v-else data-author-lists="unavailable">{{ t("people.kips.how.authorsUnavailable") }}</li>
      <li v-if="kips.links.available" data-links>{{ t("people.kips.how.links", { date: day(kips.links.generatedAt) }) }}</li>
      <li v-else data-links="unavailable">{{ t("people.kips.how.linksUnavailable") }}</li>
    </ul>
  </section>
</template>
