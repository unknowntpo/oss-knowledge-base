/**
 * Spec 019 amendment (7), owner resolution 3 (W103): the Kafka committers page as the truth set of
 * the precision check and as `declared` link evidence. `refresh:committers` reads the page once,
 * rewrites the committed capture and prints the diff; no cron reads the page.
 */
import { activityPersonId } from "./activity";

/** The page itself (`https://kafka.apache.org/committers` answers with a meta refresh to it). */
export const KAFKA_COMMITTERS_URL = "https://kafka.apache.org/community/committers/";

export interface CommitterPairV1 {
  /** The name as the page writes it. */
  readonly name: string;
  /** The GitHub login the page links. */
  readonly login: string;
  /** When this pair entered or last changed in the capture (the refresh PR's date). */
  readonly date: string;
  /** Who reviewed the refresh PR that added or changed the pair. */
  readonly reviewer: string;
}

export interface CommittersCaptureV1 {
  readonly source: string;
  readonly capturedAt: string;
  readonly committers: readonly CommitterPairV1[];
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", "#39": "'", nbsp: " " };

function decode(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&([a-z0-9#]+);/giu, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)
    .replace(/\s+/gu, " ")
    .trim();
}

/** Every card of the page that names a person and links a GitHub profile, in page order. */
export function parseCommittersPage(html: string): readonly { readonly name: string; readonly login: string }[] {
  const pairs: { name: string; login: string }[] = [];
  for (const card of html.split(/class="[^"]*\bcommitter-card\b[^"]*"/u).slice(1)) {
    const name = /<h6\b[^>]*>([\s\S]*?)<\/h6>/u.exec(card)?.[1];
    const login = /href="?https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/?["\s>]/u.exec(card)?.[1];
    if (name === undefined || login === undefined) continue;
    const text = decode(name.replace(/<[^>]*>/gu, ""));
    if (text !== "") pairs.push({ name: text, login });
  }
  return pairs;
}

/**
 * The capture's `declared` pairs: a name that appears twice on the page (or a login linked by two
 * names) gives no entry, as the roster's uniqueness rule.
 */
export function uniqueCommitterPairs<T extends { readonly name: string; readonly login: string }>(pairs: readonly T[]): readonly T[] {
  const names = new Map<string, number>();
  const logins = new Map<string, number>();
  for (const pair of pairs) {
    const name = activityPersonId("mail", pair.name) ?? "";
    names.set(name, (names.get(name) ?? 0) + 1);
    logins.set(pair.login.toLowerCase(), (logins.get(pair.login.toLowerCase()) ?? 0) + 1);
  }
  return pairs.filter((pair) => {
    const name = activityPersonId("mail", pair.name);
    return name !== undefined && names.get(name) === 1 && logins.get(pair.login.toLowerCase()) === 1;
  });
}

export interface CommittersDiff {
  readonly added: readonly CommitterPairV1[];
  readonly removed: readonly CommitterPairV1[];
  /** Same login, another name (or the reverse): the new pair, with the old name or login. */
  readonly changed: readonly { readonly before: CommitterPairV1; readonly after: CommitterPairV1 }[];
  readonly capture: CommittersCaptureV1;
}

/**
 * The new capture from a fresh page read. Unchanged pairs keep their date and reviewer; added and
 * changed pairs take `date` and `reviewer` (the refresh PR's); a pair no longer on the page is
 * deleted from the capture (not kept as a removal entry).
 */
export function refreshCommitters(
  previous: CommittersCaptureV1,
  page: readonly { readonly name: string; readonly login: string }[],
  options: { readonly date: string; readonly reviewer: string; readonly source?: string },
): CommittersDiff {
  const before = new Map(previous.committers.map((pair) => [pair.login.toLowerCase(), pair]));
  const beforeByName = new Map(previous.committers.map((pair) => [activityPersonId("mail", pair.name), pair]));
  const added: CommitterPairV1[] = [];
  const changed: { before: CommitterPairV1; after: CommitterPairV1 }[] = [];
  const kept = new Set<CommitterPairV1>();
  const committers: CommitterPairV1[] = [];
  for (const pair of uniqueCommitterPairs(page)) {
    const old = before.get(pair.login.toLowerCase()) ?? beforeByName.get(activityPersonId("mail", pair.name));
    if (old !== undefined && old.name === pair.name && old.login === pair.login) {
      kept.add(old);
      committers.push(old);
      continue;
    }
    const next = { name: pair.name, login: pair.login, date: options.date, reviewer: options.reviewer };
    committers.push(next);
    if (old === undefined) added.push(next);
    else {
      kept.add(old);
      changed.push({ before: old, after: next });
    }
  }
  const order = (a: CommitterPairV1, b: CommitterPairV1) => a.login.toLowerCase().localeCompare(b.login.toLowerCase());
  return {
    added: added.sort(order),
    removed: previous.committers.filter((pair) => !kept.has(pair)).sort(order),
    changed: changed.sort((a, b) => order(a.after, b.after)),
    capture: { source: options.source ?? previous.source, capturedAt: options.date, committers: committers.sort(order) },
  };
}

/** The diff as the refresh command prints it for the owner's review. */
export function formatCommittersDiff(diff: CommittersDiff): string {
  const pair = (value: CommitterPairV1) => `github:${value.login} ↔ ${value.name}`;
  return [
    `added ${diff.added.length}, removed ${diff.removed.length}, changed ${diff.changed.length}; ${diff.capture.committers.length} pairs`,
    ...diff.added.map((value) => `+ ${pair(value)}`),
    ...diff.removed.map((value) => `- ${pair(value)}`),
    ...diff.changed.map((value) => `~ ${pair(value.before)} → ${pair(value.after)}`),
  ].join("\n");
}
