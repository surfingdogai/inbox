import { hasAliasedFields, lenientInput } from "@surfingdog/core";
import { validator as describedValidator } from "hono-openapi";
import type { z } from "zod";

/**
 * hono-openapi's validator, taking service_id and access_token under either spelling, serviceId and
 * accessToken too, in a body or a query (`lenientInput`), as the MCP tools do. /openapi.json describes
 * the spelling each input documents, as before.
 */
export const validator = ((target: never, schema: z.ZodType, hook?: never, options?: never) =>
  describedValidator(
    target,
    hasAliasedFields(schema) ? lenientInput(schema) : schema,
    hook,
    options,
  )) as unknown as typeof describedValidator;
