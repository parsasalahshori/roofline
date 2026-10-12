import type { Config } from '../config.ts';
import type { AdImageRenderer } from './ad-image.ts';

/** The real ad-card renderer. Stub from S1 Task 7: its card() throws until Task 19 builds it. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- stub parameter, used once the renderer exists
export function resvgCardFor(_config: Config): AdImageRenderer {
  return {
    async card(): Promise<Uint8Array> {
      throw new Error('not yet');
    },
  };
}
