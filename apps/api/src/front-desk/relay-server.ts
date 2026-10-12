import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import type { AppDeps } from '../app.ts';

export const RELAY_PATH = '/relay';
export const RELAY_CLOSE_POLICY = 1008;
const RELAY_NOT_BUILT = 'Front Desk relay is not built yet.';
const REFUSED = 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';

/**
 * Attaches the ConversationRelay WebSocket upgrade to the HTTP server. Only /relay upgrades; any
 * other upgrade path is refused. Stub: Task 11 replaces the connection body (deps are for it).
 */
export function attachRelayUpgrade(server: Server, deps: AppDeps): { close(): void } {
  void deps;
  const wss = new WebSocketServer({ noServer: true });
  const onUpgrade = (req: Parameters<typeof wss.handleUpgrade>[0], socket: Parameters<typeof wss.handleUpgrade>[1], head: Buffer): void => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== RELAY_PATH) {
      socket.write(REFUSED);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.close(RELAY_CLOSE_POLICY, RELAY_NOT_BUILT);
    });
  };
  server.on('upgrade', onUpgrade);
  return {
    close() {
      server.off('upgrade', onUpgrade);
      wss.close();
    },
  };
}
