/**
 * Spec 027 Amendment (2) L1 rows that need the data publisher Worker's scheduled handler, [pending]
 * until the wiring slice (A2-9 slice 2). The library tick (tick.cases.ts) cannot show that another
 * job of the same handler still runs.
 */
export const testPlanRows = [
  { id: "SRE47", case: "isolation", given: "sre-agent branch throws at each step 0-7 on a tick shared with the publication cron", expected: "publication still scheduled; sreAgent lastRun.status failed with sanitized reason" },
];
