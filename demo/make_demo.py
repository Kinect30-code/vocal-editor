#!/usr/bin/env python3
"""生成演示素材: 跑调的合成干声 offtake.wav + 正确旋律 melody.mid."""
import os
import numpy as np
import mido
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
SR = 44100
rng = np.random.default_rng(7)

MELODY = [("C4", 0.5), ("D4", 0.5), ("E4", 1.0), ("G4", 0.5), ("E4", 0.5), ("C4", 1.0)]
NOTE = {"C4": 60, "D4": 62, "E4": 64, "G4": 67}
VOWELS = {"a": (800, 1150, 2800), "i": (350, 2100, 2900), "e": (480, 1800, 2600)}


def note_f0(m):
    return 440.0 * 2 ** ((m - 69) / 12.0)


def synth_note(f0, dur, formants):
    t = np.arange(int(dur * SR)) / SR
    vib = 1 + 0.012 * np.sin(2 * np.pi * 5.5 * t + rng.uniform(0, 6))
    phase = 2 * np.pi * np.cumsum(f0 * vib) / SR
    x = np.zeros_like(t)
    for k in range(1, 41):
        fk = k * f0
        amp = 0.0
        for F in formants:
            amp += 1.0 / (1.0 + ((fk - F) / 120.0) ** 2)
        x += (amp / k) * np.sin(k * phase)
    n = len(t)
    at = min(int(0.02 * SR), n // 4)
    env = np.ones(n)
    env[:at] = np.linspace(0, 1, at)
    env[-at:] = np.linspace(1, 0, at)
    return x * env * 0.25


def main():
    mid = mido.MidiFile()
    tr = mido.MidiTrack()
    mid.tracks.append(tr)
    tr.append(mido.MetaMessage('set_tempo', tempo=mido.bpm2tempo(120), time=0))
    for name, dur in MELODY:
        m = NOTE[name]
        tr.append(mido.Message('note_on', note=m, velocity=96, time=0))
        tr.append(mido.Message('note_off', note=m, velocity=0, time=int(dur * 480)))
    mid.save(os.path.join(HERE, 'melody.mid'))

    parts, t = [], 0.0
    vowels = "aieaia"
    for i, (name, dur) in enumerate(MELODY):
        f0 = note_f0(NOTE[name]) * 2 ** (rng.uniform(0.4, 1.4) * (1 if i % 2 else -1) / 12)
        d = dur * rng.uniform(0.7, 1.25)
        parts.append(synth_note(f0, d, VOWELS[vowels[i]]))
        gap = rng.uniform(0.02, 0.08)
        parts.append(np.zeros(int(gap * SR)))
        t += d + gap
    x = np.concatenate(parts)
    sf.write(os.path.join(HERE, 'offtake.wav'), np.clip(x, -1, 1), SR, subtype='PCM_16')
    print("demo written:", os.path.join(HERE, 'offtake.wav'), os.path.join(HERE, 'melody.mid'))


if __name__ == '__main__':
    main()
