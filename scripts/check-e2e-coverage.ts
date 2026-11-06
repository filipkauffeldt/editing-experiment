import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Fails when an Electron e2e file is not reached by any script a CI workflow runs.
 *
 * The workflows are read as text on purpose: there is no YAML dependency here, and the only
 * thing needed is every `pnpm <script>` a job invokes. Scripts are expanded through
 * package.json so a job that runs `pnpm test` also covers what `test:e2e` lists.
 */

const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};
const scripts = packageJson.scripts ?? {};
const workflowDir = join(repoRoot, '.github', 'workflows');
const workflows = readdirSync(workflowDir)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .sort()
  .map((name) => ({ name, text: readFileSync(join(workflowDir, name), 'utf8') }));

const testDir = join(repoRoot, 'apps', 'desktop', 'test');
const e2eFiles = readdirSync(testDir)
  .filter((name) => name.endsWith('.e2e.test.ts'))
  .sort();

const INVOCATION = /\bpnpm\s+(?:--[\w-]+(?:=\S+)?\s+)*([\w:-]+)/g;
const E2E_FILE = /apps\/desktop\/test\/[\w.-]+\.e2e\.test\.ts/g;

/** Script names a workflow calls directly, with the workflow that calls them. */
const invokedBy = new Map<string, Set<string>>();
for (const { name: workflow, text } of workflows) {
  for (const match of text.matchAll(INVOCATION)) {
    const script = match[1]!;
    if (!(script in scripts)) continue;
    const workflowsFor = invokedBy.get(script) ?? new Set<string>();
    workflowsFor.add(workflow);
    invokedBy.set(script, workflowsFor);
  }
}

/** Expand `pnpm <script>` inside the invoked scripts, so `pnpm test` reaches `test:e2e`. */
const reached = new Set<string>(invokedBy.keys());
const queue = [...reached];
while (queue.length > 0) {
  const script = queue.pop()!;
  for (const match of (scripts[script] ?? '').matchAll(INVOCATION)) {
    const nested = match[1]!;
    if (!(nested in scripts) || reached.has(nested)) continue;
    reached.add(nested);
    queue.push(nested);
  }
}

/** Every e2e file named by a script a workflow runs, plus paths written in a workflow itself. */
const covered = new Map<string, Set<string>>();
const add = (file: string, source: string): void => {
  const sourcesFor = covered.get(file) ?? new Set<string>();
  sourcesFor.add(source);
  covered.set(file, sourcesFor);
};
for (const script of reached) {
  for (const match of (scripts[script] ?? '').matchAll(E2E_FILE)) add(match[0], script);
}
for (const { name: workflow, text } of workflows) {
  for (const match of text.matchAll(E2E_FILE)) add(match[0], workflow);
}

const missing = e2eFiles.filter((file) => !covered.has(`apps/desktop/test/${file}`));
const unknown = [...covered.keys()].filter(
  (file) => !e2eFiles.includes(file.split('/').pop() ?? ''),
);

if (missing.length > 0) {
  console.error('E2E files no CI job runs:');
  for (const file of missing) console.error(`  apps/desktop/test/${file}`);
  console.error('\nAdd each to a test:e2e* script that a workflow in .github/workflows runs.');
  process.exitCode = 1;
} else {
  console.log(
    `All ${e2eFiles.length} e2e files are reached by CI (${reached.size} scripts across ${workflows.length} workflows).`,
  );
}

if (unknown.length > 0) {
  console.error('CI scripts name e2e files that do not exist:');
  for (const file of unknown) console.error(`  ${file}`);
  process.exitCode = 1;
}
