import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createAdapter } from '../public/adapter.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const SECOND = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

function fixture() {
  const messages = [];
  const workers = [];
  const timers = new Map();
  let nextTimer = 0;
  const harness = {
    workers, messages, timers,
    send(type, requestId, payload = {}) {
      adapter.receive({ protocol: 'cwep', version: '1.0', type, requestId, payload });
    },
    load() {
      const worker = workers.at(-1);
      worker.line('uciok');
      worker.line('readyok');
      return worker;
    },
    fire(delay) {
      const [timer, callback] = [...timers].find(([, item]) => item.delay === delay) ?? [];
      assert.ok(callback, `expected a ${delay} ms timer`);
      timers.delete(timer);
      callback.run();
    },
  };
  const adapter = createAdapter({
    publish: message => {
      messages.push(message);
      harness.onMessage?.(message);
    },
    createWorker: () => {
      if (harness.rejectWorker) throw new Error('unavailable');
      const worker = {
        commands: [], terminated: false,
        postMessage(command) {
          if (this.rejectCommand) throw new Error('unavailable');
          this.commands.push(command);
        },
        terminate() { this.terminated = true; },
        line(data) { this.onmessage?.({ data }); },
      };
      workers.push(worker);
      return worker;
    },
    setTimer: (run, delay) => {
      const id = ++nextTimer;
      timers.set(id, { run, delay });
      return id;
    },
    clearTimer: id => timers.delete(id),
  });
  return Object.assign(harness, adapter);
}

function score(kind, value) {
  return { kind, value, pov: 'sideToMove' };
}

test('discovery is immediate, matches the manifest and validates CWEP envelopes', async () => {
  const h = fixture();
  h.receive(JSON.stringify({ protocol: 'cwep', version: '1.0', type: 'hello', requestId: 'hello', payload: { extension: 7 } }));
  h.send('getCapabilities', 'caps', { unknown: true });
  const [hello, caps] = h.messages;
  const manifest = JSON.parse(await readFile(new URL('../public/manifest.json', import.meta.url), 'utf8'));
  assert.equal(hello.type, 'helloAck');
  assert.equal(hello.requestId, 'hello');
  assert.deepEqual(hello.payload.plugin, manifest.plugin);
  assert.deepEqual(hello.payload.engine, manifest.engine);
  assert.deepEqual(hello.payload.supportedVersions, ['1.0']);
  assert.deepEqual(caps.payload.features, manifest.features);
  assert.deepEqual(caps.payload.limits.multiPv, { min: 1, max: 4 });
  assert.equal(h.workers.length, 0);

  h.receive({ protocol: 'cewp', version: '1.0', type: 'hello', requestId: 'marker', payload: {} });
  h.receive({ protocol: 'cwep', version: '1.1', type: 'hello', requestId: 'version', payload: {} });
  h.receive('{');
  h.send('hello', 'host', { host: { name: 1 } });
  h.send('hello', 'payload', null);
  h.send('unknown', 'type');
  assert.deepEqual(h.messages.slice(2).map(m => [m.version, m.requestId, m.payload.code]), [
    ['1.0', 'marker', 'UNSUPPORTED_PROTOCOL'], ['1.0', 'version', 'UNSUPPORTED_VERSION'],
    ['1.0', undefined, 'INVALID_PAYLOAD'], ['1.0', 'host', 'INVALID_PAYLOAD'],
    ['1.0', 'payload', 'INVALID_PAYLOAD'], ['1.0', 'type', 'UNSUPPORTED_MESSAGE'],
  ]);
});

test('sends the full unchanged FEN and legal history after the UCI handshake', () => {
  const h = fixture();
  const fen = START.replace('0 1', '42 21');
  const moves = ['e2e4', 'e7e5', 'g1f3'];
  h.send('setPosition', 'pos', { fen, moves });
  moves[0] = 'a2a3';
  h.send('startAnalysis', 'go', { limits: { depth: 8 }, multiPv: 4 });
  const [worker] = h.workers;
  assert.deepEqual(worker.commands, ['uci']);
  worker.line('id name Lozza 11.0\r\nuciok ');
  assert.deepEqual(worker.commands, [
    'uci', 'setoption name Hash value 16', 'setoption name MultiPV value 4',
    `position fen ${fen} moves e2e4 e7e5 g1f3`, 'isready',
  ]);
  worker.line('readyok');
  assert.equal(worker.commands.at(-1), 'go depth 8');
  assert.equal(h.messages.length, 0);
});

test('position validation accepts special moves and rejects malformed or illegal input transactionally', () => {
  const h = fixture();
  h.send('startAnalysis', 'no-fen');
  assert.equal(h.messages.at(-1).payload.code, 'INVALID_POSITION');

  for (const [fen, moves] of [
    ['r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 3 27', ['e1g1', 'e8c8']],
    ['4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 45', ['e5d6']],
    ['7k/P7/8/8/8/8/8/7K w - - 99 100', ['a7a8n']],
  ]) {
    h.send('setPosition', 'special', { fen, moves });
    assert.equal(h.messages.length, 1);
  }
  h.send('setPosition', 'ok', { fen: SECOND });
  h.send('startAnalysis', 'running', { limits: { depth: 12 } });
  const worker = h.load();

  const rejected = [
    [{ fen: `${START}\nstop` }, 'INVALID_FEN'],
    [{ fen: START.replace('0 1', '0x 1') }, 'INVALID_FEN'],
    [{ fen: START.replace('0 1', '0 0') }, 'INVALID_FEN'],
    [{ fen: '4k3/8/8/8/8/8/8/4K3 w K - 0 1' }, 'INVALID_FEN'],
    [{ fen: '4k3/8/8/8/8/8/8/4K3 w - e6 0 1' }, 'INVALID_FEN'],
    [{ fen: '4k3/8/8/8/8/8/4Q3/4K3 w - - 0 1' }, 'INVALID_FEN'],
    [{ fen: START, moves: null }, 'INVALID_PAYLOAD'],
    [{ fen: START, moves: Array(513).fill('e2e4') }, 'INVALID_PAYLOAD'],
    [{ fen: START, moves: ['e2e4\n'] }, 'INVALID_MOVE'],
    [{ fen: START, moves: ['e2e4q'] }, 'INVALID_MOVE'],
    [{ fen: START, moves: ['e2e4', 'e2e3'] }, 'INVALID_MOVE'],
  ];
  for (const [payload, code] of rejected) {
    h.send('setPosition', 'bad-fen', payload);
    assert.equal(h.messages.at(-1).requestId, 'bad-fen');
    assert.equal(h.messages.at(-1).payload.code, code);
  }
  assert.equal(worker.terminated, false);
  assert.equal(h.messages.some(m => m.type === 'analysisComplete'), false);
  worker.line('bestmove e7e5');
  h.send('startAnalysis', 'again', { limits: { depth: 1 } });
  assert.equal(worker.commands.at(-2), `position fen ${SECOND}`);
});

test('passes each explicit limit independently and defaults only when both are absent', () => {
  const h = fixture();
  h.send('setPosition', 'pos', { fen: START });
  for (const [i, payload, command, delay] of [
    [0, { limits: { depth: 30 } }, 'go depth 30', 30000],
    [1, { limits: { movetimeMs: 10000 } }, 'go movetime 10000', 11000],
    [2, { limits: { depth: 16, movetimeMs: 250 } }, 'go depth 16 movetime 250', 1250],
    [3, { limits: {} }, 'go movetime 1000', 2000],
    [4, {}, 'go movetime 1000', 2000],
  ]) {
    h.send('startAnalysis', `go-${i}`, payload);
    const worker = i === 0 ? h.load() : h.workers[0];
    if (i !== 0) worker.line('readyok');
    assert.equal(worker.commands.at(-1), command);
    assert.deepEqual([...h.timers.values()].map(t => t.delay), [delay]);
    worker.line('bestmove g1f3');
    assert.equal(h.timers.size, 0);
  }
  assert.equal(h.workers.length, 1);
  assert.deepEqual(h.messages.map(m => m.payload.stoppedBy), Array(5).fill('limit'));
});

test('single-PV updates and completion preserve signed cp, mate, bounds and the entire PV', () => {
  const h = fixture();
  h.send('setPosition', 'pos', { fen: SECOND });
  h.send('startAnalysis', 'go', { limits: { depth: 14 } });
  const worker = h.load();
  worker.line('info string depth 2 score cp 540 pv e7e5');
  worker.line('info depth 2 score upperbound 42 pv e7e5');
  worker.line('info depth 2 score cp 42 pv e7e5 bogus g1f3');
  worker.line('info depth 3 score cp -17 lowerbound nodes 90 pv e7e5 g1f3');
  worker.line('info depth 8 score mate -3 nodes 90 pv g8f6 d2d4');
  worker.line('bestmove g8f6');
  worker.line('info depth 9 score mate 1 pv e7e5');
  assert.deepEqual(h.messages.map(m => [m.type, m.requestId, m.payload]), [
    ['analysisUpdate', 'go', { depth: 3, multipv: 1, score: { ...score('cp', -17), bound: 'lower' }, pv: ['e7e5', 'g1f3'], bestMove: 'e7e5' }],
    ['analysisUpdate', 'go', { depth: 8, multipv: 1, score: score('mate', -3), pv: ['g8f6', 'd2d4'], bestMove: 'g8f6' }],
    ['analysisComplete', 'go', { bestMove: 'g8f6', final: { bestMove: 'g8f6', score: score('mate', -3), pv: ['g8f6', 'd2d4'] }, stoppedBy: 'limit' }],
  ]);
});

test('MultiPV suppresses duplicate starts without rewriting ranks, moves, depths or scores', () => {
  const h = fixture();
  h.send('setPosition', 'pos', { fen: START });
  h.send('startAnalysis', 'multi', { limits: { depth: 12 }, multiPv: 4 });
  const worker = h.load();
  worker.line('info depth 3 multipv 1 score cp 32 pv e2e4 e7e5 b1c3');
  worker.line('info depth 3 multipv 2 score cp 23 pv d2d4 g8f6 g1f3');
  worker.line('info depth 3 multipv 3 score cp 38 pv d2d4 g8f6');
  worker.line('info depth 3 multipv 4 score cp 21 pv c2c4 e7e5');
  assert.deepEqual(h.messages[0].payload.lines, [
    { rank: 1, depth: 3, score: score('cp', 32), pv: ['e2e4', 'e7e5', 'b1c3'] },
    { rank: 2, depth: 3, score: score('cp', 23), pv: ['d2d4', 'g8f6', 'g1f3'] },
    { rank: 4, depth: 3, score: score('cp', 21), pv: ['c2c4', 'e7e5'] },
  ]);

  // A partial group that would duplicate the cached fourth rank is withheld as a whole.
  worker.line('info depth 4 multipv 1 score cp 58 pv c2c4 c7c5');
  worker.line('info depth 5 multipv 1 score cp 41 pv g1f3 g8f6');
  worker.line('info depth 5 multipv 2 score cp 38 pv e2e4 e7e5');
  worker.line('info depth 5 multipv 3 score cp 23 pv d2d4 d7d5');
  worker.line('info depth 5 multipv 4 score cp 20 pv c2c4 c7c5');
  worker.line('bestmove g1f3');
  assert.equal(h.messages.length, 3);
  assert.deepEqual(h.messages[1].payload.lines.map(line => [line.rank, line.score.value, line.pv[0]]), [
    [1, 41, 'g1f3'], [2, 38, 'e2e4'], [3, 23, 'd2d4'], [4, 20, 'c2c4'],
  ]);
  assert.deepEqual(h.messages[2].payload.final, { bestMove: 'g1f3', score: score('cp', 41), pv: ['g1f3', 'g8f6'] });
  assert.equal(worker.commands.filter(cmd => cmd.startsWith('go')).length, 1);
});

test('finishes partial batches and never borrows the score of another rank or move', () => {
  const h = fixture();
  h.send('setPosition', 'pos', { fen: START });
  h.send('startAnalysis', 'partial', { multiPv: 4 });
  const worker = h.load();
  worker.line('info depth 4 multipv 1 score cp 24 pv e2e4');
  worker.line('info depth 4 multipv 2 score cp 20 pv g1f3');
  worker.line('bestmove g1f3');
  assert.deepEqual(h.messages[0].payload.lines.map(line => line.rank), [1, 2]);
  assert.deepEqual(h.messages[1].payload.final, { bestMove: 'g1f3', score: null, pv: [] });
});

test('all supported terminal UCI markers translate to null without an invented score or PV', () => {
  const h = fixture();
  h.send('setPosition', 'pos', { fen: '7k/6Q1/6K1/8/8/8/8/8 b - - 0 1' });
  for (const marker of ['NULL', '0000', '(none)']) {
    h.send('startAnalysis', marker);
    const [worker] = h.workers;
    if (marker === 'NULL') worker.line('uciok');
    worker.line(`readyok\nbestmove ${marker}\n`);
  }
  assert.equal(h.messages.length, 3);
  for (const { payload } of h.messages) {
    assert.deepEqual(payload, { bestMove: null, final: { bestMove: null, score: null, pv: [] }, stoppedBy: 'limit' });
  }
});

test('stop cancels cold initialization, and old worker messages cannot cross into the next request', () => {
  const h = fixture();
  h.send('setPosition', 'pos', { fen: START });
  h.send('startAnalysis', 'first');
  const [firstWorker] = h.workers;
  const oldOnMessage = firstWorker.onmessage;
  h.send('stopAnalysis', 'stop', { analysisRequestId: 'first' });
  assert.ok(firstWorker.terminated);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.messages.map(m => [m.requestId, m.type, m.payload.stoppedBy]), [['first', 'analysisComplete', 'stop']]);

  h.send('startAnalysis', 'second', { multiPv: 4 });
  const secondWorker = h.load();
  oldOnMessage({ data: 'uciok\nreadyok\ninfo depth 2 score cp 20 pv e2e4\nbestmove e2e4' });
  assert.equal(h.messages.length, 1);
  secondWorker.line('info depth 2 multipv 1 score cp -12 pv d2d4');
  h.send('stopAnalysis', 'other-target', { analysisRequestId: 'no-such-job' });
  assert.equal(h.messages.at(-1).payload.code, 'INVALID_REQUEST');
  h.send('stopAnalysis', 'current');
  assert.deepEqual(h.messages.at(-1).payload, {
    bestMove: 'd2d4', final: { bestMove: 'd2d4', score: score('cp', -12), pv: ['d2d4'] }, stoppedBy: 'stop',
  });
  assert.ok(secondWorker.terminated);
  h.send('stopAnalysis', 'idle');
  assert.equal(h.messages.length, 3);
});

test('invalid limits and IDs preserve a running job, and replacement and position change complete it first', () => {
  const h = fixture();
  h.send('setPosition', 'pos', { fen: START });
  h.send('startAnalysis', 'old', { limits: { depth: 30 } });
  const worker = h.load();
  for (const limits of [null, [], { depth: 31 }, { depth: '18' }, { movetimeMs: 0 }, { movetimeMs: 10001 }]) {
    h.send('startAnalysis', 'bad', { limits });
    assert.equal(h.messages.at(-1).payload.code, 'INVALID_PAYLOAD');
  }
  h.send('startAnalysis', 'bad', { multiPv: null });
  assert.equal(h.messages.at(-1).payload.code, 'INVALID_PAYLOAD');
  h.send('startAnalysis', 'bad', { multiPv: 5 });
  assert.equal(h.messages.at(-1).payload.code, 'INVALID_PAYLOAD');
  h.send('startAnalysis', 'old');
  assert.equal(h.messages.at(-1).payload.code, 'INVALID_REQUEST');
  assert.equal(worker.terminated, false);
  assert.equal(h.messages.some(m => m.type === 'analysisComplete'), false);

  h.send('startAnalysis', 'new');
  assert.equal(h.messages.at(-1).requestId, 'old');
  assert.equal(h.messages.at(-1).payload.stoppedBy, 'replaced');
  h.send('setPosition', 'other', { fen: SECOND });
  assert.equal(h.messages.at(-1).requestId, 'new');
  assert.equal(h.messages.at(-1).payload.stoppedBy, 'positionChanged');
  assert.ok(h.workers.every(w => w.terminated));
});

test('option changes are atomic and warm workers apply only changed values', () => {
  const h = fixture();
  h.send('setPosition', 'pos', { fen: START });
  h.send('setOptions', 'bad-opt', { options: { hashMb: 2, threads: 2 } });
  assert.equal(h.messages.at(-1).payload.code, 'UNSUPPORTED_OPTION');
  h.send('startAnalysis', 'from-default');
  const worker = h.load();
  assert.ok(worker.commands.includes('setoption name Hash value 16'));
  h.send('setOptions', 'busy', { options: { hashMb: 2 } });
  assert.equal(h.messages.at(-1).payload.code, 'BUSY');
  worker.line('bestmove e2e4');

  h.send('setOptions', 'settings', { options: { hashMb: 4, multiPv: 2 } });
  h.send('startAnalysis', 'from-settings');
  worker.line('readyok');
  assert.deepEqual(worker.commands.slice(-5), [
    'setoption name Hash value 4', 'setoption name MultiPV value 2',
    `position fen ${START}`, 'isready', 'go movetime 1000',
  ]);
  worker.line('bestmove e2e4');
  h.send('startAnalysis', 'override', { multiPv: 1 });
  assert.deepEqual(worker.commands.slice(-3), [
    'setoption name MultiPV value 1', `position fen ${START}`, 'isready',
  ]);
});

test('timeouts and worker errors complete accepted requests once and permit a fresh worker', () => {
  const h = fixture();
  h.send('setPosition', 'pos', { fen: START });
  h.send('startAnalysis', 'cold-timeout');
  h.fire(15000);
  h.send('startAnalysis', 'reply-timeout', { limits: { movetimeMs: 700 } });
  h.load();
  h.fire(1700);
  h.rejectWorker = true;
  h.send('startAnalysis', 'construction-error');
  h.rejectWorker = false;
  h.send('startAnalysis', 'runtime-error');
  const worker = h.load();
  worker.onerror({ preventDefault() {} });
  assert.deepEqual(h.messages.map(m => [m.requestId, m.type, m.payload.code ?? m.payload.stoppedBy]), [
    ['cold-timeout', 'error', 'ENGINE_TIMEOUT'], ['cold-timeout', 'analysisComplete', 'timeout'],
    ['reply-timeout', 'error', 'ENGINE_TIMEOUT'], ['reply-timeout', 'analysisComplete', 'timeout'],
    ['construction-error', 'error', 'ENGINE_UNAVAILABLE'], ['construction-error', 'analysisComplete', 'error'],
    ['runtime-error', 'error', 'ENGINE_UNAVAILABLE'], ['runtime-error', 'analysisComplete', 'error'],
  ]);
  assert.equal(h.timers.size, 0);
  assert.ok(h.workers.every(w => w.terminated));
  h.send('startAnalysis', 'retry');
  h.load().line('bestmove e2e4');
  assert.equal(h.messages.at(-1).payload.stoppedBy, 'limit');
});

test('depth-only searches continue after a quiet period when Lozza still responds', () => {
  const h = fixture();
  h.send('setPosition', 'pos', { fen: START });
  h.send('startAnalysis', 'depth', { limits: { depth: 30 } });
  const worker = h.load();
  h.fire(30000);
  assert.equal(worker.commands.at(-1), 'isready');
  worker.line('info currmove e2e4 currmovenumber 1');
  worker.line('readyok');
  assert.equal(h.messages.length, 0);
  assert.equal(worker.commands.filter(cmd => cmd.startsWith('go')).join(), 'go depth 30');
  assert.deepEqual([...h.timers.values()].map(t => t.delay), [30000]);
  h.fire(30000);
  h.fire(180000);
  assert.equal(h.messages.at(-2).payload.code, 'ENGINE_TIMEOUT');
  assert.equal(h.messages.at(-1).payload.stoppedBy, 'timeout');
});

test('late probe acknowledgments cannot arm the next search, and pagehide releases the worker', () => {
  const h = fixture();
  h.send('setPosition', 'pos', { fen: START });
  h.send('startAnalysis', 'depth', { limits: { depth: 30 } });
  const worker = h.load();
  const lateMessage = worker.onmessage;
  h.fire(30000);
  worker.line('bestmove e2e4');
  assert.ok(worker.terminated);
  h.send('startAnalysis', 'new');
  lateMessage({ data: 'readyok' });
  assert.deepEqual(h.workers.at(-1).commands, ['uci']);
  h.suspend();
  assert.equal(h.messages.at(-1).payload.stoppedBy, 'stop');
  assert.equal(h.timers.size, 0);
  h.send('startAnalysis', 'hidden');
  assert.equal(h.messages.at(-1).payload.code, 'ENGINE_UNAVAILABLE');
  h.resume();
  h.send('startAnalysis', 'visible');
  const idle = h.load();
  idle.line('bestmove e2e4');
  h.suspend();
  assert.ok(idle.terminated);
});

test('reentrant host commands retain wire order and missing analysis IDs are consistent', () => {
  const h = fixture();
  h.send('setPosition', 'pos', { fen: START });
  h.send('startAnalysis', undefined);
  const worker = h.load();
  h.onMessage = ({ type }) => {
    if (type === 'analysisUpdate') h.send('startAnalysis', 'next', { limits: { depth: 3 } });
  };
  worker.line('info depth 2 score cp 33 pv e2e4 e7e5\nbestmove e2e4');
  assert.equal(h.messages[0].type, 'analysisUpdate');
  assert.equal(h.messages[1].type, 'analysisComplete');
  assert.ok(h.messages[0].requestId);
  assert.equal(h.messages[0].requestId, h.messages[1].requestId);
  assert.equal(h.messages[1].payload.stoppedBy, 'limit');
  assert.equal(h.workers.length, 1);
  worker.line('readyok\nbestmove g1f3');
  assert.equal(h.messages[2].requestId, 'next');
});
