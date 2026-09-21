import { env } from "cloudflare:test";
import { type D1Like, d1Client } from "../src/cloudflare/index";
import { describeSqliteClientContract } from "./contract";

// The D1 binding declared in wrangler.jsonc; storage is isolated per test file.
describeSqliteClientContract("d1", () => d1Client((env as unknown as { DB: D1Like }).DB));
