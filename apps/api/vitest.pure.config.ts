import { defineProject } from 'vitest/config';

/**
 * The API's tests that need no database and no network (the roof in 3D's cache, layers and kill switch with fakes; the
 * GeoTIFF decoder's fuzzing; secrets in logs): `npm run test:pure -w @roofline/api`. Unlike the rest of this package
 * they start no Testcontainer, so any track can run them in seconds.
 */
export default defineProject({
  test: {
    name: 'api-pure',
    include: ['test/pure/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
