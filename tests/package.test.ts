import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("pi package manifest points to existing extension and skill", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    keywords: string[];
    files: string[];
    pi: { extensions: string[]; skills: string[] };
  };
  assert.ok(manifest.keywords.includes("pi-package"));
  for (const relative of manifest.pi.extensions) assert.ok(fs.existsSync(path.resolve(root, relative)));
  for (const relative of manifest.pi.skills) assert.ok(fs.existsSync(path.resolve(root, relative)));
  assert.ok(fs.existsSync(path.join(root, "skills", "project-memory", "SKILL.md")));
  assert.ok(manifest.files.includes("Project_Memory_Design.md"));
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" }),
  ) as Array<{ files: Array<{ path: string }> }>;
  assert.ok(packed[0]!.files.some((file) => file.path === "Project_Memory_Design.md"));
});
