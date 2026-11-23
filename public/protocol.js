export const PROTOCOL = 'cwep';
export const VERSION = '1.0';

export const plugin = { id: 'cwep-lozza-example', name: 'CWEP Lozza Example', version: '1.0.0' };
export const engineInfo = { name: 'Lozza', version: '11.0' };
export const features = { analysis: true, multiPv: true, moves: true, cancellation: true, setOptions: true };
export const limits = {
  depth: { min: 1, max: 30 },
  movetimeMs: { min: 1, max: 10000 },
  multiPv: { min: 1, max: 4 },
};
export const options = {
  hashMb: { key: 'hashMb', type: 'integer', min: 1, max: 16, default: 16 },
  multiPv: { key: 'multiPv', type: 'integer', ...limits.multiPv, default: 1 },
};

const MAX_MESSAGE_LENGTH = 64 * 1024;

export function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function integerInRange(value, { min, max }, name) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail('INVALID_PAYLOAD', `${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function readRequest(input, context) {
  if (typeof input === 'string') {
    if (input.length > MAX_MESSAGE_LENGTH) fail('INVALID_PAYLOAD', 'CWEP message is too large');
    try {
      input = JSON.parse(input);
    } catch {
      fail('INVALID_PAYLOAD', 'Invalid JSON');
    }
  }
  if (!isObject(input)) fail('INVALID_PAYLOAD', 'Expected a CWEP message object');
  if (input.requestId !== undefined) {
    if (typeof input.requestId !== 'string' || input.requestId.length === 0 || input.requestId.length > MAX_MESSAGE_LENGTH) {
      fail('INVALID_PAYLOAD', 'Expected a nonempty requestId within the message size limit');
    }
    context.requestId = input.requestId;
  }
  if (input.protocol !== PROTOCOL) fail('UNSUPPORTED_PROTOCOL', 'Expected protocol cwep');
  if (input.version !== VERSION) fail('UNSUPPORTED_VERSION', 'Supported CWEP version is 1.0');
  if (typeof input.type !== 'string' || !isObject(input.payload)) {
    fail('INVALID_PAYLOAD', 'Expected a type string and a payload object');
  }

  let size;
  try {
    size = JSON.stringify(input).length;
  } catch {
    fail('INVALID_PAYLOAD', 'Expected a JSON-serializable message');
  }
  if (size > MAX_MESSAGE_LENGTH) fail('INVALID_PAYLOAD', 'CWEP message is too large');
  return input;
}
