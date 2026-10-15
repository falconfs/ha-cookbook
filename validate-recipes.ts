/**
 * validate-recipes.ts — Validate downloaded recipe JSON files against the Zod
 * RecipeSchema and the cross-field invariants.
 *
 * Usage:
 *   npm run validate                 # defaults to ../../cookbook_v6
 *   tsx validate-recipes.ts <dir>    # validate a custom directory
 *
 * Exit code is non-zero if any recipe fails, so this can gate CI or a script.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RecipeSchema, checkRecipeInvariants } from "./recipe.schema.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const targetDir = resolve(here, process.argv[2] ?? "../../recipes-export");

const files = readdirSync(targetDir)
  .filter((f) => f !== "_index.json")
  .map((f) => join(f, "recipe.json"))
  .filter((f) => f.endsWith("/recipe.json"))
  .sort();

if (files.length === 0) {
  console.error(`No recipe directories found in ${targetDir}`);
  process.exit(1);
}

let valid = 0;
const failures: { file: string; issues: string[] }[] = [];

for (const file of files) {
  const path = join(targetDir, file);
  const issues: string[] = [];

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    failures.push({ file, issues: [`invalid JSON: ${(err as Error).message}`] });
    continue;
  }

  const parsed = RecipeSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push(`${issue.path.join(".") || "<root>"}: ${issue.message}`);
    }
    failures.push({ file, issues });
    continue;
  }

  const invariantProblems = checkRecipeInvariants(parsed.data);
  if (invariantProblems.length > 0) {
    failures.push({ file, issues: invariantProblems });
    continue;
  }

  valid += 1;
}

console.log(`\nValidated ${files.length} recipe(s) in ${targetDir}`);
console.log(`  valid:   ${valid}`);
console.log(`  invalid: ${failures.length}`);

if (failures.length > 0) {
  console.log("\nFailures:");
  for (const { file, issues } of failures) {
    console.log(`\n  ${file}`);
    for (const issue of issues) {
      console.log(`    - ${issue}`);
    }
  }
  process.exit(1);
}

console.log("\nAll recipes valid.");
