import { positionCommand } from './position.js';
import {
  PROTOCOL, VERSION, plugin, engineInfo, features, limits, options,
  fail, integerInRange, isObject, readRequest,
} from './protocol.js';
import { readBestMove, readInfo } from './uci.js';

const DEFAULT_MOVETIME_MS = 1000;
const READY_TIMEOUT_MS = 15000;
const TIMED_REPLY_GRACE_MS = 1000;
const DEPTH_QUIET_MS = 30000;
const DEPTH_PROBE_TIMEOUT_MS = 180000;

export function createAdapter({ createWorker, publish, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let position = null;
  let active = null;
  let worker = null;
  let suspended = false;
  let nextId = 0;
  let settings = { hashMb: options.hashMb.default, multiPv: options.multiPv.default };

  // Browser listeners can send a command synchronously while a response is being published.
  const queue = [];
  let processing = false;
  function enqueue(action) {
    queue.push(action);
    if (processing) return;
    processing = true;
    try {
      while (queue.length) queue.shift()();
    } finally {
      processing = false;
    }
  }

  function emit(context, type, payload) {
    const message = { protocol: PROTOCOL, version: VERSION, type, payload };
    if (context.requestId !== undefined) message.requestId = context.requestId;
    publish(structuredClone(message));
  }

  function clearDeadline(owner) {
    clearTimer(owner.timer);
    owner.timer = undefined;
  }

  function deadline(owner, delay, elapsed) {
    clearDeadline(owner);
    const timer = setTimer(() => enqueue(() => {
      if (worker === owner && owner.timer === timer) elapsed();
    }), delay);
    owner.timer = timer;
  }

  function releaseWorker() {
    const owner = worker;
    worker = null;
    if (!owner) return;
    clearDeadline(owner);
    if (owner.instance) {
      owner.instance.onmessage = null;
      owner.instance.onerror = null;
      owner.instance.onmessageerror = null;
      owner.instance.terminate();
    }
  }

  function finish(job, stoppedBy, bestMove = job.latestPrimary?.bestMove ?? null) {
    active = null;
    // A final score or PV must belong to the reported best move and come from rank 1.
    const line = [job.latestPrimary, job.visibleLines.get(1)].find(
      candidate => candidate && (candidate.bestMove ?? null) === bestMove,
    );
    emit(job, 'analysisComplete', {
      bestMove,
      final: { bestMove, score: line?.score ?? null, pv: line?.pv ?? [] },
      stoppedBy,
    });
  }

  function cancel(stoppedBy) {
    if (!active) return;
    releaseWorker();
    finish(active, stoppedBy);
  }

  function workerFailure(owner, code, message, stoppedBy = 'error') {
    if (worker !== owner) return;
    releaseWorker();
    if (!active) return;
    emit(active, 'error', { code, message, recoverable: true });
    finish(active, stoppedBy);
  }

  function timeout(owner, message) {
    workerFailure(owner, 'ENGINE_TIMEOUT', message, 'timeout');
  }

  function send(owner, command) {
    try {
      owner.instance.postMessage(command);
      return true;
    } catch {
      workerFailure(owner, 'ENGINE_UNAVAILABLE', 'Lozza worker could not receive a UCI command');
      return false;
    }
  }

  function watchDepthSearch(owner) {
    // Only probe after a quiet period. A reply or search output shows that the engine is alive.
    if (owner.probing) {
      deadline(owner, DEPTH_PROBE_TIMEOUT_MS, () => timeout(owner, 'Lozza worker did not respond to a readiness probe'));
    } else {
      deadline(owner, DEPTH_QUIET_MS, () => {
        owner.probing = true;
        if (send(owner, 'isready')) watchDepthSearch(owner);
      });
    }
  }

  function search(owner) {
    owner.phase = 'searching';
    const command = ['go'];
    if (active.depth !== undefined) command.push('depth', active.depth);
    if (active.movetimeMs !== undefined) {
      command.push('movetime', active.movetimeMs);
      deadline(owner, active.movetimeMs + TIMED_REPLY_GRACE_MS, () => timeout(owner, 'Lozza worker did not finish the timed search'));
    } else {
      watchDepthSearch(owner);
    }
    send(owner, command.join(' '));
  }

  function prepare(owner) {
    owner.phase = 'preparing';
    deadline(owner, READY_TIMEOUT_MS, () => timeout(owner, 'Lozza worker did not become ready'));
    if (owner.hashMb !== active.hashMb) {
      if (!send(owner, `setoption name Hash value ${active.hashMb}`)) return;
      owner.hashMb = active.hashMb;
    }
    if (owner.multiPv !== active.multiPv) {
      if (!send(owner, `setoption name MultiPV value ${active.multiPv}`)) return;
      owner.multiPv = active.multiPv;
    }
    if (send(owner, active.position)) send(owner, 'isready');
  }

  function flushMultiPv(job) {
    if (!job.group.length) return;
    const group = job.group;
    job.group = [];
    const roots = new Set();
    const distinct = group.filter(line => {
      if (!line.bestMove) return true;
      if (roots.has(line.bestMove)) return false;
      roots.add(line.bestMove);
      return true;
    });

    // CWEP hosts keep ranks that an update does not mention. Hold the previous display if
    // merging this partial group would replace one rank with a move still visible on another.
    const visible = new Map(job.visibleLines);
    for (const line of distinct) visible.set(line.multipv, line);
    const moves = [...visible.values()].map(line => line.bestMove).filter(Boolean);
    if (new Set(moves).size !== moves.length) return;
    job.visibleLines = visible;

    const lines = distinct.map(({ multipv, depth, score, pv }) => ({ rank: multipv, depth, score, pv }));
    // Mirror rank 1 in the core fields for clients that only display the main line.
    emit(job, 'analysisUpdate', { ...distinct[0], lines });
  }

  function update(job, line) {
    if (line.multipv > job.multiPv) return;
    if (line.multipv === 1) job.latestPrimary = line;
    if (job.multiPv === 1) {
      job.visibleLines.set(1, line);
      emit(job, 'analysisUpdate', line);
      return;
    }

    // Lozza sends the ranks in order, starting every UCI group with rank 1.
    if (line.multipv === 1) flushMultiPv(job);
    if (line.multipv !== (job.group.at(-1)?.multipv ?? 0) + 1) return;
    job.group.push(line);
    if (line.multipv === job.multiPv) flushMultiPv(job);
  }

  function workerLine(owner, text) {
    if (text === 'uciok' && owner.phase === 'starting') {
      prepare(owner);
      return;
    }
    if (text === 'readyok' && owner.phase === 'preparing') {
      search(owner);
      return;
    }
    if (owner.phase !== 'searching') return;

    if (text === 'readyok' && owner.probing) {
      owner.probing = false;
      watchDepthSearch(owner);
      return;
    }
    const tokens = text.split(/\s+/);
    if (tokens[0] === 'info') {
      const line = readInfo(tokens);
      if (active.movetimeMs === undefined && (line || tokens[1] === 'currmove' || tokens[1] === 'depth')) {
        watchDepthSearch(owner);
      }
      if (line) update(active, line);
    } else if (tokens[0] === 'bestmove') {
      const move = readBestMove(tokens[1]);
      if (move === undefined) {
        workerFailure(owner, 'ENGINE_UNAVAILABLE', 'Lozza worker returned an invalid bestmove');
        return;
      }
      // A late readyok from an outstanding search probe must not arm the next search.
      if (owner.probing) releaseWorker();
      else {
        clearDeadline(owner);
        owner.phase = 'idle';
      }
      if (move !== null) flushMultiPv(active);
      finish(active, 'limit', move);
    }
  }

  function startWorker() {
    const owner = { phase: 'starting', probing: false };
    worker = owner;
    try {
      owner.instance = createWorker();
      owner.instance.onmessage = ({ data }) => enqueue(() => {
        if (typeof data !== 'string' || data.length > 16384) return;
        for (const line of data.split(/\r?\n/)) {
          if (worker !== owner) break;
          workerLine(owner, line.trim());
        }
      });
      owner.instance.onerror = event => {
        event.preventDefault?.();
        enqueue(() => workerFailure(owner, 'ENGINE_UNAVAILABLE', 'Lozza worker failed'));
      };
      owner.instance.onmessageerror = () => enqueue(() => workerFailure(owner, 'ENGINE_UNAVAILABLE', 'Lozza worker sent an unreadable message'));
    } catch {
      workerFailure(owner, 'ENGINE_UNAVAILABLE', 'Lozza worker could not be started');
      return;
    }
    deadline(owner, READY_TIMEOUT_MS, () => timeout(owner, 'Lozza worker initialization timed out'));
    send(owner, 'uci');
  }

  function start(context, payload) {
    if (position === null) fail('INVALID_POSITION', 'Set a position before starting analysis');
    if (payload.limits !== undefined && !isObject(payload.limits)) fail('INVALID_PAYLOAD', 'limits must be an object');
    const requested = payload.limits ?? {};
    const depth = requested.depth === undefined ? undefined : integerInRange(requested.depth, limits.depth, 'depth');
    let movetimeMs = requested.movetimeMs === undefined ? undefined : integerInRange(requested.movetimeMs, limits.movetimeMs, 'movetimeMs');
    if (depth === undefined && movetimeMs === undefined) movetimeMs = DEFAULT_MOVETIME_MS;
    const multiPv = payload.multiPv === undefined ? settings.multiPv : integerInRange(payload.multiPv, limits.multiPv, 'multiPv');
    if (suspended) fail('ENGINE_UNAVAILABLE', 'The plugin page is inactive');
    let requestId = context.requestId;
    if (requestId === undefined) {
      do { requestId = `lozza-analysis-${++nextId}`; } while (requestId === active?.requestId);
    } else if (requestId === active?.requestId) {
      fail('INVALID_REQUEST', 'requestId belongs to the active analysis');
    }

    cancel('replaced');
    active = { requestId, position, depth, movetimeMs, multiPv, hashMb: settings.hashMb, visibleLines: new Map(), group: [] };
    if (worker) prepare(worker);
    else startWorker();
  }

  function configure(payload) {
    if (active) fail('BUSY', 'Change options between analyses');
    if (!isObject(payload.options)) fail('INVALID_PAYLOAD', 'options must be an object');
    const next = { ...settings };
    for (const [key, value] of Object.entries(payload.options)) {
      if (!Object.hasOwn(options, key)) fail('UNSUPPORTED_OPTION', `Unsupported engine option: ${key}`);
      next[key] = integerInRange(value, options[key], key);
    }
    settings = next;
  }

  function handle(input) {
    const context = {};
    try {
      const { type, payload } = readRequest(input, context);
      switch (type) {
        case 'hello':
          if (payload.host !== undefined && (!isObject(payload.host)
            || (payload.host.name !== undefined && typeof payload.host.name !== 'string')
            || (payload.host.version !== undefined && typeof payload.host.version !== 'string'))) {
            fail('INVALID_PAYLOAD', 'host must contain string metadata');
          }
          emit(context, 'helloAck', { plugin, supportedVersions: [VERSION], engine: engineInfo });
          break;
        case 'getCapabilities':
          emit(context, 'capabilities', { features, limits, variants: ['standard'], options: Object.values(options) });
          break;
        case 'setPosition': {
          const next = positionCommand(payload);
          cancel('positionChanged');
          position = next;
          break;
        }
        case 'startAnalysis':
          start(context, payload);
          break;
        case 'stopAnalysis':
          if (payload.analysisRequestId !== undefined && payload.analysisRequestId !== active?.requestId) {
            fail('INVALID_REQUEST', 'No matching active analysis');
          }
          cancel('stop');
          break;
        case 'setOptions':
          configure(payload);
          break;
        default:
          fail('UNSUPPORTED_MESSAGE', 'Unknown CWEP message type');
      }
    } catch (error) {
      emit(context, 'error', {
        code: error.code ?? 'INTERNAL_ERROR',
        message: error.code ? error.message : 'CWEP message processing failed',
        recoverable: true,
      });
    }
  }

  return {
    receive: input => enqueue(() => handle(input)),
    suspend: () => enqueue(() => {
      suspended = true;
      if (active) cancel('stop');
      else releaseWorker();
    }),
    resume: () => enqueue(() => { suspended = false; }),
  };
}
