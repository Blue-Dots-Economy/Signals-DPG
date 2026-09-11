import { is_populated } from './profile_completion.js';

interface ActionableTagsSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, unknown>;
}

export interface ActionableTagsInput {
  payload: Record<string, unknown>;
  schema: ActionableTagsSchema;
}

/**
 * Underscores are trimmed by index rather than /^_+|_+$/g: that pattern
 * backtracks quadratically on a long run. The input is a schema field name
 * (operator-set), so this is not a reachable DoS — the linear form is simply
 * free, and does not depend on the input staying operator-set.
 */
const trimUnderscores = (s: string): string => {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === '_') start++;
  while (end > start && s[end - 1] === '_') end--;
  return s.slice(start, end);
};

const slugify = (s: string): string =>
  trimUnderscores(s.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, '_'));

/**
 * Schema-derived `missing_<required_field>` tags only.
 *
 * Network-specific business tags (`all_applications_rejected`,
 * `no_recent_activity`, `no_applications_yet`, `decisions_overdue`) are
 * removed — those names baked Jobs vocabulary into Signals. If a future
 * product need calls for business tags, add them via a config-driven
 * `tag_rules` array reusing the status-rule DSL.
 */
export const compute_actionable_tags = (i: ActionableTagsInput): string[] => {
  const tags: string[] = [];
  for (const key of i.schema.required ?? []) {
    if (!is_populated(i.payload?.[key])) {
      tags.push(`missing_${slugify(key)}`);
    }
  }
  return tags;
};
