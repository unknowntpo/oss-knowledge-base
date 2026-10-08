/** Spec 014 Behavior 4–5: proposal keys, stages, and rows, all from titles and subjects. */
import type { DigestProfile, ProposalRow, Thread } from "./types";

function keys(text: string, pattern: string): string[] {
  return [...new Set(text.match(new RegExp(pattern, "gu")) ?? [])].sort();
}

export function proposalKeys(title: string, profile: Pick<DigestProfile, "proposal">): string[] {
  return keys(title, profile.proposal.keyPattern);
}

export function issueKeys(title: string, profile: DigestProfile): string[] {
  return keys(title, profile.proposal.issueKeyPattern);
}

function isPullRequest(thread: Thread): boolean {
  return thread.source === "github" && thread.displayId.includes("-PR-");
}

/** A dev@ subject tag such as `[VOTE]`, case-insensitive (shared with Spec 015). */
export function subjectHasTag(title: string, tag: string): boolean {
  return title.toLowerCase().includes(`[${tag.toLowerCase()}]`);
}

function hasSubjectTag(thread: Thread, tag: string): boolean {
  return thread.source === "mail" && subjectHasTag(thread.title, tag);
}

interface Accumulator {
  readonly stages: Set<string>;
  readonly cites: Set<string>;
  newest: string;
}

/** Rows grouped by the first stage present (profile order), newest activity first in a group. */
export function proposalRows(threads: readonly Thread[], profile: DigestProfile): ProposalRow[] {
  if (profile.proposal.kind === null) return [];
  const byKey = new Map<string, Accumulator>();
  const touch = (key: string, thread: Thread): Accumulator => {
    let acc = byKey.get(key);
    if (acc === undefined) byKey.set(key, acc = { stages: new Set(), cites: new Set(), newest: thread.lastActivityAt });
    acc.cites.add(thread.displayId);
    if (Date.parse(thread.lastActivityAt) > Date.parse(acc.newest)) acc.newest = thread.lastActivityAt;
    return acc;
  };
  const prsByIssue = new Map<string, Thread[]>();
  for (const thread of threads.filter(isPullRequest)) {
    for (const issue of issueKeys(thread.title, profile)) prsByIssue.set(issue, [...(prsByIssue.get(issue) ?? []), thread]);
  }
  for (const thread of threads) {
    for (const key of proposalKeys(thread.title, profile)) {
      const acc = touch(key, thread);
      for (const stage of profile.proposal.stages) {
        for (const detect of stage.detect) {
          if (detect.startsWith("subject-tag:") && hasSubjectTag(thread, detect.slice("subject-tag:".length))) acc.stages.add(stage.key);
          if (detect === "pr-title-key" && isPullRequest(thread)) acc.stages.add(stage.key);
          if (detect === "linked-issue-key" && !isPullRequest(thread)) {
            for (const issue of issueKeys(thread.title, profile)) {
              const prs = prsByIssue.get(issue) ?? [];
              if (prs.length === 0) continue;
              acc.stages.add(stage.key);
              for (const pr of prs) touch(key, pr);
            }
          }
        }
      }
    }
  }
  const order = profile.proposal.stages.map((stage) => stage.key);
  const rows: ProposalRow[] = [];
  for (const [key, acc] of byKey) {
    const stages = order.filter((stage) => acc.stages.has(stage));
    if (stages.length === 0) continue;
    rows.push({ key, group: stages[0]!, stages, cites: [...acc.cites].sort(), newestActivityAt: acc.newest, line: null });
  }
  return rows.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group)
    || Date.parse(b.newestActivityAt) - Date.parse(a.newestActivityAt)
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Behavior 5: This week shows at most `limit` rows per stage group, then "+n more". */
export function capGroups(rows: readonly ProposalRow[], limit = 6): { group: string; shown: ProposalRow[]; more: number }[] {
  const groups: { group: string; shown: ProposalRow[]; more: number }[] = [];
  for (const row of rows) {
    let current = groups.find((entry) => entry.group === row.group);
    if (current === undefined) groups.push(current = { group: row.group, shown: [], more: 0 });
    if (current.shown.length < limit) current.shown.push(row);
    else current.more += 1;
  }
  return groups;
}
