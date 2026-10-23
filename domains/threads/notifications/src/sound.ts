import type { Told } from "./model.ts";

/** Each state's notes, made rather than loaded: rising for something waiting, falling for a failure, one soft note for done. */
const NOTES: Readonly<Record<Told, readonly { readonly hz: number; readonly at: number }[]>> = {
  waiting: [
    { hz: 659.25, at: 0 },
    { hz: 987.77, at: 0.11 },
  ],
  failed: [
    { hz: 523.25, at: 0 },
    { hz: 392, at: 0.13 },
  ],
  done: [{ hz: 880, at: 0 }],
};

/** How loud at its peak, and how long each note rings (s). */
const PEAK = 0.12;
const RING = 0.32;

/**
 * Plays a state's chime on `context`. A page the person has not touched yet may not make sound (the browser's autoplay
 * rule): the context stays suspended, and the chime plays nothing.
 */
export const chime = (context: AudioContext, state: Told): void => {
  if (context.state === "suspended") void context.resume().catch(() => {});
  const start = context.currentTime + 0.01;
  for (const note of NOTES[state]) {
    const tone = context.createOscillator();
    const level = context.createGain();
    tone.type = "sine";
    tone.frequency.value = note.hz;
    const at = start + note.at;
    level.gain.setValueAtTime(0, at);
    level.gain.linearRampToValueAtTime(PEAK, at + 0.012);
    level.gain.exponentialRampToValueAtTime(0.0001, at + RING);
    tone.connect(level).connect(context.destination);
    tone.start(at);
    tone.stop(at + RING + 0.02);
  }
};
