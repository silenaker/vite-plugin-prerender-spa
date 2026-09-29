import { afterAll, describe, expect, it } from "vitest";

import {
  check,
  cleanupWorkspaces,
  observe,
  readExpected,
  writeExpected,
  type Expected,
  type Observed,
  type ObservedPage,
  type Scenario,
} from "./pipeline.ts";
import { groups } from "./scenarios.ts";

const UPDATE = process.env["UPDATE_EXPECTED"] === "1";

afterAll(async () => {
  if (process.env["KEEP_TMP"] !== "1") await cleanupWorkspaces();
});

function report(violations: string[]): string {
  return violations.length === 0 ? "" : `\n${violations.map((line) => `• ${line}`).join("\n")}\n`;
}

async function verify(scenario: Scenario): Promise<void> {
  const observed = await observe(scenario);
  if (UPDATE) {
    const written = await writeExpected(scenario, observed);
    process.stdout.write(`wrote ${written.length} file(s) for ${scenario.name}\n`);
    return;
  }
  expect(report(check(observed, await readExpected(scenario)))).toBe("");
}

for (const group of groups) {
  describe(group.name, () => {
    for (const scenario of group.scenarios) it(scenario.name, () => verify(scenario));
  });
}

/* -------------------------------------------------------------------------- */
/*                                 self-check                                 */
/* -------------------------------------------------------------------------- */

describe("self-check: the comparison detects a difference", () => {
  function page(file: string, mounted: string): ObservedPage {
    return {
      file,
      content: [
        "<!doctype html>",
        '<html lang="en">',
        "  <head>",
        '    <link rel="modulepreload" crossorigin href="/assets/app.js">',
        "  </head>",
        "  <body>",
        '    <div id="root">',
        `      ${mounted}`,
        "    </div>",
        "  </body>",
        "</html>",
        "",
      ].join("\n"),
    };
  }

  const observed: Observed = {
    appDir: "/app",
    build: { failed: false, error: "" },
    pages: [page("index.html", "home"), page("about.html", "about")],
  };

  function expectedFrom(observation: Observed): Expected {
    return {
      buildFails: false,
      pages: new Map(observation.pages.map((item) => [item.file, item.content])),
    };
  }

  function withFault(mutate: (observation: Observed) => void): string {
    const copy = structuredClone(observed);
    mutate(copy);
    return check(copy, expectedFrom(observed)).join("\n");
  }

  it("reports nothing for an untouched build", () => {
    expect(check(observed, expectedFrom(observed))).toEqual([]);
  });

  it("catches a page the build did not emit", () => {
    const violations = withFault((observation) => {
      observation.pages = observation.pages.filter((item) => item.file !== "about.html");
    });
    expect(violations).toMatch(/missing about\.html/);
  });

  it("catches a page the expectation does not list", () => {
    const violations = withFault((observation) => {
      observation.pages.push(page("extra.html", "extra"));
    });
    expect(violations).toMatch(/emitted extra\.html, which is not expected/);
  });

  it("catches changed HTML, down to the line", () => {
    const violations = withFault((observation) => {
      observation.pages[0]!.content = observation.pages[0]!.content.replace(
        /.*modulepreload.*\n/,
        "",
      );
    });
    expect(violations).toMatch(/differs from the expected HTML/);
    expect(violations).toMatch(/line 4/);
  });

  it("catches a build that should not have failed", () => {
    const violations = check(
      { appDir: observed.appDir, build: { failed: true, error: "boom" }, pages: [] },
      expectedFrom(observed),
    ).join("\n");
    expect(violations).toMatch(/build should have succeeded, but it failed: boom/);
  });
});
