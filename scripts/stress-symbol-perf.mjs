#!/usr/bin/env node
/**
 * Stress / performance probe for the symbol freeze work.
 * Talks to an already-running Chrome on --remote-debugging-port=9222.
 *
 * Usage:
 *   node scripts/stress-symbol-perf.mjs
 *   STRESS_URL='https://127.0.0.1:5080/?model=julianaval&card=julianaval_gym&debug=1' node scripts/stress-symbol-perf.mjs
 */

const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9222";
const TARGET_URL =
  process.env.STRESS_URL ||
  "https://127.0.0.1:5080/?model=julianaval&card=julianaval_gym&debug=1";
const OUT_PATH =
  process.env.STRESS_OUT ||
  new URL("../.tmp/stress-symbol-perf.json", import.meta.url).pathname;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.text ||
          JSON.stringify(result.exceptionDetails),
      );
    }
    return result.result?.value;
  }

  close() {
    this.ws?.close();
  }
}

async function findPageWs() {
  const list = await fetch(`${CDP_HTTP}/json/list`).then((r) => r.json());
  const page =
    list.find((t) => t.type === "page" && t.url === "about:blank") ||
    list.find((t) => t.type === "page");
  if (!page?.webSocketDebuggerUrl) {
    throw new Error(`No page target at ${CDP_HTTP}`);
  }
  return page.webSocketDebuggerUrl;
}

function summarize(samples, label) {
  if (!samples.length) return { label, n: 0 };
  const fps = samples.map((s) => s.fps);
  const heap = samples.map((s) => s.heapMb).filter((n) => n != null);
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const last = samples[samples.length - 1];
  return {
    label,
    n: samples.length,
    fpsAvg: Math.round(avg(fps) * 10) / 10,
    fpsMin: Math.min(...fps),
    fpsMax: Math.max(...fps),
    heapAvgMb: heap.length ? Math.round(avg(heap) * 10) / 10 : null,
    heapMaxMb: heap.length ? Math.round(Math.max(...heap) * 10) / 10 : null,
    symReadyLast: last.symReady,
    symPlayingLast: last.symPlaying,
    symTotalLast: last.symTotal,
    iconCanvasesLast: last.iconCanvases,
    missedLast: last.missed,
    dormantLast: last.dormant,
    fxPeakLast: last.fxActive,
  };
}

async function collectSamples(cdp, seconds, tag) {
  const start = Date.now();
  const out = [];
  while (Date.now() - start < seconds * 1000) {
    const snap = await cdp.evaluate(`(() => {
      const p = window.__scratchPerf;
      if (!p?.latest) return null;
      return { ...p.latest, peakHeapMb: p.peakHeapMb };
    })()`);
    if (snap) out.push({ ...snap, tag });
    await sleep(500);
  }
  return out;
}

async function scratchTopBar(cdp) {
  const box = await cdp.evaluate(`(() => {
    const bar = document.querySelector('.top-symbol-bar.is-scratchable, .top-symbol-bar');
    if (!bar) return null;
    const r = bar.getBoundingClientRect();
    return { x: Number(r.left), y: Number(r.top), w: Number(r.width), h: Number(r.height) };
  })()`);
  if (!box || box.w < 20) return false;

  const y = box.y + box.h * 0.5;
  const x0 = box.x + box.w * 0.08;
  const x1 = box.x + box.w * 0.92;
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: x0,
    y,
    button: "left",
    clickCount: 1,
  });
  const steps = 28;
  for (let i = 1; i <= steps; i += 1) {
    const x = x0 + ((x1 - x0) * i) / steps;
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y: y + Math.sin(i / 3) * 2,
      button: "left",
    });
    await sleep(16);
  }
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: x1,
    y,
    button: "left",
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: x1,
    y,
    button: "left",
    clickCount: 1,
  });
  for (let i = 1; i <= steps; i += 1) {
    const x = x1 - ((x1 - x0) * i) / steps;
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y: y - Math.sin(i / 3) * 2,
      button: "left",
    });
    await sleep(16);
  }
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: x0,
    y,
    button: "left",
    clickCount: 1,
  });
  return true;
}

/** Dense diagonal strokes over the stage canvas — body-hunt stress. */
async function stressScratchBody(cdp, passes = 10) {
  const box = await cdp.evaluate(`(() => {
    const canvas =
      document.querySelector('canvas.game-stage-canvas') ||
      document.querySelector('.stage canvas');
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return {
      x: Number(r.left),
      y: Number(r.top),
      w: Number(r.width),
      h: Number(r.height),
    };
  })()`);
  if (!box || !(box.w > 40) || !(box.h > 40)) {
    return { ok: false, passes: 0, box };
  }

  for (let p = 0; p < passes; p += 1) {
    const top = box.y + box.h * (0.18 + (p % 5) * 0.12);
    const bot = box.y + box.h * (0.55 + (p % 4) * 0.1);
    const x0 = box.x + box.w * (0.15 + (p % 3) * 0.1);
    const x1 = box.x + box.w * (0.85 - (p % 3) * 0.08);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: x0,
      y: top,
      button: "left",
      clickCount: 1,
    });
    const steps = 36;
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: x0 + (x1 - x0) * t,
        y: top + (bot - top) * t,
        button: "left",
      });
      await sleep(8);
    }
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: x1,
      y: bot,
      button: "left",
      clickCount: 1,
    });
  }
  return { ok: true, passes, box };
}

async function waitForHud(cdp, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await cdp.evaluate(
      `!!(window.__scratchPerf && document.querySelector('.stage'))`,
    );
    if (ready) return true;
    await sleep(300);
  }
  return false;
}

async function waitForHuntPhase(cdp, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await cdp.evaluate(`(() => {
      const coating = document.querySelector('.top-symbol-bar.is-scratchable');
      const coach = (document.body.innerText || '');
      return !coating && /match the symbols/i.test(coach);
    })()`);
    if (ready) return true;
    await sleep(400);
  }
  return false;
}

async function main() {
  const wsUrl = await findPageWs();
  const cdp = new CdpSession(wsUrl);
  await cdp.connect();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", { url: TARGET_URL });
  await sleep(4000);

  const hudOk = await waitForHud(cdp);
  if (!hudOk) {
    throw new Error("Debug HUD / stage never became ready (need ?debug=1 + HMR)");
  }

  const idleBar = await collectSamples(cdp, 4, "bar_idle");

  const scratched = await scratchTopBar(cdp);
  await sleep(800);
  for (let i = 0; i < 3; i += 1) {
    const still = await cdp.evaluate(
      `!!document.querySelector('.top-symbol-bar.is-scratchable')`,
    );
    if (!still) break;
    await scratchTopBar(cdp);
    await sleep(400);
  }
  const afterBar = await collectSamples(cdp, 3, "bar_after_scratch");

  const huntReady = await waitForHuntPhase(cdp);
  const bodyStress = huntReady
    ? await stressScratchBody(cdp, 14)
    : { ok: false, passes: 0 };
  const huntDuring = await collectSamples(cdp, 6, "body_scratch_stress");

  await sleep(2000);
  const settle = await collectSamples(cdp, 5, "post_reveal_settle");

  const all = [...idleBar, ...afterBar, ...huntDuring, ...settle];
  const report = {
    startedAt: new Date().toISOString(),
    url: TARGET_URL,
    scratchedBar: scratched,
    huntReady,
    bodyStress,
    scenarios: [
      summarize(idleBar, "bar_idle"),
      summarize(afterBar, "bar_after_scratch"),
      summarize(huntDuring, "body_scratch_stress"),
      summarize(settle, "post_reveal_settle"),
    ],
    final: await cdp.evaluate(`(() => {
      const p = window.__scratchPerf;
      return {
        latest: p?.latest ?? null,
        peakHeapMb: p?.peakHeapMb ?? null,
        stageClass: document.querySelector('.stage')?.className ?? null,
        bodyText: (document.body.innerText || '').split('\\n').slice(0, 14),
        revealedMarkers: document.querySelectorAll('.body-symbol-marker.is-revealed').length,
        missedMarkers: document.querySelectorAll('.body-symbol-marker.is-missed').length,
        hitMarkers: document.querySelectorAll('.body-symbol-marker.is-revealed:not(.is-missed)').length,
      };
    })()`),
    sampleCount: all.length,
  };

  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(
    OUT_PATH,
    JSON.stringify({ ...report, samples: all }, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nWrote ${OUT_PATH}`);
  cdp.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
