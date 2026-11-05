/**
 * Where Ctrl/Cmd+I puts the caret in a caption. A caption that starts with an
 * eight-digit date (`20261102`) starts its text after it, so the date is kept
 * and the rest is typed; anything else starts at the beginning. The digits are
 * not checked as a calendar date: eight digits at the start is the rule.
 */
export function captionCaretPosition(text: string): number {
  if (!/^[0-9]{8}(?=\s|$)/.test(text)) return 0;
  let caret = 8;
  while (caret < text.length && /\s/.test(text.charAt(caret))) caret++;
  return caret;
}
