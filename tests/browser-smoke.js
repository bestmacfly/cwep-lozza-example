const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const messages = [];
const inbox = new EventTarget();

function accept(message) {
  messages.push(message);
  inbox.dispatchEvent(new CustomEvent('response', { detail: message }));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function waitForResponse(requestId, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      inbox.removeEventListener('response', listen);
      reject(new Error(`No ${type} for ${requestId}`));
    }, 5000);
    function listen({ detail: message }) {
      if (message.requestId !== requestId || (message.type !== type && message.type !== 'error')) return;
      inbox.removeEventListener('response', listen);
      clearTimeout(timer);
      if (message.type === type) resolve(message.payload);
      else reject(new Error(message.payload.message));
    }
    inbox.addEventListener('response', listen);
  });
}

async function loadPlugin() {
  const frame = document.querySelector('iframe');
  if (typeof frame.contentWindow.cwepReceiveMessage !== 'function') {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Plugin page did not load')), 5000);
      frame.addEventListener('load', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
  assert(typeof frame.contentWindow.cwepReceiveMessage === 'function', 'Missing CWEP receiver');
  return frame.contentWindow;
}

async function run() {
  const page = await loadPlugin();
  const native = Boolean(page.webkit?.messageHandlers?.cwep);
  if (native) window.acceptCwepSmokeMessage = accept;
  else page.addEventListener('cwep-message', ({ detail }) => accept(detail));

  function send(type, requestId, payload = {}) {
    page.cwepReceiveMessage({ protocol: 'cwep', version: '1.0', type, requestId, payload });
  }
  function request(type, requestId, response, payload) {
    const result = waitForResponse(requestId, response);
    send(type, requestId, payload);
    return result;
  }

  const hello = await request('hello', 'hello', 'helloAck');
  assert(hello.plugin.id === 'cwep-lozza-example' && hello.engine.version === '11.0', 'Unexpected engine identity');
  const caps = await request('getCapabilities', 'caps', 'capabilities');
  assert(caps.features.analysis && caps.features.moves && caps.features.cancellation, 'Missing capabilities');
  await request('setPosition', 'invalid', 'error', { fen: 'invalid' });
  send('setPosition', 'initial', { fen: START });

  const multi = await request('startAnalysis', 'multi', 'analysisComplete', { limits: { depth: 8 }, multiPv: 4 });
  assert(multi.stoppedBy === 'limit' && multi.bestMove, 'MultiPV search did not complete');
  const ranks = new Map();
  for (const message of messages) {
    if (message.requestId !== 'multi' || message.type !== 'analysisUpdate') continue;
    for (const line of message.payload.lines ?? []) {
      assert(line.score.pov === 'sideToMove' && line.pv.length > 0, 'Incomplete PV');
      ranks.set(line.rank, line.pv[0]);
    }
    assert(ranks.size === new Set(ranks.values()).size, 'Duplicate root move in displayed ranks');
  }
  assert(ranks.size === 4, 'Expected four distinct native lines');

  send('setPosition', 'after-moves', { fen: START, moves: ['e2e4', 'e7e5', 'g1f3'] });
  const timed = await request('startAnalysis', 'timed', 'analysisComplete', { limits: { movetimeMs: 80 } });
  assert(timed.stoppedBy === 'limit' && timed.bestMove, 'Timed search did not complete');

  const firstUpdate = waitForResponse('long', 'analysisUpdate');
  const stopped = request('startAnalysis', 'long', 'analysisComplete', { limits: { depth: 30 } });
  await firstUpdate;
  send('stopAnalysis', 'stop', { analysisRequestId: 'long' });
  assert((await stopped).stoppedBy === 'stop', 'Active search was not stopped');

  send('setPosition', 'mate-pos', { fen: '7k/8/5KQ1/8/8/8/8/8 w - - 0 1' });
  const mate = await request('startAnalysis', 'mate', 'analysisComplete', { limits: { depth: 2, movetimeMs: 1000 } });
  assert(mate.bestMove === 'g6g7' && mate.final.score.kind === 'mate' && mate.final.score.value === 1, 'Wrong mate result');
  const doneIds = messages.filter(m => m.type === 'analysisComplete').map(m => m.requestId);
  assert(doneIds.join(',') === 'multi,timed,long,mate', 'Every search must complete once in order');
  assert(messages.filter(m => m.requestId === 'long').at(-1).type === 'analysisComplete', 'Update after cancellation');

  return { ok: true, transport: native ? 'WKWebView' : 'browser event', ranks: ranks.size, bestMove: multi.bestMove, mate: mate.final.score.value };
}

let result;
try {
  result = await run();
} catch (error) {
  result = { ok: false, message: error.message };
}
window.cwepSmokeResult = result;
document.querySelector('#result').textContent = JSON.stringify(result, null, 2);
window.webkit?.messageHandlers?.smokeResult?.postMessage(result);
