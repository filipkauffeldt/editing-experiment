export interface TeardownStep {
  name: string;
  run(): Promise<void> | void;
}

/**
 * Run every step in order, even when earlier ones throw: a stuck upload queue must
 * not keep ExifTool or the databases from closing. Failures are collected and
 * thrown together at the end.
 */
export async function runTeardown(steps: TeardownStep[]): Promise<void> {
  const failures: Error[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      failures.push(
        new Error(`${step.name}: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        }),
      );
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `teardown failed: ${failures.map((f) => f.message).join('; ')}`,
    );
  }
}
