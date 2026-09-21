import { nodeSqliteClient } from "../src/node/index";
import { describeSqliteClientContract } from "./contract";

describeSqliteClientContract("node:sqlite", () => nodeSqliteClient(":memory:"));
