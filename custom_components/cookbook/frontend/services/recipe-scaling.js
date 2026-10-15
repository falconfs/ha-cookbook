const RANGE_PATTERN = /^(.*?)\s*([-–])\s*(.*?)$/;
const APPROXIMATE_PATTERN = /^ca\.\s*/i;
const MIXED_FRACTION_PATTERN = /^(\d+)\s+(\d+)\/(\d+)$/;
const FRACTION_PATTERN = /^(\d+)\/(\d+)$/;
const DECIMAL_PATTERN = /^\d+(?:[.,]\d+)?$/;
const MAX_DECIMAL_PLACES = 10;

export function isUsableRecipeYield(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function getServingScaleFactor(baseYield, targetYield) {
  if (!isUsableRecipeYield(baseYield)) return 1;
  return Math.max(1, targetYield) / baseYield;
}

function parseQuantity(value) {
  const mixedFraction = value.match(MIXED_FRACTION_PATTERN);
  if (mixedFraction) {
    const whole = Number(mixedFraction[1]);
    const numerator = Number(mixedFraction[2]);
    const denominator = Number(mixedFraction[3]);
    return denominator === 0 ? null : whole + numerator / denominator;
  }

  const fraction = value.match(FRACTION_PATTERN);
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    return denominator === 0 ? null : numerator / denominator;
  }

  if (!DECIMAL_PATTERN.test(value)) return null;
  return Number(value.replace(',', '.'));
}

function formatQuantity(value) {
  if (!Number.isFinite(value)) return null;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(MAX_DECIMAL_PLACES).replace(/0+$/, '').replace(/\.$/, '');
}

function scaleSingleQuantity(value, factor) {
  const quantity = parseQuantity(value);
  if (quantity === null) return null;
  return formatQuantity(quantity * factor);
}

export function scaleQuantityText(text, factor) {
  if (typeof text !== 'string') return text;

  const trimmed = text.trim();
  const prefix = APPROXIMATE_PATTERN.test(trimmed) ? 'ca. ' : '';
  const quantityText = prefix ? trimmed.replace(APPROXIMATE_PATTERN, '') : trimmed;
  const range = quantityText.match(RANGE_PATTERN);

  if (range) {
    const lower = scaleSingleQuantity(range[1].trim(), factor);
    const upper = scaleSingleQuantity(range[3].trim(), factor);
    if (lower === null || upper === null) return text;
    return `${prefix}${lower}-${upper}`;
  }

  const scaled = scaleSingleQuantity(quantityText, factor);
  return scaled === null ? text : `${prefix}${scaled}`;
}

export function scaleFlatIngredient(ingredient, factor) {
  return {
    ...ingredient,
    amount: scaleQuantityText(ingredient.amount, factor),
  };
}

export function scaleGroupedIngredient(grouped, factor) {
  return grouped.map(step => ({
    ...step,
    ingredients: Array.isArray(step.ingredients)
      ? step.ingredients.map(ingredient => scaleFlatIngredient(ingredient, factor))
      : [],
  }));
}
