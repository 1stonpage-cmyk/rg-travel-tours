import { describe } from 'vitest';
import { getPool } from '../../db/client';

let reachable: boolean | null = null;

async function probe(): Promise<boolean> {
  if (reachable !== null) return reachable;
  try {
    await getPool().query('SELECT 1');
    reachable = true;
  } catch {
    console.warn(
      '\n[tests] MySQL is unreachable — skipping DB-backed suites. ' +
        'Start MySQL and re-run to exercise them.\n',
    );
    reachable = false;
  }
  return reachable;
}

export function describeWithDb(name: string, fn: () => void) {
  describe(name, async () => {
    if (!(await probe())) {
      describe.skip(name, fn);
      return;
    }
    fn();
  });
}
