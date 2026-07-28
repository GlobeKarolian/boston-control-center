#!/usr/bin/env python3
"""
Speech-to-text for the scanner worker, using faster-whisper (local, no API key).

  One-shot:  python3 stt.py path/to/clip.wav        -> prints {"transcript": "..."}
  Server:    python3 stt.py --server                -> read a file path per line
             on stdin, print one JSON line per clip. Keeps the model resident so
             the worker can transcribe a live stream of clips fast.

Tuned for compressed, noisy public-safety radio, which the smallest models turn
into word-salad. Levers (all overridable by env):
  WHISPER_MODEL   default small.en  (base.en was too weak; medium.en is better
                  still if the Mac has the headroom - set WHISPER_MODEL=medium.en)
  WHISPER_PROMPT  primes the model with scanner vocabulary so it stops mishearing
                  units, streets and call types.

Anti-garble measures on every clip:
  - VAD (voice-activity) filter trims dead air, so the model never "hears"
    words in silence - the #1 cause of hallucinated nonsense on scanner feeds.
  - condition_on_previous_text=False, so one bad clip can't poison the next.
  - temperature 0 + beam search: no creative guessing.
  - a scanner-vocabulary initial prompt.
  - a light cleaner that drops the classic silence hallucinations ("you",
    "thank you") and collapses stuck word-loops.
"""
import sys, os, json, re

MODEL_NAME = os.environ.get("WHISPER_MODEL", "small.en")
_model = None

SCANNER_PROMPT = os.environ.get(
    "WHISPER_PROMPT",
    "Boston and Cambridge police, fire, and EMS radio dispatch. "
    "Units: Engine, Ladder, Truck, Tower, Rescue, Medic, Ambulance, Squad, Car, Unit, Sergeant, Detective. "
    "Traffic: respond to, en route, on scene, on location, copy, received, in service, clear, "
    "priority, backup, structure fire, working fire, motor vehicle accident, medical, cardiac, "
    "shots fired, robbery, disturbance, well-being check. "
    "Places: Boylston, Mass Ave, Comm Ave, Storrow Drive, Tremont, Dorchester, Roxbury, JFK."
)

# Whole-transcript artifacts Whisper emits on silence/noise. Only dropped when
# they are the ENTIRE result, so real short transmissions are never lost.
_HALLUCINATION = re.compile(
    r"^(you|thank you|thanks for watching|please subscribe|bye|\.|,| )+[.!?]*$", re.I
)


def model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        _model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")
    return _model


def _clean(text):
    if not text:
        return ""
    text = re.sub(r"\s+", " ", text).strip()
    if not text or _HALLUCINATION.match(text):
        return ""
    # collapse a word stuck on repeat ("four four four four" -> "four")
    text = re.sub(r"\b(\w+)(?:\s+\1\b){3,}", r"\1", text, flags=re.I)
    return text.strip()


def transcribe(path):
    segs, _info = model().transcribe(
        path,
        beam_size=5,
        temperature=0.0,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500, speech_pad_ms=200),
        condition_on_previous_text=False,
        initial_prompt=SCANNER_PROMPT,
        no_speech_threshold=0.6,
        log_prob_threshold=-1.0,
    )
    return _clean(" ".join(s.text.strip() for s in segs))


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "--server":
        model()  # warm up
        sys.stderr.write("stt: model ready (%s)\n" % MODEL_NAME); sys.stderr.flush()
        for line in sys.stdin:
            p = line.strip()
            if not p:
                continue
            try:
                print(json.dumps({"path": p, "transcript": transcribe(p)}), flush=True)
            except Exception as e:
                print(json.dumps({"path": p, "error": str(e)}), flush=True)
    elif len(sys.argv) >= 2:
        print(json.dumps({"transcript": transcribe(sys.argv[1])}))
    else:
        sys.stderr.write("usage: stt.py <audio> | stt.py --server\n"); sys.exit(2)


if __name__ == "__main__":
    main()
