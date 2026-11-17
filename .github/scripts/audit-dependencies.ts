import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Explicitly approved temporary risk acceptance, not a claim that the library
// is patched. Remove when an upstream fix is available; never extend silently.
export const exception = {
  advisory: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
  package: "picomatch",
  version: "4.0.7",
  expires: "2026-12-17T00:00:00.000Z",
} as const;

type Scope = "production" | "development" | "tooling";
type Finding = {
  name: string;
  severity: string;
  nodes: string[];
  via: (
    string | { name: string; dependency: string; url: string; severity: string }
  )[];
};
type Audit = {
  auditReportVersion: number;
  vulnerabilities: Record<string, Finding>;
  error?: unknown;
};
type Lock = {
  packages: Record<string, { version?: string; dev?: boolean }>;
};

export function assessAudit(
  report: Audit,
  lock: Lock,
  scope: Scope,
  now = Date.now(),
) {
  if (
    report.error ||
    report.auditReportVersion !== 2 ||
    !report.vulnerabilities ||
    typeof report.vulnerabilities !== "object" ||
    Array.isArray(report.vulnerabilities) ||
    !lock.packages
  )
    throw new Error("Invalid or failed npm audit report.");
  const approved = (
    name: string,
    path = new Set<string>(),
    evidence = { count: 0 },
  ): boolean => {
    // npm reports cycles between Vitest and its coverage/UI peers. A back-edge
    // supplies no evidence itself; the outer walk must still reach the exact
    // accepted advisory, and every other reachable advisory must also match.
    if (path.has(name)) return true;
    const finding = report.vulnerabilities[name];
    if (
      scope === "production" ||
      now >= Date.parse(exception.expires) ||
      !Number.isFinite(now) ||
      !finding ||
      finding.severity !== "high" ||
      !finding.nodes?.length ||
      !finding.via?.length
    )
      return false;
    if (
      finding.nodes.some(
        (node) =>
          !lock.packages[node] ||
          (scope === "development" && lock.packages[node].dev !== true),
      )
    )
      return false;
    const seen = new Set([...path, name]);
    const valid = finding.via.every((via) => {
      if (typeof via === "string") return approved(via, seen, evidence);
      const accepted =
        finding.name === exception.package &&
        via.name === exception.package &&
        via.dependency === exception.package &&
        via.url === exception.advisory &&
        via.severity === "high" &&
        finding.nodes.every(
          (node) => lock.packages[node].version === exception.version,
        );
      if (accepted) evidence.count++;
      return accepted;
    });
    return valid && (path.size > 0 || evidence.count > 0);
  };
  const blocked: string[] = [];
  const accepted: string[] = [];
  for (const [name, finding] of Object.entries(report.vulnerabilities)) {
    if (
      !finding ||
      finding.name !== name ||
      !Array.isArray(finding.nodes) ||
      !Array.isArray(finding.via) ||
      !["info", "low", "moderate", "high", "critical"].includes(
        finding.severity,
      )
    )
      throw new Error("Malformed npm audit finding.");
    if (["high", "critical"].includes(finding.severity))
      (approved(name) ? accepted : blocked).push(name);
  }
  return { blocked, accepted };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    // The production audit has no exceptions. The other two scopes are fixed;
    // callers cannot relabel application dependencies as container tooling.
    for (const [scope, directory, omit] of [
      ["production", ".", true],
      ["development", ".", false],
      ["tooling", ".devcontainer/tooling", false],
    ] as const) {
      const result = spawnSync(
        "npm",
        [
          "audit",
          "--json",
          "--ignore-scripts",
          "--audit-level=high",
          ...(omit ? ["--omit=dev"] : []),
        ],
        {
          cwd: directory,
          encoding: "utf8",
          timeout: 120000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      if (
        result.error ||
        result.signal ||
        ![0, 1].includes(result.status ?? -1)
      )
        throw new Error(`${scope}: npm audit could not complete.`);
      const report = JSON.parse(result.stdout) as Audit;
      const lock = JSON.parse(
        readFileSync(`${directory}/package-lock.json`, "utf8"),
      ) as Lock;
      const { blocked, accepted } = assessAudit(report, lock, scope);
      if (blocked.length)
        throw new Error(
          `${scope}: unapproved high/critical findings: ${blocked.join(", ")}.`,
        );
      if (accepted.length)
        console.warn(
          `${scope}: temporary acceptance of ${exception.advisory} (${accepted.join(", ")}); expires ${exception.expires}.`,
        );
      console.log(`${scope}: audit policy passed.`);
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
