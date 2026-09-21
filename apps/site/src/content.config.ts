import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

/**
 * Starlight's docs (src/content/docs, served under /docs) and the blog (src/content/blog, one
 * Markdown file per post, rendered by src/pages/blog).
 */
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
  blog: defineCollection({
    loader: glob({ pattern: "**/[^_]*.md", base: "./src/content/blog" }),
    schema: z.object({
      title: z.string(),
      description: z.string(),
      date: z.coerce.date(),
      author: z.string().default("Tiago Pita"),
      /** Public path of the cover art, e.g. /art/blog-hello.png (16:9). */
      cover: z.string().optional(),
      coverAlt: z.string().optional(),
    }),
  }),
};
