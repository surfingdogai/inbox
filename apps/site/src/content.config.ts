import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import { glob } from "astro/loaders";
import { z } from "astro/zod";
import { hostedDocsData } from "./lib/hosted-markdown";

/**
 * Starlight's docs (src/content/docs, served under /docs), the blog (src/content/blog, one
 * Markdown file per post, rendered by src/pages/blog), the guides (src/content/guides, rendered by
 * src/pages/guides) and the hosted pilot's pages (src/content/hosted, rendered by src/pages/hosted
 * only while the pilot is open: src/lib/hosted.ts).
 */
export const collections = {
  /**
   * A docs page may also give the description it has once the hosted pilot is open
   * (`hostedOpen.description`); its body marks its two versions itself (src/lib/hosted-markdown.ts).
   */
  docs: defineCollection({
    loader: docsLoader(),
    schema: (context) =>
      docsSchema({ extend: z.object({ hostedOpen: z.object({ description: z.string() }).strict().optional() }) })(
        context,
      ).transform((data) => hostedDocsData(data)),
  }),
  /**
   * A guide's prose, one Markdown file per slug and nothing in its frontmatter: its title, answer,
   * options and examples are in src/lib/guides.ts, which the hub, the pages and the tests all read.
   */
  guides: defineCollection({
    loader: glob({ pattern: "*.md", base: "./src/content/guides" }),
    schema: z.object({}).strict(),
  }),
  /**
   * The hosted pilot: its page (index.md, at /hosted/) and its terms, one Markdown file each. None is
   * generated while HOSTED_PILOT_OPEN is false.
   */
  hosted: defineCollection({
    loader: glob({ pattern: "*.md", base: "./src/content/hosted" }),
    schema: z
      .object({
        title: z.string(),
        description: z.string(),
        eyebrow: z.string(),
        /** The date the text last changed, as the page prints it ("13 October 2026"). */
        updated: z.string(),
        /** Where the page sits in the list of hosted pages. */
        order: z.number().int(),
      })
      .strict(),
  }),
  blog: defineCollection({
    loader: glob({ pattern: "**/[^_]*.md", base: "./src/content/blog" }),
    schema: z.object({
      title: z.string(),
      description: z.string(),
      date: z.coerce.date(),
      author: z.string().default("Surfing Dog"),
      /** Public path of the cover art, e.g. /art/blog-hello.png (16:9). */
      cover: z.string().optional(),
      coverAlt: z.string().optional(),
      /**
       * The post's animated cover (src/components/covers.ts): it explains the post, and replaces the
       * still `cover` on the post page and on the blog index. Every post has one.
       */
      coverAnim: z
        .enum([
          "receipts",
          "flood",
          "networks",
          "open",
          "muse",
          "dots",
          "ready",
          "agentready",
          "rawhtml",
          "tables",
          "found",
        ])
        .optional(),
      /**
       * Public path of the post's social card (1200×630), made for the post by
       * scripts/og-post.mjs: its art and its one idea in words. Falls back to `cover`.
       */
      og: z.string().optional(),
      /**
       * End the post with the checker's form (src/components/GuideCheck.astro), so a reader pastes
       * their own site and lands on its result: for posts that end by asking them to check it.
       */
      checkForm: z.boolean().optional(),
    }),
  }),
};
