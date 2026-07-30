/**
 * Diagnostic page (see ../export-check.html) for an upstream `modbus-rs` bug:
 * the WASM build's `.d.ts` declares `ModbusErrorCode` as an export, but the
 * generated JS never exports it. Types pass, runtime fails.
 *
 * This exists because the bug is invisible to every check this repo normally
 * runs — the root `tsc`/`bun test` resolve `modbus-rs` under the default (napi)
 * condition, where the export genuinely exists, and the browser `.d.ts` lies
 * about the browser build. Only a real bundler resolving the `browser`
 * condition sees it.
 *
 * Every probe below uses `import()` inside a try/catch. A static
 * `import { ModbusErrorCode } from 'modbus-rs'` at the top of this file would
 * fail at module-link time and render nothing at all — which is precisely the
 * failure being demonstrated, so it has to be quarantined to be observable.
 */

/** Result produced by one runtime-export or named-import diagnostic probe. */
interface ProbeResult {
  readonly specifier: string;
  readonly note: string;
  readonly status: 'ok' | 'missing' | 'threw';
  readonly detail: string;
  readonly exports?: readonly string[];
}

/** The upstream binding export whose browser runtime availability is checked. */
const EXPECTED_EXPORT = 'ModbusErrorCode';

/** Loads a module namespace and reports whether `ModbusErrorCode` is on it. */
const probeNamespace = async (
  specifier: string,
  note: string,
  load: () => Promise<Record<string, unknown>>,
): Promise<ProbeResult> => {
  try {
    const namespace = await load();
    const exports = Object.keys(namespace).sort();
    return exports.includes(EXPECTED_EXPORT)
      ? {
          specifier,
          note,
          status: 'ok',
          detail: `\`${EXPECTED_EXPORT}\` is exported: ${JSON.stringify(namespace[EXPECTED_EXPORT])}`,
          exports,
        }
      : {
          specifier,
          note,
          status: 'missing',
          detail: `\`${EXPECTED_EXPORT}\` is NOT among the ${exports.length} runtime exports, but modbus-rs's .d.ts declares it.`,
          exports,
        };
  } catch (error) {
    return { specifier, note, status: 'threw', detail: String(error) };
  }
};

/**
 * Probes a module whose *own* top-level code does the failing named import.
 * Distinct from `probeNamespace`: this surfaces the real link-time error a
 * consumer hits, rather than inspecting a namespace object after the fact.
 */
const probeStaticImport = async (
  specifier: string,
  note: string,
  load: () => Promise<unknown>,
): Promise<ProbeResult> => {
  try {
    await load();
    return { specifier, note, status: 'ok', detail: 'Module linked and evaluated without error.' };
  } catch (error) {
    return { specifier, note, status: 'threw', detail: String(error) };
  }
};

// Specifiers must be literals so Vite can statically analyse and rewrite them —
// a variable specifier would not resolve as a bare package name in the browser.
/** Runs every probe without allowing one failed module link to stop the page. */
const runProbes = (): Promise<readonly ProbeResult[]> =>
  Promise.all([
    probeNamespace(
      'modbus-rs',
      'Resolves to dist/index.browser.js under the `browser` condition, which is `export * from "modbus-rs-wasm"`.',
      () => import('modbus-rs') as Promise<Record<string, unknown>>,
    ),
    probeNamespace(
      'modbus-rs/web',
      'The explicit web subpath — `export * from "modbus-rs-wasm/web"`. Same underlying wasm-bindgen output, different target.',
      () => import('modbus-rs/web') as Promise<Record<string, unknown>>,
    ),
    probeStaticImport(
      "src/static-import-probe.ts → import { ModbusErrorCode } from 'modbus-rs'",
      "The exact import shape used by the parent package's src/errors.ts. This is the failure a consumer actually hits.",
      () => import('./static-import-probe.ts'),
    ),
    probeStaticImport(
      'effect-modbus-rs',
      'The downstream consequence: this package cannot be loaded in a browser at all while the export is missing.',
      () => import('effect-modbus-rs'),
    ),
  ]);

/** Human-readable labels for the status class assigned by each probe. */
const STATUS_LABEL: Record<ProbeResult['status'], string> = {
  ok: 'PASS',
  missing: 'FAIL — export missing',
  threw: 'FAIL — threw',
};

/** Renders the probe evidence and aggregate result into the diagnostic page. */
const render = (results: readonly ProbeResult[]) => {
  const root = document.getElementById('results');
  if (!root) return;
  root.textContent = '';

  for (const result of results) {
    const card = document.createElement('div');
    card.className = `probe ${result.status === 'ok' ? 'probe-ok' : 'probe-fail'}`;

    const heading = document.createElement('div');
    heading.className = 'probe-head';
    heading.innerHTML = `<span class="badge">${STATUS_LABEL[result.status]}</span><code>${result.specifier}</code>`;
    card.append(heading);

    const note = document.createElement('p');
    note.className = 'probe-note';
    note.textContent = result.note;
    card.append(note);

    const detail = document.createElement('pre');
    detail.className = 'probe-detail';
    detail.textContent = result.detail;
    card.append(detail);

    if (result.exports) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = `Runtime exports (${result.exports.length})`;
      const list = document.createElement('pre');
      list.className = 'probe-detail';
      list.textContent = result.exports.join('\n');
      details.append(summary, list);
      card.append(details);
    }

    root.append(card);
  }

  const failures = results.filter((result) => result.status !== 'ok').length;
  const summaryEl = document.getElementById('summary');
  if (summaryEl) {
    summaryEl.textContent =
      failures === 0
        ? `All ${results.length} probes passed — upstream appears fixed. The parent package's src/errors.ts import is safe again.`
        : `${failures} of ${results.length} probes failed. modbus-rs's WASM build does not export ${EXPECTED_EXPORT} at runtime.`;
    summaryEl.className = failures === 0 ? 'summary summary-ok' : 'summary summary-fail';
  }
};

runProbes().then(render);
