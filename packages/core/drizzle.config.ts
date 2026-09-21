import { defineConfig } from "drizzle-kit";

// Migrations are generated from src/schema/tables.ts, then embedded by scripts/embed-migrations.mjs.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/tables.ts",
  out: "./drizzle",
});
