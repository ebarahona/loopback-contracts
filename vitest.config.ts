import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests boot a real Application and lifecycle observers.
    // Running them in parallel races on shared global state (decorator
    // metadata, controller bindings) and produces flaky failures.
    pool: 'threads',
    minWorkers: 1,
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
