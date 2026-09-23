import type { Server } from 'node:http';
import type { Clock } from '../clock.js';

export interface ShutdownResult {
  forced: boolean;
}

export interface CloseablePool {
  end(): Promise<void>;
}

export interface StoppableRunner {
  stop(): void;
}

async function waitWithinDeadline(
  operation: Promise<void>,
  deadline: number,
  clock: Clock,
): Promise<boolean> {
  const remainingMs = Math.max(0, deadline - clock.monotonicNow());

  return new Promise((resolve) => {
    let settled = false;
    const timeoutHandle = clock.setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, remainingMs);

    void operation.then(
      () => {
        if (!settled) {
          settled = true;
          clock.clearTimeout(timeoutHandle);
          resolve(true);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clock.clearTimeout(timeoutHandle);
          resolve(false);
        }
      },
    );
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export async function shutdownInfrastructure(options: {
  clock: Clock;
  pools: readonly CloseablePool[];
  runner: StoppableRunner;
  server: Server;
  timeoutMs: number;
}): Promise<ShutdownResult> {
  const { clock, pools, runner, server, timeoutMs } = options;
  runner.stop();
  const deadline = clock.monotonicNow() + timeoutMs;
  let forced = false;

  if (!(await waitWithinDeadline(closeServer(server), deadline, clock))) {
    forced = true;
    server.closeAllConnections();
  }

  if (!(await waitWithinDeadline(Promise.all(pools.map((pool) => pool.end())).then(() => undefined), deadline, clock))) {
    forced = true;
  }

  return { forced };
}
