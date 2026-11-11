import type {
  BuiltinDimension,
  Condition,
  Dimension,
  Filter,
  InternalRule,
  PropertyRef,
} from "@cfanalytics/shared";
import { fragment, JSON_PATH, placeholders } from "./sql.ts";
import type { Statement } from "./types.ts";

// SQL fragments over `events e`: filters, the default exclusions and the
// breakdown dimensions. Each is a Statement: its SQL text and its own bound
// parameters, one per `?` in text order, so a compiler joins fragments by
// concatenating texts and params alike. Every value and every property name
// is a bound parameter, never pasted into the SQL text (query-02). A property is read
// by its exact name, case-sensitive (query-57), so a name holding quotes,
// dots, brackets or slashes reads that one key and nothing else. An event
// property reads e.properties; a person property reads the properties of the
// person e.person_id points at, so an event with no person has none. Pure.

type Scalar = string | number | boolean;

/** The JSON text a property is read from: the event's own, or its person's. */
const jsonOf = (property: PropertyRef): string =>
  property.of === "person"
    ? "(SELECT p.properties FROM persons p WHERE p.id = e.person_id)"
    : "e.properties";

const typeOf = (property: PropertyRef): string => `json_type(${jsonOf(property)}, ${JSON_PATH})`;
const extractOf = (property: PropertyRef): string =>
  `json_extract(${jsonOf(property)}, ${JSON_PATH})`;

/** A leaf with SQL's NULL replaced by false, so a missing property is never NULL and NOT of it is true. */
const neverNull = (statement: Statement): Statement =>
  fragment(`COALESCE(${statement.sql}, 0)`, ...statement.params);

/** True when the property is present with exactly this JSON type and value (query-52, query-58). */
function equalSql(property: PropertyRef, value: Scalar): Statement {
  const name = property.name;
  if (typeof value === "boolean") {
    return fragment(`${typeOf(property)} = ?`, name, value ? "true" : "false");
  }
  if (typeof value === "number") {
    return fragment(
      `${typeOf(property)} IN ('integer', 'real') AND ${extractOf(property)} = ?`,
      name,
      name,
      value,
    );
  }
  return fragment(`${typeOf(property)} = 'text' AND ${extractOf(property)} = ?`, name, name, value);
}

/** True when the property is present and `test` is not true, so a missing property never matches (query-53). */
function negated(property: PropertyRef, test: Statement): Statement {
  return fragment(
    `${typeOf(property)} IS NOT NULL AND NOT (${test.sql})`,
    property.name,
    ...test.params,
  );
}

/** True when the property's JSON type and value are one of these (query-52, query-58). */
function inSql(property: PropertyRef, values: readonly Scalar[]): Statement {
  const name = property.name;
  const numbers = values.filter((value): value is number => typeof value === "number");
  const strings = values.filter((value): value is string => typeof value === "string");
  const booleans = values
    .filter((value): value is boolean => typeof value === "boolean")
    .map((value) => (value ? "true" : "false"));
  const groups: Statement[] = [];
  if (numbers.length > 0) {
    groups.push(
      fragment(
        `${typeOf(property)} IN ('integer', 'real') AND ${extractOf(property)} IN (${placeholders(numbers.length)})`,
        name,
        name,
        ...numbers,
      ),
    );
  }
  if (strings.length > 0) {
    groups.push(
      fragment(
        `${typeOf(property)} = 'text' AND ${extractOf(property)} IN (${placeholders(strings.length)})`,
        name,
        name,
        ...strings,
      ),
    );
  }
  if (booleans.length > 0) {
    groups.push(
      fragment(`${typeOf(property)} IN (${placeholders(booleans.length)})`, name, ...booleans),
    );
  }
  const [only] = groups;
  if (groups.length === 1 && only !== undefined) return only;
  return fragment(
    groups.map((group) => `(${group.sql})`).join(" OR "),
    ...groups.flatMap((group) => group.params),
  );
}

const COMPARISON = { gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;

/** True when the property is a number past the bound, so a string never matches (query-56). */
function compareSql(property: PropertyRef, op: keyof typeof COMPARISON, value: number): Statement {
  return fragment(
    `${typeOf(property)} IN ('integer', 'real') AND ${extractOf(property)} ${COMPARISON[op]} ?`,
    property.name,
    property.name,
    value,
  );
}

/** True when the property is a number between both ends, inclusive (query-56). */
function betweenSql(property: PropertyRef, low: number, high: number): Statement {
  return fragment(
    `${typeOf(property)} IN ('integer', 'real') AND ${extractOf(property)} >= ? AND ${extractOf(property)} <= ?`,
    property.name,
    property.name,
    low,
    property.name,
    high,
  );
}

/** True when the stored text holds the term literally through LIKE, so a number never matches (query-50, query-55). */
function searchSql(
  property: PropertyRef,
  op: "contains" | "startsWith" | "endsWith",
  term: string,
): Statement {
  return fragment(
    `${typeOf(property)} = 'text' AND ${extractOf(property)} LIKE ? ESCAPE '\\'`,
    property.name,
    property.name,
    likePattern(term, op),
  );
}

/**
 * A filter as one SQL boolean expression, true exactly for the events it
 * selects (query-52 to query-58, query-60). `all` is AND, `any` is OR.
 * - eq, in: the stored JSON type and value match exactly, so 2 is not "2"
 *   and false is not 0; json_type decides (query-52, query-58).
 * - neq, notIn: true only when the property is present with another value, so
 *   a missing property never matches (query-53).
 * - gt, gte, lt, lte, between: numbers only; between includes both ends
 *   (query-56).
 * - contains, startsWith, endsWith: strings only, never numbers (query-55);
 *   a LIKE pattern from likePattern, so `%`, `_` and `\` in the term are
 *   literal (query-50). SQLite's LIKE folds ASCII case; the term is matched
 *   as a value otherwise, by the filters' own rules.
 * - exists: the key is present, JSON null and an empty array included;
 *   notExists: the key is absent; isNull: present and JSON null; notNull:
 *   present and not JSON null; isEmpty: present and "", [] or {} (query-54).
 * The expression is never NULL: a missing property makes it false, so NOT of
 * it is true (three-valued logic stays inside).
 */
export function filterSql(filter: Filter): Statement {
  if ("all" in filter) return groupSql("AND", filter.all);
  if ("any" in filter) return groupSql("OR", filter.any);
  return conditionSql(filter);
}

function groupSql(operator: "AND" | "OR", filters: readonly Filter[]): Statement {
  const parts = filters.map(filterSql);
  return fragment(
    parts.map((part) => `(${part.sql})`).join(` ${operator} `),
    ...parts.flatMap((part) => part.params),
  );
}

function conditionSql(condition: Condition): Statement {
  const { property } = condition;
  const name = property.name;
  let statement: Statement;
  switch (condition.op) {
    case "eq":
      statement = equalSql(property, condition.value);
      break;
    case "neq":
      statement = negated(property, equalSql(property, condition.value));
      break;
    case "in":
      statement = inSql(property, condition.values);
      break;
    case "notIn":
      statement = negated(property, inSql(property, condition.values));
      break;
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      statement = compareSql(property, condition.op, condition.value);
      break;
    case "between":
      statement = betweenSql(property, condition.low, condition.high);
      break;
    case "contains":
    case "startsWith":
    case "endsWith":
      statement = searchSql(property, condition.op, condition.value);
      break;
    case "exists":
      statement = fragment(`${typeOf(property)} IS NOT NULL`, name);
      break;
    case "notExists":
      statement = fragment(`${typeOf(property)} IS NULL`, name);
      break;
    case "isNull":
      statement = fragment(`${typeOf(property)} = 'null'`, name);
      break;
    case "notNull":
      statement = fragment(
        `${typeOf(property)} IS NOT NULL AND ${typeOf(property)} <> 'null'`,
        name,
        name,
      );
      break;
    case "isEmpty":
      statement = fragment(
        `${typeOf(property)} IN ('text', 'array', 'object') AND (` +
          `(${typeOf(property)} = 'text' AND ${extractOf(property)} = '') OR ` +
          `(${typeOf(property)} IN ('array', 'object') AND ` +
          `(SELECT count(*) FROM json_each(${jsonOf(property)}, ${JSON_PATH})) = 0))`,
        name,
        name,
        name,
        name,
        name,
      );
      break;
  }
  return neverNull(statement);
}

/** A LIKE pattern for `term` with ESCAPE '\\': `%`, `_` and `\` taken literally (query-50). */
export function likePattern(
  term: string,
  position: "contains" | "startsWith" | "endsWith",
): string {
  const escaped = term.replace(/[\\%_]/g, (character) => `\\${character}`);
  if (position === "contains") return `%${escaped}%`;
  if (position === "startsWith") return `${escaped}%`;
  return `%${escaped}`;
}

/**
 * The default exclusions, as one SQL boolean expression (query-07, query-08,
 * query-60):
 * - `e.bot = 0` unless includeBots;
 * - unless includeInternal, for each rule, NOT (the event's or its person's
 *   property equals the rule's value, by eq's rule of type and value). An
 *   event the rule does not match, its property missing or its person absent
 *   included, is kept: the NOT never meets a NULL.
 * "1" when nothing is excluded. `applied` lists the indexes of the rules
 * used, in the project's order, empty when includeInternal.
 */
export function exclusionsSql(
  rules: readonly InternalRule[],
  options: { includeBots: boolean; includeInternal: boolean },
): { where: Statement; applied: number[] } {
  const parts: Statement[] = [];
  const applied: number[] = [];
  if (!options.includeBots) parts.push(fragment("e.bot = 0"));
  if (!options.includeInternal) {
    rules.forEach((rule, index) => {
      applied.push(index);
      const property: PropertyRef = {
        of: rule.kind === "person_property" ? "person" : "event",
        name: rule.property,
      };
      const equal = neverNull(equalSql(property, rule.value));
      parts.push(fragment(`NOT ${equal.sql}`, ...equal.params));
    });
  }
  if (parts.length === 0) return { where: fragment("1"), applied };
  return {
    where: fragment(
      parts.map((part) => `(${part.sql})`).join(" AND "),
      ...parts.flatMap((part) => part.params),
    ),
    applied,
  };
}

/** A property's value as stored, with a missing, JSON null or blank value as NULL (query-46). */
function propertyValue(property: PropertyRef): Statement {
  return fragment(
    `CASE WHEN ${typeOf(property)} = 'text' THEN NULLIF(TRIM(${extractOf(property)}), '') ` +
      `ELSE ${extractOf(property)} END`,
    property.name,
    property.name,
    property.name,
  );
}

/** A text-valued built-in property, trimmed of blanks (query-46, query-67). */
const textValue = (name: string): Statement => propertyValue({ of: "event", name });

/** A referring domain, lower-cased, with a direct visit as DIRECT (query-46). */
function referringDomain(): Statement {
  const name = "$referring_domain";
  const value = `json_extract(e.properties, ${JSON_PATH})`;
  return fragment(
    `CASE WHEN json_type(e.properties, ${JSON_PATH}) = 'text' THEN ` +
      `CASE WHEN LOWER(TRIM(${value})) = ? THEN 'DIRECT' ` +
      `ELSE NULLIF(LOWER(TRIM(${value})), '') END END`,
    name,
    name,
    "$direct",
    name,
  );
}

/** A country code, trimmed and upper-cased (query-66). */
function country(): Statement {
  const name = "$geoip_country_code";
  return fragment(
    `CASE WHEN json_type(e.properties, ${JSON_PATH}) = 'text' THEN ` +
      `NULLIF(UPPER(TRIM(json_extract(e.properties, ${JSON_PATH}))), '') END`,
    name,
    name,
  );
}

/** The major number of a browser version: the digits before its first dot (query-68). */
function browserVersion(): Statement {
  const name = "$browser_version";
  const trimmed = `TRIM(json_extract(e.properties, ${JSON_PATH}))`;
  return fragment(
    `CASE WHEN json_type(e.properties, ${JSON_PATH}) = 'text' THEN ` +
      `NULLIF(SUBSTR(${trimmed}, 1, CASE WHEN INSTR(${trimmed}, '.') = 0 ` +
      `THEN LENGTH(${trimmed}) ELSE INSTR(${trimmed}, '.') - 1 END), '') END`,
    name,
    name,
    name,
    name,
    name,
  );
}

const BUILTIN_VALUE: Record<BuiltinDimension, () => Statement> = {
  event: () => fragment("e.event"),
  page: () => fragment("NULLIF(TRIM(e.page), '')"),
  referring_domain: referringDomain,
  country,
  device_type: () => textValue("$device_type"),
  browser: () => textValue("$browser"),
  os: () => textValue("$os"),
  utm_source: () => textValue("utm_source"),
  utm_medium: () => textValue("utm_medium"),
  utm_campaign: () => textValue("utm_campaign"),
  channel: () => textValue("$channel"),
};

/**
 * The SQL value of a breakdown or top-list dimension for an event, from the
 * closed list of built-ins or an open property (query-46, query-47,
 * query-57, query-64 to query-69):
 * - event: e.event; page: e.page (the page key, enrich-23);
 * - referring_domain: $referring_domain lower-cased, with "$direct" as
 *   "DIRECT" (query-46);
 * - country: $geoip_country_code, trimmed and upper-cased, two letters
 *   (query-66);
 * - device_type, browser, os: $device_type, $browser, $os as stored
 *   (query-67);
 * - utm_source, utm_medium, utm_campaign: the property trimmed (query-46,
 *   query-69);
 * - channel: the stored $channel, which intake sets (enrich-40, query-127);
 * - browser_version: the major number of $browser_version, the digits
 *   before its first dot (query-68);
 * - a property: its value as stored, by exact name.
 * Null, a missing property and a value blank after trimming all give NULL,
 * one key (query-46); the text "Unknown" stays its own key. `where` limits
 * the events the dimension counts: for browser_version, those whose $browser
 * equals the named browser, so no other browser's version is grouped
 * (query-68); "1" for every other dimension.
 */
export function dimensionSql(dimension: Dimension): { value: Statement; where: Statement } {
  if ("property" in dimension) {
    return { value: propertyValue(dimension.property), where: fragment("1") };
  }
  if ("browser" in dimension) {
    return {
      value: browserVersion(),
      where: equalSql({ of: "event", name: "$browser" }, dimension.browser),
    };
  }
  return { value: BUILTIN_VALUE[dimension.builtin](), where: fragment("1") };
}
