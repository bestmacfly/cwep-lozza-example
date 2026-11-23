# CWEP Lozza Example

An independent example implementation of the Chess Web Engine Protocol (CWEP) using Lozza 11.0. It shows how a host can discover a web chess engine, submit a position, receive analysis updates, and cancel a search. Lozza runs locally in a classic Web Worker. This project is maintained independently of the Lozza author. [CWEP 1.0 specification](https://github.com/bestmacfly/CWEP/blob/4573f5ae0843c1c0cabd8ec8335c7e9c146cec3b/docs/specification.md) · [Lozza project](https://github.com/op12no2/lozza)

## Architecture

A host sends CWEP messages to `window.cwepReceiveMessage(message)`. The bridge publishes replies through `window.webkit.messageHandlers.cwep.postMessage(message)` in a native WebKit host or through a same-document `cwep-message` event in a browser. The optional `cwep-ready` event signals that the receiver is installed. Hosts can also check for the receiver directly. The live `hello` and `getCapabilities` replies are authoritative for the loaded instance. The static manifest is for catalogs.

The adapter validates FEN and optional legal move history with chess.js and translates each started analysis into a single UCI search. One worker and one active analysis are allowed per page. The worker starts on demand and is reused after a normal finish. Cancellation, replacement, and a position change during analysis terminate the worker and complete the pending request. Page teardown also releases an idle worker. All runtime assets load from the same origin.

## CWEP features

| Request | Support |
| --- | --- |
| `hello` | CWEP 1.0 discovery, plug-in ID `cwep-lozza-example`, plug-in version `1.0.0`, and engine version `11.0` |
| `getCapabilities` | Standard chess, analysis, MultiPV, move history, cancellation, and supported options |
| `setPosition` | Six-field FEN and up to 512 legal UCI moves, including castling, en passant, and promotion |
| `startAnalysis` | Progressive updates and exactly one completion per accepted search. Centipawn and mate scores use the side to move at the root after applying the move history. |
| `stopAnalysis` | Cancels a search or worker initialization. An optional `analysisRequestId` targets the active search. |
| `setOptions` | Between searches, set `hashMb` from 1 to 16 (default 16) and the default `multiPv` from 1 to 4 (default 1). A per-search `multiPv` takes precedence. |

The receiver accepts JSON objects and serialized JSON messages up to 65,536 characters, with FEN strings up to 160 characters. Errors carry a code and message, and accepted searches end with `bestMove`, `final`, and `stoppedBy`. The adapter supplies an analysis ID when the host omits one.

| Search limits | Range and behavior |
| --- | --- |
| Depth only | 1–30 plies, sent as `go depth D` |
| Time only | 1–10,000 ms, sent as `go movetime T` |
| Depth and time | Both limits are passed to Lozza. The first limit reached ends the search. |
| Neither | 1,000 ms default search budget |

Worker startup and preparation each have a 15-second deadline. A timed search has a one-second grace period for its completion message. For a depth-only search the adapter probes with `isready` after 30 seconds without a search signal and times out after another 180 seconds without activity. This watchdog is independent of the default search budget.

## Run locally

Use Python 3 to serve the checkout. The page and worker are ready to run from the checked-in files.

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

Open the [local demo](http://127.0.0.1:8080/public/) and select **Analysieren**. You can use the starting position or enter a standard-chess FEN. To see the bridge messages, run this in the demo page's browser console, then start an analysis.

```js
window.addEventListener('cwep-message', ({ detail }) => {
  console.log(detail.type, detail.requestId, detail.payload);
});
```

## Tests

Run the automated tests with Node.js 20 or later. They exercise the adapter with a simulated worker and with the original Lozza script, compare scores and variations with the UCI transcript, and verify the engine and license hashes.

```sh
npm test
```

With the local server running, open the [browser smoke test](http://127.0.0.1:8080/tests/browser-smoke.html). A successful run reports `"ok": true`. With Apple Command Line Tools installed, run the same test through the native CWEP bridge on macOS.

```sh
swiftc tests/wkwebview-smoke.swift -o /tmp/cwep-lozza-wk-smoke
/tmp/cwep-lozza-wk-smoke
```

## Static hosting

Serve all of `public/` over HTTPS, including the engine, manifest, and license files. The relative asset URLs support a versioned subdirectory such as `/engines/lozza/11.0/`. Use standard HTML, JavaScript, and JSON MIME types. The classic worker uses ordinary same-origin loading and requires no cross-origin isolation headers. [Cloudflare Pages static HTML guide](https://developers.cloudflare.com/pages/framework-guides/deploy-anything/)

## Known limitations

- **MultiPV.** Lozza can repeat root moves or report entries retained from earlier iterations. The adapter filters duplicate root moves and may withhold a batch that would introduce a duplicate in the host's rank cache. Scores, depths, move sequences, and rank numbers are passed through as reported. Fewer than four lines and gaps in the ranks are possible. Reset the rank cache for each analysis and apply each `lines` entry by rank. The primary line is also reported in the standard top-level fields.
- **FEN counters.** The adapter forwards all six FEN fields unchanged. Lozza 11.0 does not apply the FEN halfmove clock to its search state, which can affect evaluation near the 50-move rule. Repetition history is available only through the supplied moves.
- **Scores and completion.** Single-PV bounds without a score unit are omitted. Lozza's `bestmove NULL` maps to `bestMove: null`. When the best move has no matching rank-one result, its final score is null and its final PV is empty.
- **Search timing.** Lozza checks time inside its search, so very small budgets and scheduling delays can affect timing. It uses a single search thread.
- **Platform coverage.** The browser and native bridge smoke tests have run in Firefox and macOS WKWebView. iOS and iPadOS have not been tested.

## Licensing and provenance

The MIT license applies exclusively to the first-party adapter code. The table identifies the upstream license for each bundled dependency.

| Component | License and origin |
| --- | --- |
| First-party CWEP-Lozza adapter code, including the bridge and demo | MIT, Copyright (c) 2026 bestmacfly. [Repository license](LICENSE) · [Static package copy](public/LICENSE) |
| Lozza 11.0 by Colin Jenkins | The upstream license applies. The original JavaScript release includes the evaluation weights. Its SHA-256 is `36feb6a0614fd66148d454131371bd2e5d78d326c3cd10aca0e26483b3d213e1`. [Original license](public/lozza/LICENCE) · [Release](https://github.com/op12no2/lozza/releases/tag/v11.0) · [Tagged source](https://github.com/op12no2/lozza/tree/9822ff0d34ea1f7b57c77a6d8a2453aa19ba702b) |
| chess.js 1.4.0 by Jeff Hlywa | BSD-2-Clause. The ESM build and source map are from the upstream package. [Original license and copyright](public/vendor/chess.js/LICENSE) · [Package archive](https://registry.npmjs.org/chess.js/-/chess.js-1.4.0.tgz) |

The GPLv3-licensed Stockfish example served as an architectural reference for the bridge, worker readiness, and search lifecycle. Comparison against its available history found no matching standalone implementation blocks in the adapter or tests. Short matches came from shared API expressions and standard data. A matching console snippet in an earlier README was replaced. The shared chess.js distribution files match the independently licensed upstream package. [Stockfish reference at `3d55542`](https://github.com/bestmacfly/cwep-stockfish-example/tree/3d55542d1a89f51eba24bee05e09d5f99faf600d) · [Static package license notices](public/licenses.html)
