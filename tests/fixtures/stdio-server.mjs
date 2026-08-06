// Tier-2b fixture (testing-plan Phase 4): drives the REAL runServer exported
// from dist/ — same connect-and-serve wiring as the production binary, over
// this process's real stdio — with only the ClientFactory substituted, via
// the seam Phase 2 added. Plain .mjs run by node directly: no tsx layer
// between the suite and the artifact under test.
import { parseArgs } from 'node:util';
import { of } from 'rxjs';
import { loadConfig, runServer } from '../../dist/index.js';

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    trace: { type: 'string' },
  },
});

const config = loadConfig(values.config);

// Answers exactly the calls the default catalog's tools make; anything else
// is a fixture bug and fails loudly.
function fakeClient() {
  return {
    api: {
      call(method, params) {
        switch (method) {
          case 'pool.query':
            return of([
              { name: 'tank', status: 'ONLINE', healthy: true, size: 100, allocated: 40, free: 60 },
            ]);
          case 'pool.dataset.query':
            return of([
              { id: 'tank/data', pool: 'tank', type: 'FILESYSTEM', mountpoint: '/mnt/tank/data' },
            ]);
          case 'pool.snapshot.create':
            return of({ name: `${params?.[0]?.dataset}@${params?.[0]?.name}` });
          default:
            throw new Error(`fixture: unexpected api call "${method}"`);
        }
      },
    },
    close() {},
  };
}

await runServer(config, {
  configPath: values.config,
  ...(values.trace !== undefined ? { tracePath: values.trace } : {}),
  clientFactory: () => Promise.resolve(fakeClient()),
});
