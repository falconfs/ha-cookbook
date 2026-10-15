const DEFAULT_TAB = 'ingredients';
const VALID_TABS = new Set(['ingredients', 'instructions', 'info']);

function normalizeValue(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function normalizeRecipeViewConfig(config = {}, options = {}) {
  const rawTab = config.recipe_default_tab;
  const warn = typeof options.warn === 'function' ? options.warn : console.warn;
  const tab = normalizeValue(rawTab);

  return {
    recipe_default_tab: VALID_TABS.has(tab) ? tab : DEFAULT_TAB,
  };
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
  }
  return value;
}

function createInstructionResult(instructions, fallback) {
  const result = cloneValue(instructions ?? []);
  Object.defineProperty(result, 'fallback', { value: fallback, enumerable: false });
  return result;
}

export function getInstructionView(recipe) {
  return createInstructionResult(recipe.recipeInstructions, false);
}

function emptyProgress() {
  return { ingredients: [], instructions: [] };
}

function readProgress(state, recipeId) {
  const value = state.get(String(recipeId));
  if (!value || typeof value !== 'object') return emptyProgress();
  return {
    ingredients: Array.isArray(value.ingredients) ? [...value.ingredients] : [],
    instructions: Array.isArray(value.instructions) ? [...value.instructions] : [],
  };
}

function updateProgress(state, recipeId, category, index, done) {
  const progress = readProgress(state, recipeId);
  const indexes = progress[category];
  const position = indexes.indexOf(index);
  if (done && position === -1) indexes.push(index);
  if (!done && position !== -1) indexes.splice(position, 1);
  indexes.sort((left, right) => left - right);
  state.set(String(recipeId), progress);
}

export function createRecipeProgressStore(state = new Map()) {
  if (!state || typeof state.get !== 'function' || typeof state.set !== 'function') {
    throw new TypeError('Recipe progress state must implement Map.get() and Map.set().');
  }
  return {
    get: recipeId => readProgress(state, recipeId),
    setIngredientDone: (recipeId, index, done) => updateProgress(state, recipeId, 'ingredients', index, done),
    setInstructionDone: (recipeId, index, done) => updateProgress(state, recipeId, 'instructions', index, done),
    clear(recipeId) { state.delete(String(recipeId)); },
  };
}
