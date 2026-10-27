import {
  CodeReplacementSet,
  expandCodeReplacements,
  type CodeReplacementTable,
} from './code-replacements';
import { expandVariables, type CaptionContext } from './variables';

export interface ExpandCaptionOptions extends CaptionContext {
  /** Loaded code replacement tables: later tables override earlier ones. */
  codeReplacements?: readonly CodeReplacementTable[];
  /** A pre-built set (takes precedence over `codeReplacements`). */
  codeReplacementSet?: CodeReplacementSet;
  /** PM's delimiter character, default `=` (PM 6+). */
  delimiter?: string;
  /** PM default replacement for unknown codes; absent = leave verbatim. */
  defaultReplacement?: string;
}

export interface ExpandCaptionResult {
  text: string;
  unknownCodes: string[];
  unknownVariables: string[];
  /**
   * Contract-compatible combined list (`metadata:expandCaption` has one
   * `unresolved` field). Tokens are returned as written, including delimiters.
   */
  unresolved: string[];
}

/**
 * Expand code replacements first, then variables. PM's documented
 * `={monthname}=` example only works in this order: the code itself may be a
 * variable name, and replacement text may contain variables.
 */
export function expandCaption(
  text: string,
  context: ExpandCaptionOptions = {},
): ExpandCaptionResult {
  const set =
    context.codeReplacementSet ??
    (context.codeReplacements === undefined
      ? undefined
      : new CodeReplacementSet(context.codeReplacements, {
          ...(context.delimiter === undefined ? {} : { delimiter: context.delimiter }),
          ...(context.defaultReplacement === undefined
            ? {}
            : { defaultReplacement: context.defaultReplacement }),
        }));

  const codeResult =
    set === undefined
      ? { text, unknownCodes: [] as string[] }
      : expandCodeReplacements(text, set, {
          // PM evaluates variables in the code itself (`={monthname}=`).
          resolveToken: (token) => expandVariables(token, context).text,
        });
  const variableResult = expandVariables(codeResult.text, context);

  const delimiter = set?.delimiter ?? context.delimiter ?? '=';
  const unresolved = [
    ...codeResult.unknownCodes.map((code) => `${delimiter}${code}${delimiter}`),
    ...variableResult.unknownVariables.map((name) => `{${name}}`),
  ];

  return {
    text: variableResult.text,
    unknownCodes: codeResult.unknownCodes,
    unknownVariables: variableResult.unknownVariables,
    unresolved,
  };
}
