import {
  getGameAudioContext,
  getGameAudioOutput,
} from "./gameAudioContext";

/**
 * Per-channel volume for the game page. Players connect through
 * `soundMixOutput` so each channel uses the shipped level below.
 */

export const SOUND_MIX_CHANNELS = [
  "bgm",
  "scratch",
  "coins",
  "match",
  "symbols",
  "win",
  "lose",
  "countdown",
  "intro",
] as const;

export type SoundMixChannel = (typeof SOUND_MIX_CHANNELS)[number];

export type SoundMix = Record<SoundMixChannel, number>;

/** Shipped levels. 1 = the hardcoded gain each player already used. */
export const SOUND_MIX_DEFAULTS: SoundMix = {
  bgm: 1,
  scratch: 1,
  coins: 1,
  match: 0.4,
  symbols: 1,
  win: 1,
  lose: 1,
  countdown: 0.05,
  intro: 0.75,
};

function clampGain(value: number): number {
  return Number.isFinite(value) ? Math.min(2, Math.max(0, value)) : 1;
}

const mix: SoundMix = { ...SOUND_MIX_DEFAULTS };
const channelGains = new Map<SoundMixChannel, GainNode>();

/**
 * One gain per channel. One-shots connect here so the shipped level applies
 * to a sound that is already playing.
 */
export function soundMixOutput(channel: SoundMixChannel): AudioNode | null {
  const ctx = getGameAudioContext();
  if (!ctx) return null;
  let node = channelGains.get(channel);
  if (!node) {
    node = ctx.createGain();
    node.connect(getGameAudioOutput(ctx));
    channelGains.set(channel, node);
  }
  node.gain.value = soundMixGain(channel);
  return node;
}

export function soundMixGain(channel: SoundMixChannel): number {
  return clampGain(mix[channel]);
}
