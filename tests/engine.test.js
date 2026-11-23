import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import { createAdapter } from '../public/adapter.js';

const LOZZA = new URL('../public/lozza/lozza11.0.js', import.meta.url);
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

test('Lozza release script and original licence match the pinned upstream bytes', async () => {
  for (const [file, sha256] of [
    [LOZZA, '36feb6a0614fd66148d454131371bd2e5d78d326c3cd10aca0e26483b3d213e1'],
    [new URL('LICENCE', LOZZA), 'c2305a862f8c9260429dd977a790371a1c5564e0f3151be8bf8bfc9e74e9b249'],
  ]) {
    assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), sha256);
  }
});

function realEngine(t) {
  const events = new EventEmitter();
  const responses = [];
  const output = [];
  const commands = [];
  let workers = 0;
  const adapter = createAdapter({
    // Run the exact release in a worker global with no Node process, as in a classic Web Worker.
    createWorker: () => {
      workers++;
      const worker = new Worker(`
        const { readFileSync } = require('node:fs');
        const { runInNewContext } = require('node:vm');
        const { MessageChannel, parentPort, workerData } = require('node:worker_threads');
        const globals = { MessageChannel, atob, performance, console, postMessage: data => parentPort.postMessage(data) };
        runInNewContext(readFileSync(workerData, 'utf8'), globals, { filename: workerData });
        parentPort.on('message', data => globals.onmessage({ data }));
      `, { eval: true, workerData: fileURLToPath(LOZZA) });
      const endpoint = {
        postMessage(command) {
          commands.push(command);
          worker.postMessage(command);
        },
        terminate() { return worker.terminate(); },
      };
      worker.on('message', data => {
        output.push(data.trim());
        endpoint.onmessage?.({ data });
      });
      worker.on('error', error => endpoint.onerror?.(error));
      return endpoint;
    },
    publish(message) {
      responses.push(message);
      events.emit(`${message.type}:${message.requestId}`, message);
    },
  });
  t.after(adapter.suspend);
  function send(type, requestId, payload = {}) {
    adapter.receive({ protocol: 'cwep', version: '1.0', type, requestId, payload });
  }
  function waitFor(type, id) {
    return once(events, `${type}:${id}`, { signal: AbortSignal.timeout(8000) }).then(([message]) => message);
  }

  return {
    send, waitFor, responses, output, commands,
    get workerCount() { return workers; },
    async run(id, payload) {
      const result = waitFor('analysisComplete', id);
      send('startAnalysis', id, payload);
      return (await result).payload;
    },
  };
}

function verifyAgainstTranscript(updates, best, output) {
  const raw = output.flatMap(line => {
    const match = /^info depth (\d+) (?:.*\s)?score (cp|mate) (-?\d+) .*\bpv (.+)$/.exec(line);
    if (!match) return [];
    const [, depth, kind, value, pv] = match;
    const rank = /\bmultipv (\d+)\b/.exec(line)?.[1] ?? '1';
    return [{ rank: Number(rank), depth: Number(depth), score: { kind, value: Number(value), pov: 'sideToMove' }, pv: pv.split(' ') }];
  });
  const visible = new Map();
  for (const { payload } of updates) {
    for (const line of payload.lines ?? [{ rank: payload.multipv, depth: payload.depth, score: payload.score, pv: payload.pv }]) {
      assert.ok(raw.some(r => JSON.stringify(r) === JSON.stringify(line)), `no matching original UCI line for ${JSON.stringify(line)}`);
      visible.set(line.rank, line.pv[0]);
    }
    assert.equal(new Set(visible.values()).size, visible.size);
  }
  if (best.bestMove) assert.ok(output.includes(`bestmove ${best.bestMove}`));
  if (best.final.score !== null) {
    assert.ok(raw.some(line => line.rank === 1 && line.pv[0] === best.bestMove
      && JSON.stringify(line.pv) === JSON.stringify(best.final.pv)
      && JSON.stringify(line.score) === JSON.stringify(best.final.score)));
  }
  return visible;
}

test('actual Lozza emits four genuine ranks, preserves signed results and reuses the worker across limits', { timeout: 15000 }, async t => {
  const engine = realEngine(t);
  const cases = [
    ['depth', START, { limits: { depth: 8 }, multiPv: 4 }, 'go depth 8'],
    ['time', START, { limits: { movetimeMs: 70 } }, 'go movetime 70'],
    ['combined', START, { limits: { depth: 30, movetimeMs: 70 }, multiPv: 2 }, 'go depth 30 movetime 70'],
    ['mate', '7k/8/5KQ1/8/8/8/8/8 w - - 0 1', { limits: { depth: 2, movetimeMs: 1000 } }, 'go depth 2 movetime 1000'],
    ['one', 'k7/8/2K5/8/8/8/8/1R6 b - - 0 1', { limits: { depth: 4 }, multiPv: 4 }, 'go depth 4'],
    ['terminal', '7k/6Q1/6K1/8/8/8/8/8 b - - 0 1', { limits: { depth: 3 } }, 'go depth 3'],
  ];
  for (const [id, fen, request, command] of cases) {
    const begin = engine.output.length;
    engine.send('setPosition', 'position', { fen });
    const result = await engine.run(id, request);
    const updates = engine.responses.filter(m => m.requestId === id && m.type === 'analysisUpdate');
    const ranks = verifyAgainstTranscript(updates, result, engine.output.slice(begin));
    assert.equal(result.stoppedBy, 'limit');
    assert.equal(engine.commands.at(-1), command);
    if (id === 'depth') assert.deepEqual([...ranks.keys()].sort(), [1, 2, 3, 4]);
    if (id === 'mate') assert.deepEqual(result.final.score, { kind: 'mate', value: 1, pov: 'sideToMove' });
    if (id === 'one') {
      assert.deepEqual([...ranks], [[1, 'a8a7']]);
      assert.ok(result.final.score.value < 0);
    }
    if (id === 'terminal') {
      assert.equal(updates.length, 0);
      assert.equal(result.bestMove, null);
      assert.equal(result.final.score, null);
      assert.equal(engine.output.at(-1), 'bestmove NULL');
    }
  }
  assert.equal(engine.workerCount, 1);
  assert.equal(engine.commands.filter(command => command.startsWith('go ')).length, cases.length);
  assert.equal(engine.responses.some(m => m.type === 'error'), false);
});

test('actually interrupts a Lozza worker and starts another search on the same position', { timeout: 15000 }, async t => {
  const engine = realEngine(t);
  engine.send('setPosition', 'position', { fen: START, moves: ['e2e4', 'e7e5', 'g1f3'] });
  const firstUpdate = engine.waitFor('analysisUpdate', 'stop-me');
  const interrupted = engine.run('stop-me', { limits: { depth: 30 } });
  const update = await firstUpdate;
  engine.send('stopAnalysis', 'stop-command', { analysisRequestId: 'stop-me' });
  const cancelled = await interrupted;
  assert.equal(cancelled.stoppedBy, 'stop');
  assert.equal(cancelled.bestMove, update.payload.pv[0]);
  const second = await engine.run('retry', { limits: { depth: 4 } });
  assert.equal(second.stoppedBy, 'limit');
  assert.ok(second.bestMove);
  assert.equal(engine.workerCount, 2);
  const stopEvents = engine.responses.filter(m => m.requestId === 'stop-me');
  assert.equal(stopEvents.at(-1).type, 'analysisComplete');
  assert.equal(stopEvents.filter(m => m.type === 'analysisComplete').length, 1);
});
