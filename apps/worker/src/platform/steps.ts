import step0001 from "./schema/0001-project-store.sql";
import type { SchemaStep } from "./schema.ts";

// The ProjectStore's schema steps, in order. A new step is a new file and a new
// line here; an applied step never changes (scripts/migrations.test.mjs).
export const PROJECT_STORE_STEPS: readonly SchemaStep[] = [{ number: 1, sql: step0001 }];
