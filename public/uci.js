const COORDINATE_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const NO_MOVE = new Set(['NULL', '0000', '(none)']);

export function isCoordinateMove(move) {
  return typeof move === 'string' && COORDINATE_MOVE.test(move);
}

function readInteger(token) {
  if (typeof token !== 'string' || !/^-?\d+$/.test(token)) return undefined;
  const result = Number(token);
  return Number.isSafeInteger(result) ? result : undefined;
}

export function readInfo(tokens) {
  if (tokens[1] === 'string') return undefined;
  const pvIndex = tokens.indexOf('pv');
  if (pvIndex === -1) return undefined;

  const fields = tokens.slice(1, pvIndex);
  const scoreIndex = fields.indexOf('score');
  if (scoreIndex === -1) return undefined;
  const kind = fields[scoreIndex + 1];
  // Lozza emits some aspiration bounds without a score unit.
  if (kind !== 'cp' && kind !== 'mate') return undefined;
  const value = readInteger(fields[scoreIndex + 2]);
  const depthIndex = fields.indexOf('depth');
  const rankIndex = fields.indexOf('multipv');
  const depth = depthIndex === -1 ? undefined : readInteger(fields[depthIndex + 1]);
  const multipv = rankIndex === -1 ? 1 : readInteger(fields[rankIndex + 1]);
  if (value === undefined || depth === undefined || depth < 0 || multipv === undefined || multipv < 1) {
    return undefined;
  }

  const pv = tokens.slice(pvIndex + 1);
  if (!pv.every(isCoordinateMove)) return undefined;
  const score = { kind, value, pov: 'sideToMove' };
  const bound = fields[scoreIndex + 3];
  if (bound === 'lowerbound') score.bound = 'lower';
  if (bound === 'upperbound') score.bound = 'upper';
  const update = { depth, multipv, score, pv };
  if (pv.length) update.bestMove = pv[0];
  return update;
}

export function readBestMove(move) {
  if (NO_MOVE.has(move)) return null;
  return isCoordinateMove(move) ? move : undefined;
}
