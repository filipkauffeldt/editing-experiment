let last = 0;

/**
 * A number that grows with every change of the session. Develop steps and label or metadata steps
 * are kept apart, so this is what says which of them happened last (a clock can tie).
 */
export const nextChangeOrder = (): number => ++last;
