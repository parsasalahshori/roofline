import { describe, expect, test } from 'vitest';
import { dockerProblem, nodeProblem, portProblem } from '../demo-preflight.ts';

describe('demo preflight', () => {
  test('Node 22.13 and newer pass; older versions get a fix-it message', () => {
    expect(nodeProblem('v22.13.0')).toBeNull();
    expect(nodeProblem('v22.22.0')).toBeNull();
    expect(nodeProblem('v24.1.0')).toBeNull();
    expect(nodeProblem('v22.12.9')).toContain('.nvmrc');
    expect(nodeProblem('v20.19.0')).toContain('Node 22.13.0 or newer');
  });

  test('Docker and port messages say how to fix it', () => {
    expect(dockerProblem('darwin')).toContain('Docker Desktop');
    expect(dockerProblem('linux')).toContain('dockerd');
    expect(portProblem(4500, 'DEMO_PORT')).toContain('DEMO_PORT=<port> npm run demo');
  });
});
