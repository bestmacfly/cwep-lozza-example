import { Chess } from './vendor/chess.js/chess.js';
import { fail } from './protocol.js';
import { isCoordinateMove } from './uci.js';

const MAX_MOVES = 512;
const FEN = /^[prnbqkPRNBQK1-8/]+ [wb] (?:-|[KQkq]{1,4}) (?:-|[a-h][36]) [0-9]+ [0-9]+$/;
const CASTLING = {
  K: ['w', 'e1', 'h1'],
  Q: ['w', 'e1', 'a1'],
  k: ['b', 'e8', 'h8'],
  q: ['b', 'e8', 'a8'],
};

export function positionCommand({ fen, moves = [] }) {
  if (typeof fen !== 'string' || fen.length > 160 || !FEN.test(fen)) {
    fail('INVALID_FEN', 'Expected a six-field standard-chess FEN');
  }
  const [pieces, turn, castling, enPassant] = fen.split(' ');
  if ((pieces.match(/[A-Z]/g)?.length ?? 0) > 16 || (pieces.match(/[a-z]/g)?.length ?? 0) > 16) {
    fail('INVALID_FEN', 'A side cannot have more than 16 pieces');
  }
  if (castling !== '-' && !/^K?Q?k?q?$/.test(castling)) {
    fail('INVALID_FEN', 'Invalid standard castling rights');
  }

  let chess;
  try {
    chess = new Chess(fen);
  } catch {
    fail('INVALID_FEN', 'Invalid standard-chess FEN');
  }
  const previousTurn = turn === 'w' ? 'b' : 'w';
  const [previousKing] = chess.findPiece({ color: previousTurn, type: 'k' });
  if (chess.isAttacked(previousKing, turn)) fail('INVALID_FEN', 'The non-moving king is in check');

  for (const right of castling === '-' ? '' : castling) {
    const [color, kingSquare, rookSquare] = CASTLING[right];
    const king = chess.get(kingSquare);
    const rook = chess.get(rookSquare);
    if (king?.type !== 'k' || king.color !== color || rook?.type !== 'r' || rook.color !== color) {
      fail('INVALID_FEN', 'Castling rights require the king and rook on their original squares');
    }
  }
  if (enPassant !== '-') {
    const pawn = chess.get(`${enPassant[0]}${turn === 'w' ? '5' : '4'}`);
    if (chess.get(enPassant) || pawn?.type !== 'p' || pawn.color !== previousTurn) {
      fail('INVALID_FEN', 'The en passant square must be empty and correspond to an opposing pawn');
    }
  }

  if (!Array.isArray(moves) || moves.length > MAX_MOVES) {
    fail('INVALID_PAYLOAD', `moves must be an array of at most ${MAX_MOVES} coordinate moves`);
  }
  for (const move of moves) {
    if (!isCoordinateMove(move)) fail('INVALID_MOVE', 'Invalid coordinate move');
    let played;
    try {
      played = chess.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
    } catch {
      fail('INVALID_MOVE', `Illegal move in position history: ${move}`);
    }
    if (played.lan !== move) fail('INVALID_MOVE', `Illegal promotion in position history: ${move}`);
  }

  // Keep both original FEN counters and the original history on the UCI wire.
  return `position fen ${fen}${moves.length ? ` moves ${moves.join(' ')}` : ''}`;
}
