const SOURCE_RECIPE = Symbol('sourceRecipe');
const SOURCE_KEYWORDS = Symbol('sourceKeywords');

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
  }
  return value;
}

function textValue(value) {
  return value == null ? '' : String(value);
}

/** Extract a display name from a schema.org author (string, object or array). */
function authorNameFrom(author) {
  if (!author) return '';
  if (typeof author === 'string') return author;
  if (Array.isArray(author)) return authorNameFrom(author[0]);
  if (typeof author === 'object') return textValue(author.name);
  return '';
}

function normalizeKeywords(value) {
  if (Array.isArray(value)) return value.map(textValue);
  return value ? String(value).split(',').map(item => item.trim()).filter(Boolean) : [];
}

export function parseDurationToHms(duration) {
  if (typeof duration !== 'string' || duration === '') return { hours: '', minutes: '' };
  const hours = duration.match(/(\d+)H/)?.[1] ?? '';
  const minutes = duration.match(/(\d+)M/)?.[1] ?? '';
  return { hours, minutes };
}

export function serializeDuration(hours, minutes) {
  const normalizedHours = textValue(hours).trim();
  const normalizedMinutes = textValue(minutes).trim();
  if (!normalizedHours && !normalizedMinutes) return null;
  return `PT${normalizedHours || '0'}H${normalizedMinutes || '0'}M`;
}

export function formStateFromRecipe(recipe, mode = 'edit') {
  const prep = parseDurationToHms(recipe.prepTime);
  const cook = parseDurationToHms(recipe.cookTime);
  const total = parseDurationToHms(recipe.totalTime);
  const state = {
    name: textValue(recipe.name),
    description: textValue(recipe.description),
    recipeCategory: textValue(recipe.recipeCategory),
    keywords: normalizeKeywords(recipe.keywords),
    recipeYield: recipe.recipeYield == null ? '' : textValue(recipe.recipeYield),
    prepHours: prep.hours,
    prepMinutes: prep.minutes,
    cookHours: cook.hours,
    cookMinutes: cook.minutes,
    totalHours: total.hours,
    totalMinutes: total.minutes,
    tool: cloneValue(recipe.tool ?? []),
    nutrition: cloneValue(recipe.nutrition ?? {}),
    image: textValue(recipe.image),
    author: cloneValue(recipe.author),
    authorName: authorNameFrom(recipe.author),
    aggregateRating: cloneValue(recipe.aggregateRating),
    recipeCuisine: cloneValue(recipe.recipeCuisine),
    publisher: cloneValue(recipe.publisher),
    dateCreated: textValue(recipe.dateCreated),
    dateModified: textValue(recipe.dateModified),
    steps: cloneValue(recipe.recipeInstructions ?? []).map(step => ({
      instruction: textValue(step.instruction),
      ingredients: cloneValue(step.ingredients ?? []),
    })),
  };
  if (mode === 'edit') {
    state.haRating = recipe._ha_rating == null ? '' : textValue(recipe._ha_rating);
    state.haLastCooked = textValue(recipe._ha_last_cooked);
  }
  Object.defineProperty(state, SOURCE_RECIPE, { value: cloneValue(recipe), enumerable: false });
  Object.defineProperty(state, SOURCE_KEYWORDS, { value: recipe.keywords, enumerable: false });
  return state;
}

function serializeSteps(steps) {
  return (Array.isArray(steps) ? steps : []).map(step => ({
    ingredients: cloneValue(step.ingredients ?? []),
    instruction: textValue(step.instruction),
  }));
}

function serializeOptionalNumber(value) {
  const normalized = textValue(value).trim();
  return normalized === '' ? undefined : Number(normalized);
}

export function recipeFromFormState(state, mode = 'add') {
  const recipe = cloneValue(state[SOURCE_RECIPE] ?? {});
  const keywords = (Array.isArray(state.keywords) ? state.keywords : []).map(textValue).join(',');
  const sourceKeywords = state[SOURCE_KEYWORDS];
  const keywordsMatchSource = typeof sourceKeywords === 'string'
    && sourceKeywords.split(',').map(item => item.trim()).filter(Boolean).join(',') === keywords;
  const serialized = {
    ...recipe,
    name: textValue(state.name),
    description: textValue(state.description),
    recipeCategory: textValue(state.recipeCategory),
    keywords: keywordsMatchSource ? sourceKeywords : keywords,
    recipeYield: serializeOptionalNumber(state.recipeYield),
    prepTime: serializeDuration(state.prepHours, state.prepMinutes),
    cookTime: serializeDuration(state.cookHours, state.cookMinutes),
    totalTime: serializeDuration(state.totalHours, state.totalMinutes),
    tool: cloneValue(state.tool ?? []),
    nutrition: cloneValue(state.nutrition ?? {}),
    image: textValue(state.image),
    aggregateRating: cloneValue(state.aggregateRating),
    recipeCuisine: cloneValue(state.recipeCuisine),
    publisher: cloneValue(state.publisher),
    recipeInstructions: serializeSteps(state.steps),
  };

  // Author: write the edited name back, preserving the original @type/extra
  // fields when they exist; create a Person when a name is added; drop the
  // field entirely when the name is cleared.
  const authorName = textValue(state.authorName).trim();
  if (authorName) {
    const existing = state.author && typeof state.author === 'object' && !Array.isArray(state.author)
      ? cloneValue(state.author)
      : { '@type': 'Person' };
    serialized.author = { ...existing, name: authorName };
  } else {
    delete serialized.author;
  }

  // dateCreated: keep the (possibly edited) value from the form.
  // dateModified: always refreshed to now on save.
  const created = textValue(state.dateCreated).trim();
  if (created) serialized.dateCreated = created;
  serialized.dateModified = new Date().toISOString();
  if (mode === 'edit') {
    const rating = serializeOptionalNumber(state.haRating);
    if (rating === undefined) delete serialized._ha_rating;
    else serialized._ha_rating = rating;
    if (textValue(state.haLastCooked).trim() === '') delete serialized._ha_last_cooked;
    else serialized._ha_last_cooked = textValue(state.haLastCooked);
  } else {
    delete serialized._ha_rating;
    delete serialized._ha_last_cooked;
  }
  return serialized;
}

export function validateFormState(state) {
  if (!textValue(state.name).trim()) return ['recipe_name_required'];
  if (!Array.isArray(state.steps) || state.steps.length === 0) {
    return ['recipe_step_required'];
  }
  // Steps may legitimately have no ingredients (e.g. finishing/serving steps
  // where everything was already used).
  return [];
}

export function validateImageFile(file) {
  return file && typeof file.type === 'string' && file.type.startsWith('image/')
    ? null
    : 'image_invalid_file';
}

/** Pretty-print a recipe object as the JSON shown in the JSON editor. */
export function recipeToJson(recipe) {
  return JSON.stringify(recipe ?? {}, null, 2);
}

/** Parse JSON text into a recipe object (throws on invalid JSON). */
export function jsonToRecipe(text) {
  return JSON.parse(text);
}

/**
 * Validate raw JSON text for the recipe editor: JSON syntax first, then the
 * same content rules the form enforces (name, >=1 step) plus a basic structural
 * check of recipeInstructions / ingredients.
 * @returns {{ ok: boolean, errors: string[], recipe?: object }}
 */
export function validateRecipeJson(text) {
  let recipe;
  try {
    recipe = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['json_syntax_invalid'] };
  }
  if (recipe === null || typeof recipe !== 'object' || Array.isArray(recipe)) {
    return { ok: false, errors: ['json_object_required'] };
  }

  const errors = [];
  if (!textValue(recipe.name).trim()) errors.push('recipe_name_required');

  const steps = recipe.recipeInstructions;
  if (!Array.isArray(steps) || steps.length === 0) {
    errors.push('recipe_step_required');
  } else {
    steps.forEach(step => {
      if (step === null || typeof step !== 'object' || Array.isArray(step)) {
        errors.push('json_step_invalid');
        return;
      }
      if (typeof step.instruction !== 'string') {
        errors.push('json_instruction_invalid');
      }
      if (step.ingredients !== undefined) {
        if (!Array.isArray(step.ingredients)) {
          errors.push('json_ingredients_invalid');
        } else {
          step.ingredients.forEach(ingredient => {
            if (ingredient === null || typeof ingredient !== 'object' || Array.isArray(ingredient)) {
              errors.push('json_ingredient_invalid');
            } else if (typeof ingredient.name !== 'string') {
              errors.push('json_ingredient_name_invalid');
            }
          });
        }
      }
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], recipe };
}

/**
 * Move an ingredient from one step to another, returning a new steps array.
 * Pure and immutable: the input is never mutated. Out-of-range indices, a
 * missing ingredient, or a no-op move return an equivalent steps array.
 *
 * @param {Array<{instruction:string, ingredients:Array}>} steps
 * @param {number} fromStep source step index
 * @param {number} ingredientIndex index of the ingredient within the source step
 * @param {number} toStep target step index
 * @returns {Array} a new steps array with the ingredient moved (appended to target)
 */
export function moveIngredientBetweenSteps(steps, fromStep, ingredientIndex, toStep) {
  if (!Array.isArray(steps)) return steps;
  const next = cloneValue(steps);
  if (fromStep < 0 || fromStep >= next.length) return steps;
  if (toStep < 0 || toStep >= next.length) return steps;
  if (fromStep === toStep) return next;
  const source = next[fromStep].ingredients;
  if (!Array.isArray(source) || ingredientIndex < 0 || ingredientIndex >= source.length) {
    return steps;
  }
  const [moved] = source.splice(ingredientIndex, 1);
  if (!Array.isArray(next[toStep].ingredients)) next[toStep].ingredients = [];
  next[toStep].ingredients.push(moved);
  return next;
}
