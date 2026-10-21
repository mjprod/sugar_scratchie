/**
 * Sound + haptics for the hunt-complete garment explosion (see
 * `garmentExplosion.ts`). Synthesized on the shared game AudioContext and
 * routed through the "win" mix channel.
 */
import {
  gameAudioStartTime,
  getGameAudioContext,
  getGameAudioOutput,
} from "../shared/gameAudioContext";
import { soundMixOutput } from "../shared/soundMix";

const CHARGE_START_HZ = 110;
const CHARGE_END_HZ = 880;
const CHARGE_PEAK_GAIN = 0.1;
const CHARGE_NOISE_GAIN = 0.07;

const BOOM_START_HZ = 150;
const BOOM_END_HZ = 38;
const BOOM_S = 0.45;
const BOOM_GAIN = 0.55;
const CRACK_S = 0.14;
const CRACK_GAIN = 0.3;
const SPARKLE_TAIL_HZ = [1567.98, 2093, 2637.02, 3135.96];
const SPARKLE_TAIL_STEP_S = 0.06;
const SPARKLE_TAIL_GAIN = 0.08;

const CHARGE_VIBRATE_MS = [15, 60, 15, 60, 25];
const BURST_VIBRATE_MS = [60, 30, 120];

let noiseBuffer: AudioBuffer | null = null;

function whiteNoise(ctx: AudioContext): AudioBuffer {
  if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) {
    return noiseBuffer;
  }
  const length = Math.ceil(ctx.sampleRate * 1);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
  noiseBuffer = buffer;
  return buffer;
}

function finaleAudio(): { ctx: AudioContext; out: AudioNode } | null {
  const ctx = getGameAudioContext();
  if (!ctx) return null;
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  return { ctx, out: soundMixOutput("win") ?? getGameAudioOutput(ctx) };
}

/** Rising sweep + noise swell that peaks right as the burst fires. */
export function playFinaleChargeSound(durationS: number) {
  const audio = finaleAudio();
  if (!audio || durationS <= 0) return;
  const { ctx, out } = audio;
  const t = gameAudioStartTime(ctx);
  const end = t + durationS;

  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(CHARGE_START_HZ, t);
  osc.frequency.exponentialRampToValueAtTime(CHARGE_END_HZ, end);
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(400, t);
  filter.frequency.exponentialRampToValueAtTime(5000, end);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(CHARGE_PEAK_GAIN, end);
  gain.gain.exponentialRampToValueAtTime(0.0001, end + 0.04);
  osc.connect(filter);
  filter.connect(gain);
  gain.connect(out);
  osc.start(t);
  osc.stop(end + 0.06);

  const noise = ctx.createBufferSource();
  noise.buffer = whiteNoise(ctx);
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.Q.value = 1.4;
  band.frequency.setValueAtTime(600, t);
  band.frequency.exponentialRampToValueAtTime(6000, end);
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.0001, t);
  noiseGain.gain.exponentialRampToValueAtTime(CHARGE_NOISE_GAIN, end);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, end + 0.04);
  noise.connect(band);
  band.connect(noiseGain);
  noiseGain.connect(out);
  noise.start(t);
  noise.stop(end + 0.06);
}

/** Low thump with a pitch drop, a noise crack and a sparkle tail. */
export function playFinaleBoomSound() {
  const audio = finaleAudio();
  if (!audio) return;
  const { ctx, out } = audio;
  const t = gameAudioStartTime(ctx);

  const thump = ctx.createOscillator();
  thump.type = "sine";
  thump.frequency.setValueAtTime(BOOM_START_HZ, t);
  thump.frequency.exponentialRampToValueAtTime(BOOM_END_HZ, t + BOOM_S);
  const thumpGain = ctx.createGain();
  thumpGain.gain.setValueAtTime(0.0001, t);
  thumpGain.gain.exponentialRampToValueAtTime(BOOM_GAIN, t + 0.01);
  thumpGain.gain.exponentialRampToValueAtTime(0.0001, t + BOOM_S);
  thump.connect(thumpGain);
  thumpGain.connect(out);
  thump.start(t);
  thump.stop(t + BOOM_S + 0.02);

  const crack = ctx.createBufferSource();
  crack.buffer = whiteNoise(ctx);
  const high = ctx.createBiquadFilter();
  high.type = "highpass";
  high.frequency.value = 1500;
  const crackGain = ctx.createGain();
  crackGain.gain.setValueAtTime(CRACK_GAIN, t);
  crackGain.gain.exponentialRampToValueAtTime(0.0001, t + CRACK_S);
  crack.connect(high);
  high.connect(crackGain);
  crackGain.connect(out);
  crack.start(t);
  crack.stop(t + CRACK_S + 0.02);

  SPARKLE_TAIL_HZ.forEach((freq, index) => {
    const start = t + 0.12 + index * SPARKLE_TAIL_STEP_S;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, start);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(SPARKLE_TAIL_GAIN, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
    osc.connect(gain);
    gain.connect(out);
    osc.start(start);
    osc.stop(start + 0.24);
  });
}

/** No-op where the Vibration API is missing (iOS Safari). */
export function finaleHaptics(phase: "charge" | "burst") {
  if (typeof navigator === "undefined") return;
  const vibrate = (navigator as Navigator & {
    vibrate?: (pattern: number[]) => boolean;
  }).vibrate;
  if (typeof vibrate !== "function") return;
  try {
    vibrate.call(
      navigator,
      phase === "charge" ? CHARGE_VIBRATE_MS : BURST_VIBRATE_MS,
    );
  } catch {
    // Some browsers throw without a user activation; haptics are optional.
  }
}
