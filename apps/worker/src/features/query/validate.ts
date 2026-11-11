import {
  type ApiIssue,
  type Condition,
  type Filter,
  type FunnelSpec,
  jsonPointer,
  QUERY,
  QUERY_KINDS,
  type QueryKind,
  type QuerySpec,
  querySpec,
} from "@cfanalytics/shared";
import { err, ok, type Result } from "../../platform/result.ts";

// From a parsed request body to a QuerySpec (query-18, query-25 to query-27,
// query-36, query-47, query-50, query-56, query-59; platform-34). Pure.

const issue = (path: string, message: string): ApiIssue => ({
  path,
  code: "validation_failed",
  message,
});

/** The part of a zod issue this file reads; a union issue lists one issue list per branch. */
interface SchemaIssue {
  readonly code?: string;
  readonly path: PropertyKey[];
  readonly message: string;
  readonly errors?: readonly (readonly SchemaIssue[])[];
}

/**
 * A schema issue as API issues. A union's own issue is replaced by the issues
 * of the one branch that fitted the input, so an in list too long is refused
 * at its values, not at the filter. When two branches fitted (an unknown
 * dimension) or none did, the union's issue stands at its own path. A branch
 * that refused unknown keys at its root did not fit, so the branch that did
 * speaks (query-18, query-47, query-59).
 */
function schemaIssues(failure: SchemaIssue, prefix: string): ApiIssue[] {
  const here = prefix + jsonPointer(failure.path);
  const branches = failure.code === "invalid_union" ? failure.errors : undefined;
  if (branches === undefined || branches.length === 0) {
    return [issue(here, failure.message)];
  }
  const fitted = branches.filter(
    (branch) => !branch.some((each) => each.code === "unrecognized_keys" && each.path.length === 0),
  );
  const [only] = fitted;
  if (fitted.length !== 1 || only === undefined) {
    return [issue(here, failure.message)];
  }
  return only.flatMap((each) => schemaIssues(each, here));
}

/** A condition alone is depth 1; a group one more than its deepest child. */
function depthOf(filter: Filter): number {
  if ("all" in filter) return 1 + deepest(filter.all);
  if ("any" in filter) return 1 + deepest(filter.any);
  return 1;
}

const deepest = (filters: readonly Filter[]): number =>
  filters.reduce((depth, filter) => Math.max(depth, depthOf(filter)), 0);

/** The issues in a condition's own fields, at the condition's path (query-50, query-56). */
function conditionIssues(condition: Condition, path: string): ApiIssue[] {
  if (condition.op === "between") {
    return condition.low > condition.high
      ? [issue(path, "A between condition needs its low at or below its high.")]
      : [];
  }
  if (condition.op === "contains" || condition.op === "startsWith" || condition.op === "endsWith") {
    return new TextEncoder().encode(condition.value).length > QUERY.searchBytes
      ? [issue(`${path}/value`, `A search term is at most ${QUERY.searchBytes} bytes.`)]
      : [];
  }
  return [];
}

/** Every condition's issues, in document order, at its path. */
function filterIssues(filter: Filter, path: string): ApiIssue[] {
  if ("all" in filter) return groupIssues(filter.all, `${path}/all`);
  if ("any" in filter) return groupIssues(filter.any, `${path}/any`);
  return conditionIssues(filter, path);
}

function groupIssues(filters: readonly Filter[], path: string): ApiIssue[] {
  return filters.flatMap((filter, index) => filterIssues(filter, `${path}/${index}`));
}

/** A funnel step's repeated id, its person-property conditions and their fields (query-26, query-27). */
function stepIssues(steps: FunnelSpec["steps"]): ApiIssue[] {
  const issues: ApiIssue[] = [];
  const seen = new Set<string>();
  steps.forEach((step, index) => {
    if (seen.has(step.id)) {
      issues.push(issue(`/steps/${index}/id`, `The step id "${step.id}" is used twice.`));
    }
    seen.add(step.id);
    (step.where ?? []).forEach((condition, at) => {
      const path = `/steps/${index}/where/${at}`;
      if (condition.property.of === "person") {
        issues.push(
          issue(`${path}/property/of`, "A funnel step condition can read only event properties."),
        );
      }
      issues.push(...conditionIssues(condition, path));
    });
  });
  return issues;
}

/** The checks the schema cannot make, in document order (query-26, query-27, query-50, query-56, query-59). */
function specIssues(spec: QuerySpec): ApiIssue[] {
  const issues: ApiIssue[] = [];
  if (spec.filter !== undefined) {
    if (depthOf(spec.filter) > QUERY.filterDepth) {
      issues.push(
        issue("/filter", `The filter is nested deeper than ${QUERY.filterDepth} levels.`),
      );
    } else {
      issues.push(...filterIssues(spec.filter, "/filter"));
    }
  }
  if (spec.kind === "funnel") issues.push(...stepIssues(spec.steps));
  return issues;
}

const kindOf = (body: unknown): unknown =>
  typeof body === "object" && body !== null ? (body as { kind?: unknown }).kind : undefined;

const isKind = (value: unknown): value is QueryKind =>
  typeof value === "string" && (QUERY_KINDS as readonly string[]).includes(value);

/**
 * Parses `body` with `querySpec` from packages/shared, then checks what the
 * schema cannot. Every issue has a JSON pointer path, such as "/steps/1/id"
 * or "/range/from" ("" for the body itself), a code and one plain sentence,
 * and the first bad field comes first (query-18).
 * - A body that is not an object, or a missing or unknown `kind`: one issue
 *   at "/kind" with code "unknown_kind", whose message lists QUERY_KINDS
 *   (platform-34).
 * - Any other schema issue: code "validation_failed", one issue per field,
 *   at its path. A union's issue is replaced by the issues of the branch
 *   that fitted, so an in list too long is at "/filter/values" and an
 *   unknown built-in dimension is one issue at "/dimension" (query-47,
 *   query-59). This covers unknown keys (a spec naming a project included,
 *   query-01), wrong types, missing fields, a date without a time
 *   (query-36), an unknown built-in dimension (query-47), funnel steps
 *   outside 2 to 10 and a window that is not a positive whole number
 *   (query-25), and a step id that is not a slug (query-26).
 * - A filter nested deeper than QUERY.filterDepth (a condition alone is depth
 *   1), at the path of the first group too deep (query-59).
 * - `between` whose low is above its high, at that condition (query-56).
 * - `contains`, `startsWith` or `endsWith` with a term over QUERY.searchBytes
 *   UTF-8 bytes, at its value (query-50).
 * - Two funnel steps with the same id, at the second (query-26).
 * - A funnel step condition on a person property, at its
 *   "/steps/<i>/where/<j>/property/of" (query-27).
 * These later checks run only on a spec the schema accepted, and their issues
 * have code "validation_failed".
 */
export function parseSpec(body: unknown): Result<QuerySpec, ApiIssue[]> {
  const kind = kindOf(body);
  if (!isKind(kind)) {
    return err([
      {
        path: "/kind",
        code: "unknown_kind",
        message: `The query kind must be one of ${QUERY_KINDS.join(", ")}.`,
      },
    ]);
  }
  const parsed = querySpec.safeParse(body);
  if (!parsed.success) {
    return err(parsed.error.issues.flatMap((failure) => schemaIssues(failure, "")));
  }
  const issues = specIssues(parsed.data);
  return issues.length > 0 ? err(issues) : ok(parsed.data);
}
