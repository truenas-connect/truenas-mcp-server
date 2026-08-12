// Tier-2b fixture: drives the REAL runServer exported from dist/ — same
// connect-and-serve wiring as the production binary, over this process's
// real stdio — with only the ClientFactory substituted, via the injectable
// seam runServer exposes for tests. Plain .mjs run by node directly: no tsx
// layer between the suite and the artifact under test.
import { parseArgs } from 'node:util';
import { of, throwError } from 'rxjs';
import { loadConfig, runServer } from '../../dist/index.js';

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    trace: { type: 'string' },
    // The named system fails pool.query, so a fan-out crosses stdio with
    // one healthy and one erroring system in the same result.
    'fail-pool-query': { type: 'string' },
  },
});

const config = loadConfig(values.config);

// Answers the calls the default catalog's tools make; anything else is a
// fixture bug and fails loudly. Per-system: responses are keyed by the
// system's name — divergent behaviour is the point, since identical
// fakes would prove only that the fan-out loop runs twice, not that each
// system's own client answered.
function fakeClient(name) {
  return {
    api: {
      // Plain verbs. The query verbs are NOT here — since api-client 2.0.0 the
      // tools reach those through the query helpers below, which return the
      // list directly instead of the union `call` yields.
      call(method, params) {
        switch (method) {
          case 'system.info':
            return of({ hostname: name, version: 'TrueNAS-25.10.0' });
          case 'pool.snapshot.create': {
            // params is the ApiCallParams tuple: [{ dataset, name, recursive }].
            const [snapshot] = params ?? [];
            return of({ name: `${snapshot?.dataset}@${snapshot?.name}` });
          }
          default:
            throw new Error(`fixture: unexpected api call "${method}" on ${name}`);
        }
      },
      // api.query(method, filters?, options?) — always resolves to a list.
      query(method) {
        switch (method) {
          case 'pool.query':
            if (values['fail-pool-query'] === name) {
              // Through the observable, like a real API error, and carrying
              // errname/errno so the suite can assert they survive stdio.
              return throwError(() =>
                Object.assign(new Error(`fixture: pool.query configured to fail on ${name}`), {
                  errname: 'EFAULT',
                  errno: 14,
                }),
              );
            }
            return of([
              { name: 'tank', status: 'ONLINE', healthy: true, size: 100, allocated: 40, free: 60 },
            ]);
          case 'pool.dataset.query':
            return of([
              { id: 'tank/data', pool: 'tank', type: 'FILESYSTEM', mountpoint: '/mnt/tank/data' },
            ]);
          default:
            throw new Error(`fixture: unexpected api query "${method}" on ${name}`);
        }
      },
    },
    close() {},
  };
}

await runServer(config, {
  configPath: values.config,
  ...(values.trace !== undefined ? { tracePath: values.trace } : {}),
  clientFactory: (spec) => Promise.resolve(fakeClient(spec.name)),
});
