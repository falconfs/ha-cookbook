import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { RecipeSchema } from "./recipe.schema.js";

test("accepts a v6 recipe with structured recipeInstructions only", () => {
  const recipe = JSON.parse(
    readFileSync("../../cookbook_v6/1852/recipe.json", "utf-8"),
  );
  const result = RecipeSchema.safeParse(recipe);

  assert.equal(result.success, true);
});

test("rejects legacy flat recipe instructions", () => {
  const result = RecipeSchema.safeParse({
    id: "1",
    name: "Legacy",
    description: "",
    "@context": "http://schema.org",
    "@type": "Recipe",
    recipeCategory: "",
    keywords: "",
    recipeYield: null,
    recipeInstructions: ["Mix"],
    nutrition: { "@type": "NutritionInformation" },
    tool: [],
    image: "",
    url: "",
    dateCreated: "",
    dateModified: "",
    datePublished: null,
    prepTime: null,
    cookTime: null,
    totalTime: null,
    _cookbook_schema_version: 6,
  });

  assert.equal(result.success, false);
});
