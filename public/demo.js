import './bridge.js';
import { PROTOCOL, VERSION } from './protocol.js';

if (!window.webkit?.messageHandlers?.cwep) {
  const demo = document.querySelector('#demo');
  const form = demo.querySelector('form');
  const stop = demo.querySelector('#stop');
  const status = demo.querySelector('#status');
  const result = demo.querySelector('#result');
  const lines = new Map();
  let serial = 0;
  let positionId;
  let activeId;
  let positionError = false;
  let analysisError = false;

  function send(type, requestId, payload = {}) {
    window.cwepReceiveMessage({ protocol: PROTOCOL, version: VERSION, type, requestId, payload });
  }

  window.addEventListener('cwep-message', ({ detail: { type, requestId, payload } }) => {
    if (type === 'error' && requestId === positionId) {
      positionError = true;
      status.textContent = payload.message;
    }
    if (activeId === undefined || requestId !== activeId) return;
    if (type === 'analysisUpdate') {
      for (const line of payload.lines ?? [{ ...payload, rank: payload.multipv ?? 1 }]) {
        lines.set(line.rank, line);
      }
      result.textContent = [...lines.values()].sort((a, b) => a.rank - b.rank).map(line => {
        const { kind, value } = line.score;
        return `${line.rank}. Tiefe ${line.depth} · ${value} ${kind} · ${line.pv.join(' ')}`;
      }).join('\n');
    } else if (type === 'error') {
      analysisError = true;
      status.textContent = payload.message;
    } else if (type === 'analysisComplete') {
      activeId = undefined;
      stop.disabled = true;
      if (analysisError) return;
      if (payload.stoppedBy === 'stop') status.textContent = 'Analyse abgebrochen';
      else status.textContent = payload.bestMove ? `Bester Zug: ${payload.bestMove}` : 'Kein bester Zug verfügbar';
    }
  });

  form.addEventListener('submit', event => {
    event.preventDefault();
    positionError = false;
    positionId = `demo-position-${++serial}`;
    send('setPosition', positionId, { fen: demo.querySelector('#fen').value.trim() });
    if (positionError) return;

    lines.clear();
    result.textContent = '';
    status.textContent = 'Analyse läuft …';
    analysisError = false;
    activeId = `demo-analysis-${serial}`;
    stop.disabled = false;
    send('startAnalysis', activeId, { limits: { movetimeMs: 500 }, multiPv: 4 });
  });
  stop.addEventListener('click', () => {
    send('stopAnalysis', `demo-stop-${serial}`, { analysisRequestId: activeId });
  });
  demo.hidden = false;
}
