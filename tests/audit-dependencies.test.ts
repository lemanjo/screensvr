import { describe, expect, it } from "vitest";
import {
  assessAudit,
  exception,
} from "../.github/scripts/audit-dependencies.js";

const now = Date.parse("2026-11-17T18:00:00Z");
const fixture = () => ({
  auditReportVersion: 2,
  vulnerabilities: {
    picomatch: {
      name: "picomatch",
      severity: "high",
      nodes: ["node_modules/picomatch"],
      via: [
        {
          name: "picomatch",
          dependency: "picomatch",
          severity: "high",
          url: exception.advisory as string,
        },
      ],
    },
    tinyglobby: {
      name: "tinyglobby",
      severity: "high",
      nodes: ["node_modules/tinyglobby"],
      via: ["picomatch"],
    },
  },
});
const lock = () => ({
  packages: {
    "node_modules/picomatch": { version: "4.0.7", dev: true },
    "node_modules/tinyglobby": { version: "0.2.15", dev: true },
  },
});

describe("temporary development-only npm audit exception", () => {
  it("accepts only the named advisory and its transitive metadata in development", () => {
    expect(assessAudit(fixture(), lock(), "development", now)).toEqual({
      accepted: ["picomatch", "tinyglobby"],
      blocked: [],
    });
  });
  it("never accepts the same findings in production", () => {
    expect(assessAudit(fixture(), lock(), "production", now).blocked).toEqual([
      "picomatch",
      "tinyglobby",
    ]);
  });
  it("checks lockfile dev flags instead of trusting audit classification", () => {
    const packages = lock();
    packages.packages["node_modules/picomatch"].dev = false;
    expect(
      assessAudit(fixture(), packages, "development", now).blocked,
    ).toHaveLength(2);
    expect(assessAudit(fixture(), packages, "tooling", now).blocked).toEqual(
      [],
    );
  });
  it("expires automatically and does not accept other picomatch versions", () => {
    expect(
      assessAudit(
        fixture(),
        lock(),
        "development",
        Date.parse(exception.expires),
      ).blocked,
    ).toHaveLength(2);
    const packages = lock();
    packages.packages["node_modules/picomatch"].version = "4.0.6";
    expect(
      assessAudit(fixture(), packages, "development", now).blocked,
    ).toHaveLength(2);
    expect(
      assessAudit(fixture(), lock(), "development", NaN).blocked,
    ).toHaveLength(2);
  });
  it("blocks unrelated advisories, including additional advisories on picomatch", () => {
    const report = fixture();
    report.vulnerabilities.picomatch.via.push({
      name: "picomatch",
      dependency: "picomatch",
      severity: "high",
      url: "https://github.com/advisories/GHSA-other",
    });
    expect(
      assessAudit(report, lock(), "development", now).blocked,
    ).toHaveLength(2);
  });
  it("blocks missing dependency evidence and cycles rather than assuming acceptance", () => {
    const report = fixture();
    report.vulnerabilities.tinyglobby.via.push("missing-package");
    expect(assessAudit(report, lock(), "development", now).blocked).toContain(
      "tinyglobby",
    );
    report.vulnerabilities.tinyglobby.via = ["tinyglobby"];
    expect(assessAudit(report, lock(), "development", now).blocked).toContain(
      "tinyglobby",
    );
  });
  it("allows peer dependency cycles only when all advisory leaves are approved", () => {
    const report = fixture();
    report.vulnerabilities.tinyglobby.via.push("tinyglobby");
    expect(assessAudit(report, lock(), "development", now).blocked).toEqual([]);
    report.vulnerabilities.picomatch.severity = "critical";
    expect(
      assessAudit(report, lock(), "development", now).blocked,
    ).toHaveLength(2);
  });
  it("fails closed on audit errors, unsupported formats, and malformed findings", () => {
    expect(() =>
      assessAudit(
        { ...fixture(), error: { code: "ENETUNREACH" } },
        lock(),
        "development",
        now,
      ),
    ).toThrow();
    expect(() =>
      assessAudit(
        { ...fixture(), auditReportVersion: 1 },
        lock(),
        "development",
        now,
      ),
    ).toThrow();
    const report = fixture();
    report.vulnerabilities.picomatch.severity = "unknown";
    expect(() => assessAudit(report, lock(), "development", now)).toThrow();
  });
});
