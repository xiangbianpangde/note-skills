import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("pi package manifest points to existing extension and skill", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    keywords: string[];
    pi: { extensions: string[]; skills: string[] };
  };
  assert.ok(manifest.keywords.includes("pi-package"));
  for (const relative of manifest.pi.extensions) assert.ok(fs.existsSync(path.resolve(root, relative)));
  for (const relative of manifest.pi.skills) assert.ok(fs.existsSync(path.resolve(root, relative)));
  assert.ok(fs.existsSync(path.join(root, "skills", "project-memory", "SKILL.md")));
});
