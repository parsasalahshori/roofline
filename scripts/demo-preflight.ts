import { createServer } from 'node:net';

/*
 * The demo's up-front checks (scripts/demo.ts): each one answers with a plain fix-it sentence, so a
 * non-developer running `npm run demo` knows what to do. The pure parts are unit-tested in
 * scripts/test/demo-preflight.test.ts.
 */

/** The oldest Node the app runs on (package.json engines). */
export const MIN_NODE = [22, 13, 0] as const;

/** Null when `version` (like `v22.13.1`) is new enough, else the fix-it message. */
export function nodeProblem(version: string): string | null {
  const parts = version.replace(/^v/, '').split('.').map(Number);
  const [major = 0, minor = 0, patch = 0] = parts;
  const ok =
    major > MIN_NODE[0] ||
    (major === MIN_NODE[0] && (minor > MIN_NODE[1] || (minor === MIN_NODE[1] && patch >= MIN_NODE[2])));
  if (ok) return null;
  return (
    `Node ${MIN_NODE.join('.')} or newer is needed, and this is Node ${version}. ` +
    'Install Node 22 (https://nodejs.org/en/download, or `fnm install` / `nvm install` in this folder, which reads .nvmrc) and run npm run demo again.'
  );
}

/** The fix-it message when Docker is not answering, for this platform. */
export function dockerProblem(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return 'Docker is not running. Open Docker Desktop (Applications → Docker), wait until it says "Engine running", then run npm run demo again. Not installed? https://www.docker.com/products/docker-desktop/ or: brew install --cask docker';
  }
  if (platform === 'win32') {
    return 'Docker is not running. Start Docker Desktop, wait until it says "Engine running", then run npm run demo again.';
  }
  return 'Docker is not running and dockerd could not be started. Start Docker (sudo systemctl start docker, or dockerd) and run npm run demo again.';
}

/** The fix-it message for a port something else is using. */
export function portProblem(port: number, envName: string): string {
  return `Port ${port} is already in use (maybe a demo is already running in another window?). Stop that, or pick another port: ${envName}=<port> npm run demo`;
}

/** True when nothing is listening on 127.0.0.1:`port`. */
export function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}
