import { createAdapter } from './adapter.js';

const adapter = createAdapter({
  createWorker: () => new Worker(new URL('./lozza/lozza11.0.js', import.meta.url)),
  publish(message) {
    const bridge = window.webkit?.messageHandlers?.cwep;
    if (bridge) bridge.postMessage(message);
    else window.dispatchEvent(new CustomEvent('cwep-message', { detail: message }));
  },
});

window.cwepReceiveMessage = adapter.receive;
window.addEventListener('pagehide', adapter.suspend);
window.addEventListener('pageshow', adapter.resume);
window.dispatchEvent(new CustomEvent('cwep-ready'));
