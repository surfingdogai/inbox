/**
 * Every topic guide's animated cover, by the name its entry in src/lib/topics.ts gives in
 * `cover.anim`. Kept apart from the blog's covers.ts: each one explains its own guide in a short
 * loop, is drawn the way CoverPay.astro is (inline SVG composed at rest, so the box is never
 * empty), stops when nobody is looking, and its rest frame is the guide's social card
 * (scripts/og-topic.mjs).
 */

import type { TopicCover } from "../lib/topics";
import CoverAgentVisit from "./CoverAgentVisit.astro";
import CoverPayRoutes from "./CoverPayRoutes.astro";
import CoverProtocols from "./CoverProtocols.astro";

export const topicCovers = {
  protocols: CoverProtocols,
  "pay-routes": CoverPayRoutes,
  "agent-visit": CoverAgentVisit,
} as const satisfies Record<TopicCover, unknown>;
