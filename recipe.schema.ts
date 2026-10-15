/**
 * recipe.schema.ts — Zod schema + inferred TypeScript types for a single
 * Nextcloud Cookbook recipe as consumed by the cookbook-card.
 *
 * This is the machine-readable counterpart to RECIPE_SCHEMA.md (prose docs).
 * It is TOOLING ONLY — the card itself is plain Vanilla JS and does not import
 * this file. Run the validator with `npm run validate` (uses tsx).
 *
 * Design notes:
 * - The Cookbook API is permissive and returns many passthrough fields with
 *   inconsistent shapes. We validate the fields the card relies on strictly and
 *   allow unknown extra keys (`.loose()`) so real API payloads still pass.
 * - Every field's optionality/nullability mirrors the observed live data
 *   (see RECIPE_SCHEMA.md field-presence table).
 */
import { z } from "zod";

/**
 * One structured ingredient inside a grouped instruction step.
 * All four values are always strings; missing values are "".
 */
export const IngredientSchema = z.object({
  /** Ingredient name, without amount/unit and without the first (...) note. */
  name: z.string(),
  /** Leading quantity: number, range ("1-2") or "ca. 5". "" if none. */
  amount: z.string(),
  /** Recognised cooking unit only (g, ml, EL, Dose(n), …). "" otherwise. */
  unit: z.string(),
  /** First balanced (...) group from the source line, parens stripped. "" if none. */
  note: z.string(),
});

/**
 * One preparation step paired with the ingredients used in it.
 * `instruction` equals the matching `recipeInstructions[i]` entry.
 * Hint/note steps carry an empty `ingredients` array.
 */
export const InstructionSchema = z.object({
  ingredients: z.array(IngredientSchema),
  instruction: z.string(),
});

/**
 * schema.org NutritionInformation — always present, values sparse.
 * Numeric fields are usually strings but occasionally plain numbers in the API
 * (e.g. `calories`), so we accept `string | number`.
 */
const NutritionValue = z.union([z.string(), z.number()]);

export const NutritionSchema = z
  .object({
    "@type": z.string().optional(),
    servingSize: z.string().optional(),
    calories: NutritionValue.optional(),
    carbohydrateContent: NutritionValue.optional(),
    proteinContent: NutritionValue.optional(),
    fatContent: NutritionValue.optional(),
    saturatedFatContent: NutritionValue.optional(),
    sugarContent: NutritionValue.optional(),
    cholesterolContent: NutritionValue.optional(),
  })
  .loose();

/**
 * A full recipe. Extra/unknown keys are allowed (Cookbook passthrough fields
 * such as author, aggregateRating, publisher, review, video, comment, …).
 */
export const RecipeSchema = z
  .object({
    // --- Core (always present) ---
    id: z.string(),
    name: z.string(),
    description: z.string(),
    "@context": z.string(),
    "@type": z.string(),
    recipeCategory: z.string(),
    /** Comma-separated string, NOT an array. */
    keywords: z.string(),
    recipeYield: z.number().int().nullable(),
    recipeInstructions: z.array(InstructionSchema),
    nutrition: NutritionSchema,
    tool: z.array(z.string()),
    image: z.string(),
    url: z.string(),
    dateCreated: z.string(),
    dateModified: z.string(),
    datePublished: z.string().nullable(),
    prepTime: z.string().nullable(),
    cookTime: z.string().nullable(),
    totalTime: z.string().nullable(),

    // --- Home Assistant custom fields (written back by the card) ---
    _ha_rating: z.number().int().optional(),
    _ha_last_cooked: z.string().optional(),
    _cookbook_schema_version: z.literal(6),
  })
  .loose();

// --- Inferred TypeScript types ------------------------------------------------
export type Ingredient = z.infer<typeof IngredientSchema>;
export type Instruction = z.infer<typeof InstructionSchema>;
export type Nutrition = z.infer<typeof NutritionSchema>;
export type Recipe = z.infer<typeof RecipeSchema>;

/**
 * Cross-field invariants that a plain shape check cannot express.
 * Returns a list of human-readable problems (empty = valid).
 *
 * - every instruction has a string and structured ingredient list
 */
export function checkRecipeInvariants(recipe: Recipe): string[] {
  const problems: string[] = [];
  recipe.recipeInstructions.forEach((step, index) => {
    if (step.instruction.trim() === "") problems.push(`step ${index}: instruction is empty`);
  });

  return problems;
}
