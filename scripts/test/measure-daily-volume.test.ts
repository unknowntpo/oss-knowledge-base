import { expect, test } from "bun:test";

import { PER_RUN_CAP, volumeLine } from "../measure-daily-volume";

test("measure:daily-volume says whether a window's updates fit one run, on each side of the cap", () => {
  expect(PER_RUN_CAP).toBe(200);
  expect(volumeLine("kafka:jira", 200, 24)).toBe("kafka:jira: 200 updated in 24 h; cap 200 per run; fits one run");
  expect(volumeLine("kafka:jira", 201, 24)).toBe("kafka:jira: 201 updated in 24 h; cap 200 per run; needs 2 runs (1 catch-up)");
  expect(volumeLine("datafusion:github", 438, 168)).toBe("datafusion:github: 438 updated in 168 h; cap 200 per run; needs 3 runs (2 catch-up)");
  expect(volumeLine("kafka:github", 0, 24)).toBe("kafka:github: 0 updated in 24 h; cap 200 per run; fits one run");
});
