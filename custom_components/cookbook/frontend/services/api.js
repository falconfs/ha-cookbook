import { createI18n } from '../i18n/i18n.js';

export class CookbookApi {
  constructor(hass, cache, { i18n = createI18n() } = {}) {
    this._hass = hass;
    this._cache = cache;
    this._i18n = i18n;
  }

  setHass(hass) {
    this._hass = hass;
  }

  setI18n(i18n) {
    this._i18n = i18n;
  }

  _errorMessage(response, fallbackKey) {
    if (response?.error_code) return this._i18n.t(`errors.${response.error_code}`, response);
    if (response?.error) return response.error;
    return this._i18n.t(fallbackKey);
  }

  _localizeErrorResponse(response, fallbackKey) {
    if (!response?.error) return response;
    return { ...response, error: this._errorMessage(response, fallbackKey) };
  }

  async getRecipes() {
    const cached = this._cache.get('recipes');
    if (cached) return cached;
    const recipes = await this._listRecipes();
    this._cache.set('recipes', recipes);
    return recipes;
  }

  async getCategories() {
    const cached = this._cache.get('categories');
    if (cached) return cached;
    const recipes = await this.getRecipes();
    const categories = this._categoriesFrom(recipes);
    this._cache.set('categories', categories);
    return categories;
  }

  async refreshData() {
    const recipes = await this._listRecipes();
    const categories = this._categoriesFrom(recipes);
    this._cache.set('recipes', recipes);
    this._cache.set('categories', categories);
    return { recipes, categories };
  }

  async getRecipe(id) {
    const cacheKey = `recipe:${id}`;
    const cached = this._cache.get(cacheKey);
    if (cached) return cached;
    const response = await this._callWS('get_recipe', { recipe_id: String(id) });
    const recipe = response.recipe;
    if (!recipe) throw new Error(this._i18n.t('errors.recipe_not_found'));
    this._cache.set(cacheKey, recipe, 300);
    return recipe;
  }

  async updateRecipeMeta(id, { rating, lastCooked } = {}) {
    const recipe = { ...(await this.getRecipe(id)) };
    if (rating !== undefined) recipe._ha_rating = rating;
    if (lastCooked) recipe._ha_last_cooked = lastCooked;
    const response = await this._callWS('upsert_recipe', { recipe_id: String(id), recipe });
    const updatedRecipe = response.recipe ?? recipe;
    this._cache.set(`recipe:${id}`, updatedRecipe, 300);
    return updatedRecipe;
  }

  async createRecipe(recipe, tmpImageToken, removeImage) {
    const serviceData = { recipe };
    if (tmpImageToken) serviceData.tmp_image_token = tmpImageToken;
    else if (removeImage) serviceData.remove_image = true;
    const response = await this._callWS('upsert_recipe', serviceData);
    if (!response?.recipe_id) {
      throw new Error(this._i18n.t('errors.recipe_id_missing'));
    }
    this._cache.delete('recipes');
    this._cache.delete('categories');
    this._cache.delete('suggestions');
    await this.refreshData();
    return String(response.recipe_id);
  }

  async updateRecipe(id, recipe, tmpImageToken, removeImage) {
    const serviceData = { recipe_id: String(id), recipe };
    if (tmpImageToken) serviceData.tmp_image_token = tmpImageToken;
    else if (removeImage) serviceData.remove_image = true;
    await this._callWS('upsert_recipe', serviceData);
    this._cache.delete(`recipe:${id}`);
    this._cache.delete('recipes');
    this._cache.delete('categories');
    this._cache.delete('suggestions');
    await this.refreshData();
  }

  async deleteRecipe(id) {
    await this._callWS('delete_recipe', { recipe_id: String(id) });
    this._cache.delete(`recipe:${id}`);
    this._cache.delete('recipes');
    this._cache.delete('categories');
    this._cache.delete('suggestions');
    await this.refreshData();
  }

  async fetchImageFromUrl(id, imageUrl) {
    const response = await this._callWS('fetch_image_from_url', {
      recipe_id: String(id),
      image_url: imageUrl,
    });
    this._cache.delete(`recipe:${id}`);
    return this._localizeErrorResponse(response, 'errors.image_download_failed');
  }

  async uploadRecipeImage(id, file) {
    const body = new FormData();
    body.append('file', file);
    const response = await fetch(this.imageUrl(id), { method: 'POST', body });
    if (!response.ok) {
      throw new Error(this._i18n.t('errors.image_save_failed', { status: response.status }));
    }
    this._cache.delete(`recipe:${id}`);
    return response.json();
  }

  async getSuggestions() {
    const cached = this._cache.get('suggestions');
    if (cached) return cached;
    const recipes = await this.getRecipes();
    const categories = this._categoriesFrom(recipes);
    const keywords = this._keywordsFrom(recipes);
    const { units, tools } = await this._detailSuggestionsFrom(recipes);
    const suggestions = { categories, keywords, units, tools };
    this._cache.set('suggestions', suggestions);
    return suggestions;
  }

  async fetchImageToTmp(imageUrl) {
    const response = await this._callWS('fetch_image_to_tmp', { image_url: imageUrl });
    return this._localizeErrorResponse(response, 'errors.image_download_failed');
  }

  // --- Weekly recipe calendar (feature-10) ---------------------------------

  /** Load the weekly meal plan document (version, slots, entries). */
  async getMealPlan() {
    const response = await this._callWS('get_meal_plan');
    if (response?.error) throw new Error(this._errorMessage(response, 'errors.meal_plan_unavailable'));
    return response.plan ?? { version: 1, slots: [], entries: [] };
  }

  /**
   * Add one plan entry; returns the created entry with its stable id. Provide a
   * recipeId, a text, or a recipeId plus a text note (at least one required).
   */
  async addMealPlanEntry({ date, slotId, recipeId, text }) {
    const serviceData = { date, slot_id: slotId };
    if (recipeId !== undefined && recipeId !== null && String(recipeId) !== '') {
      serviceData.recipe_id = String(recipeId);
    }
    if (text !== undefined && text !== null && String(text) !== '') {
      serviceData.text = String(text);
    }
    const response = await this._callWS('add_meal_plan_entry', serviceData);
    if (response?.error) throw new Error(this._errorMessage(response, 'errors.invalid_meal_plan_entry'));
    return response.entry;
  }

  /** Update one plan entry (date, slot, recipe and/or text) keeping its id. */
  async updateMealPlanEntry(entryId, { date, slotId, recipeId, text }) {
    const serviceData = { entry_id: String(entryId), date, slot_id: slotId };
    if (recipeId !== undefined && recipeId !== null && String(recipeId) !== '') {
      serviceData.recipe_id = String(recipeId);
    }
    if (text !== undefined && text !== null && String(text) !== '') {
      serviceData.text = String(text);
    }
    const response = await this._callWS('update_meal_plan_entry', serviceData);
    if (response?.error) throw new Error(this._errorMessage(response, 'errors.invalid_meal_plan_entry'));
    return response.entry;
  }

  /** Delete one plan entry by id; the recipe itself is not affected. */
  async deleteMealPlanEntry(entryId) {
    const response = await this._callWS('delete_meal_plan_entry', { entry_id: String(entryId) });
    if (response?.error) throw new Error(this._errorMessage(response, 'errors.invalid_meal_plan_entry'));
    return Boolean(response.ok);
  }

  /** Replace the global slot configuration; returns the updated plan. */
  async saveMealPlanSlots(slots) {
    const response = await this._callWS('save_meal_plan_slots', { slots });
    if (response?.error) throw new Error(this._errorMessage(response, 'errors.slot_validation_failed'));
    return response.plan;
  }

  /**
   * Import a recipe from a URL into a v6 draft for editor review.
   * Does not save; the caller persists after user confirmation.
   * @param {string} url
   * @param {string} [aiTaskEntity] optional preferred AI Task entity id
   * @returns {Promise<{recipe: object, import_method: string}>} the draft and its source
   */
  async importRecipeFromUrl(url, aiTaskEntity) {
    const serviceData = { url };
    if (aiTaskEntity) serviceData.ai_task_entity = aiTaskEntity;
    const response = await this._callWS('import_recipe_from_url', serviceData);
    if (response?.error) throw new Error(this._errorMessage(response, 'errors.import_response_invalid'));
    if (!response?.recipe) throw new Error(this._i18n.t('errors.import_response_invalid'));
    return {
      recipe: response.recipe,
      import_method: response.import_method === 'ai' ? 'ai' : 'native',
    };
  }

  /**
   * Direct AI import: extract a v6 draft from a page via ai_task.
   * @param {string} url
   * @param {string} [aiTaskEntity] optional preferred AI Task entity id
   * @returns {Promise<object>} the normalized draft recipe
   */
  async aiImportFromUrl(url, aiTaskEntity) {
    const serviceData = { url };
    if (aiTaskEntity) serviceData.ai_task_entity = aiTaskEntity;
    const response = await this._callWS('ai_import_recipe_from_url', serviceData);
    if (response?.error) throw new Error(this._errorMessage(response, 'errors.ai_recipe_invalid'));
    if (!response?.recipe) throw new Error(this._i18n.t('errors.ai_import_response_invalid'));
    return response.recipe;
  }

  /**
   * AI improvement: re-group a recipe's ingredients to the right steps.
   * @param {object} recipe current v6 recipe draft
   * @param {string} [aiTaskEntity] optional preferred AI Task entity id
   * @returns {Promise<object>} the regrouped draft recipe
   */
  async aiRegroupRecipe(recipe, aiTaskEntity) {
    const serviceData = { recipe };
    if (aiTaskEntity) serviceData.ai_task_entity = aiTaskEntity;
    const response = await this._callWS('ai_regroup_recipe', serviceData);
    if (response?.error) throw new Error(this._errorMessage(response, 'errors.ai_result_invalid'));
    if (!response?.recipe) throw new Error(this._i18n.t('errors.ai_regroup_response_invalid'));
    return response.recipe;
  }

  async uploadImageToTmp(file) {
    const body = new FormData();
    body.append('file', file);
    const response = await fetch('/api/cookbook/tmp', { method: 'POST', body });
    if (!response.ok) {
      throw new Error(this._i18n.t('errors.image_tmp_upload_failed', { status: response.status }));
    }
    return this._localizeErrorResponse(await response.json(), 'errors.image_tmp_upload_failed');
  }

  imageUrl(id, version) {
    const base = `/api/cookbook/recipes/${id}/image`;
    return version ? `${base}?v=${version}` : base;
  }

  tmpImageUrl(token) {
    return `/api/cookbook/tmp/${token}`;
  }

  _keywordsFrom(recipes) {
    const keywords = new Set();
    recipes.forEach(recipe => {
      String(recipe.keywords || '')
        .split(',')
        .map(keyword => keyword.trim())
        .filter(Boolean)
        .forEach(keyword => keywords.add(keyword));
    });
    return [...keywords].sort((left, right) => left.localeCompare(right));
  }

  async _detailSuggestionsFrom(recipes) {
    const units = new Set();
    const tools = new Set();
    const details = await Promise.all(recipes.map(recipe => this.getRecipe(recipe.id).catch(() => null)));
    details.forEach(recipe => {
      (recipe?.recipeInstructions || []).forEach(step => {
        (step.ingredients || []).forEach(ingredient => {
          const unit = String(ingredient.unit || '').trim();
          if (unit) units.add(unit);
        });
      });
      (recipe?.tool || []).forEach(tool => {
        const value = String(tool || '').trim();
        if (value) tools.add(value);
      });
    });
    const sort = set => [...set].sort((left, right) => left.localeCompare(right));
    return { units: sort(units), tools: sort(tools) };
  }

  _categoriesFrom(recipes) {
    return [...new Set(
      recipes
        .map(recipe => recipe.recipeCategory)
        .filter(category => typeof category === 'string' && category.length > 0),
    )].sort((left, right) => left.localeCompare(right));
  }

  async _listRecipes() {
    const response = await this._callWS('list_recipes');
    return Array.isArray(response.recipes) ? response.recipes : [];
  }

  async _callWS(service, serviceData = {}) {
    try {
      const result = await this._hass.callWS({
        type: 'call_service',
        domain: 'cookbook',
        service,
        service_data: serviceData,
        return_response: true,
      });
      return result.response ?? {};
    } catch (error) {
      const detail = this._describeError(error);
      throw new Error(this._i18n.t('errors.service_failed', {
        service: `cookbook.${service}`,
        detail,
      }), { cause: error });
    }
  }

  /** Best-effort human-readable message from a thrown value (HA errors are often plain objects). */
  _describeError(error) {
    if (error instanceof Error) return error.message;
    if (error && typeof error === 'object') {
      if (typeof error.message === 'string') return error.message;
      if (typeof error.error === 'string') return error.error;
      if (typeof error.code === 'string') return error.code;
      try {
        return JSON.stringify(error);
      } catch {
        return String(error);
      }
    }
    return String(error);
  }
}
