# Cookbook Card Recipe Schema

Version 6.0.0 is the major schema release after 5.9.0. A recipe is stored as a
JSON object in `/config/cookbook/recipes/<id>/recipe.json` and is exchanged by
the `cookbook` Home Assistant services.

## Core shape

```json
{
  "id": "1852",
  "name": "Asiatischer Nudelsalat",
  "description": "",
  "@context": "http://schema.org",
  "@type": "Recipe",
  "recipeCategory": "Salat",
  "keywords": "Salat,Thai",
  "recipeYield": 4,
  "recipeInstructions": [
    {
      "ingredients": [
        { "name": "Nudeln", "amount": "120", "unit": "g", "note": "" }
      ],
      "instruction": "Die Nudeln kochen."
    }
  ],
  "nutrition": { "@type": "NutritionInformation" },
  "tool": [],
  "image": "",
  "url": "",
  "dateCreated": "2025-03-30T21:42:24+00:00",
  "dateModified": "2025-03-30T21:42:24+00:00",
  "datePublished": null,
  "prepTime": null,
  "cookTime": null,
  "totalTime": null,
  "_ha_rating": 0,
  "_ha_last_cooked": null
}
```

## Fields

Required identity and display fields are `id`, `name`, `description`,
`recipeCategory`, `keywords`, `recipeYield`, `recipeInstructions`,
`dateCreated`, and `dateModified`. Schema.org metadata such as `author`,
`publisher`, `aggregateRating`, `recipeCuisine`, `nutrition`, `image`, and
`url` remains supported when present.

`keywords` is a comma-separated string. Time values use ISO 8601 durations,
or `null` when no value exists. Nutrition values are strings when supplied.
Home Assistant metadata uses `_ha_rating` and `_ha_last_cooked`.

## Structured preparation

`recipeInstructions` is the single source of truth for preparation. Each entry
has an `instruction` string and an `ingredients` array. Each ingredient has
four string fields: `name`, `amount`, `unit`, and `note`. Empty values are
represented by `""`. A step may have no ingredients.

The order of steps and ingredients is significant. A recipe without steps uses
an empty `recipeInstructions` array. The card derives its Ingredients view from
the ingredients in these structured steps.

## Tooling

The machine-readable schema is in `recipe.schema.ts`. Validate local migrated
v6 directories with:

```bash
npm run validate
npm run typecheck
```

The validator reads `../../cookbook_v6/*/recipe.json`.
