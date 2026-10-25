"""Render sounds/levelup.mp3: a short, dry, bright level-up jingle (rising arpeggio into a major chord)."""
import numpy as np, subprocess, pathlib, wave
SR = 44100
def note(f, dur, decay, vol=1.0, vib=0.0):
    t = np.arange(int(SR * dur)) / SR
    ph = 2 * np.pi * f * t + (vib * np.sin(2 * np.pi * 6 * t) * np.clip(t * 3, 0, 1) if vib else 0)
    w = sum(np.sin(ph * n) / n for n in range(1, 16, 2) if f * n < 9000)        # bright square-ish lead
    w = 0.65 * w + 0.35 * sum(np.sin(ph * n) / n for n in range(1, 12) if f * n < 9000)  # a bit of saw for brass bite
    env = np.minimum(1, t / 0.004) * np.exp(-t / decay)
    return w * env * vol
def place(buf, at, x): i = int(SR * at); buf[i:i + len(x)] += x[:len(buf) - i]
hz = lambda n: 440 * 2 ** ((n - 69) / 12)   # midi -> Hz
out = np.zeros(int(SR * 1.15))
step = 0.065
for i, m in enumerate([67, 72, 76, 79]):              # G4 C5 E5 G5, quick
    place(out, i * step, note(hz(m), 0.18, 0.07, 0.55))
hit = 4 * step
for m in [72, 76, 79, 84]:                            # C major chord, top C6
    place(out, hit, note(hz(m), 0.85, 0.32, 0.42, vib=0.004 if m == 84 else 0))
t = np.arange(int(SR * 0.6)) / SR                     # bass under the hit
place(out, hit, np.sin(2 * np.pi * hz(48) * t) * np.exp(-t / 0.18) * 0.7)
for i in range(5):                                    # a click on each note onset for punch
    n = np.random.default_rng(i).uniform(-1, 1, int(SR * 0.006)) * np.linspace(1, 0, int(SR * 0.006)) * 0.25
    place(out, i * step, n)
out /= np.abs(out).max() / 0.89
tail = int(SR * 0.15); out[-tail:] *= np.linspace(1, 0, tail)
root = pathlib.Path(__file__).parent.parent; wav = root / "sounds/_levelup.wav"
with wave.open(str(wav), "wb") as w: w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((out * 32767).astype(np.int16).tobytes())
subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(wav), "-ar", "32000", "-b:a", "64k", str(root / "sounds/levelup.mp3")], check=True); wav.unlink()
