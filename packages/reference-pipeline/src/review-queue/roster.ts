/**
 * Spec 015 Behavior 22–23: rosters behind a swappable adapter, and exact name matching.
 * Only ids, names, and roles of one project are kept.
 */
import type { BindingRole, RosterAdapterId } from "./governance";

export interface RosterEntry {
  readonly id: string;
  readonly name: string | null;
  readonly roles: readonly BindingRole[];
}

export interface Roster {
  readonly adapter: RosterAdapterId;
  readonly project: string;
  readonly fetchedAt: string;
  readonly entries: readonly RosterEntry[];
}

/** A roster response that cannot be trusted; callers fall back to declared markers (Q29, Q55). */
export class RosterError extends Error {}

/** Behavior 22: the adapter names its sources and parses them; fetching and caching belong to the job. */
export interface RosterAdapter {
  readonly id: RosterAdapterId;
  sources(project: string): readonly string[];
  parse(bodies: readonly unknown[], project: string, fetchedAt: string): Roster;
}

export const ASF_LDAP_PROJECTS_URL = "https://whimsy.apache.org/public/public_ldap_projects.json";
export const ASF_LDAP_PEOPLE_URL = "https://whimsy.apache.org/public/public_ldap_people.json";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function ids(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value as string[] : undefined;
}

/** ASF LDAP: `members` are committers; an `owners` id (PMC) is a committer too, even if missing from `members`. */
export function parseAsfRoster(projectsJson: unknown, peopleJson: unknown, project: string, fetchedAt: string): Roster {
  const group = record(record(record(projectsJson)?.projects)?.[project]);
  if (group === undefined) throw new RosterError(`ASF roster has no project ${project}`);
  const members = ids(group.members);
  if (members === undefined) throw new RosterError(`ASF roster project ${project} has no members`);
  const owners = new Set(ids(group.owners) ?? []);
  const all = new Set([...members, ...owners]);
  const people = record(record(peopleJson)?.people);
  if (people === undefined) throw new RosterError("ASF people file has no people");
  const entries = [...all].sort().map((id): RosterEntry => {
    const name = record(people[id])?.name;
    return { id, name: typeof name === "string" && name.trim() !== "" ? name : null, roles: owners.has(id) ? ["committer", "pmc"] : ["committer"] };
  });
  return { adapter: "asf", project, fetchedAt, entries };
}

export const asfRosterAdapter: RosterAdapter = {
  id: "asf",
  sources: () => [ASF_LDAP_PROJECTS_URL, ASF_LDAP_PEOPLE_URL],
  parse: (bodies, project, fetchedAt) => parseAsfRoster(bodies[0], bodies[1], project, fetchedAt),
};

/** Behavior 23: NFC, trimmed, quote characters removed as `mailAuthor` does; no case folding. */
export function nameKey(name: string): string {
  return name.normalize("NFC").replace(/["']/gu, "").trim();
}

export function matchesRosterName(roster: Roster, name: string, role: BindingRole): boolean {
  const key = nameKey(name);
  if (key === "") return false;
  return roster.entries.some((entry) => entry.name !== null && entry.roles.includes(role) && nameKey(entry.name) === key);
}
