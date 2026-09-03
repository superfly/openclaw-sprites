import { buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { SPRITES_PLUGIN_UI_HINTS, SpritesPluginConfigSchema } from "./config.js";

// Keep Zod objects inside the plugin: the host can use a different Zod minor.
// Preserve Zod parsing for transforms and refinements absent from JSON Schema.
export const spritesPluginConfigSchema = buildJsonPluginConfigSchema(
  SpritesPluginConfigSchema.toJSONSchema({
    target: "draft-07",
    io: "input",
    unrepresentable: "any",
  }),
  {
    uiHints: SPRITES_PLUGIN_UI_HINTS,
    safeParse(value) {
      const result = SpritesPluginConfigSchema.safeParse(value);
      if (result.success) {
        return { success: true, data: result.data };
      }
      return {
        success: false,
        error: {
          issues: result.error.issues.map((issue) => ({
            path: issue.path.filter(
              (part): part is string | number => typeof part === "string" || typeof part === "number",
            ),
            message: issue.message,
          })),
        },
      };
    },
  },
);
