import * as fs from "fs";
import * as path from "path";

const FORBIDDEN = [
  /solar-harness/i,
  /\.solar\/harness/i,
  /\/Users\/[^/]+\/Solar\/harness/i,
  /run_(?:github|hf|youtube|ai_influence)/i,
];

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      out.push(...sourceFiles(full));
    } else if (/\.(?:ts|json|md)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("GenesisPod insight runtime independence", () => {
  it("does not import or invoke solar-harness runtime services", () => {
    const srcRoot = path.resolve(__dirname, "../../..");
    const repoRoot = path.resolve(srcRoot, "../..");
    const targets = [
      path.join(srcRoot, "modules/ai-app/radar"),
      path.join(srcRoot, "modules/ai-app/insight"),
      path.join(srcRoot, "modules/ai-engine/content/fetch"),
      path.join(repoRoot, "frontend/app/ai-insights"),
      path.join(repoRoot, "frontend/services/ai-radar"),
    ];
    const violations: string[] = [];
    for (const target of targets) {
      for (const file of sourceFiles(target)) {
        const content = fs.readFileSync(file, "utf8");
        for (const pattern of FORBIDDEN) {
          if (pattern.test(content)) {
            violations.push(`${path.relative(repoRoot, file)} -> ${pattern}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
