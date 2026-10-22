#!/usr/bin/env python3
"""Makes one narration take per line of narration.json with Murf (voice en-US-natalie, style Narration, model GEN2).

    MURF_API_KEY=... python3 tools/video/narrate.py [id ...]     # existing takes are kept unless named

Murf gives a different take every call, so a line that sounds wrong is asked for again by naming its id.
Takes and their lengths go to submission/work/ (ignored by git). The key is read from the environment and never printed.
"""
import json, os, subprocess, sys, time, urllib.error, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TAKES = os.path.join(ROOT, "submission", "work", "takes")
LINES = json.load(open(os.path.join(os.path.dirname(__file__), "narration.json")))
VOICE, STYLE, MODEL = "en-US-natalie", "Narration", "GEN2"


def murf(text):
    body = {"voiceId": VOICE, "style": STYLE, "text": text, "format": "WAV", "sampleRate": 24000, "channelType": "MONO", "modelVersion": MODEL}
    req = urllib.request.Request("https://api.murf.ai/v1/speech/generate", data=json.dumps(body).encode(), method="POST",
                                 headers={"api-key": os.environ["MURF_API_KEY"], "Content-Type": "application/json", "Accept": "application/json"})
    for attempt in range(3):
        try:
            d = json.loads(urllib.request.urlopen(req, timeout=90).read())
            return urllib.request.urlopen(d["audioFile"], timeout=90).read()
        except urllib.error.HTTPError as e:
            if e.code < 500 or attempt == 2:
                raise SystemExit(f"Murf {e.code}")
            time.sleep(3)


def duration(path):
    return float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]).decode().strip())


def trimmed(src, dst):
    """Cut leading and trailing silence so the gaps are the ones the film chooses."""
    subprocess.check_call(["ffmpeg", "-v", "error", "-y", "-i", src, "-af",
                           "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse",
                           "-ar", "48000", "-ac", "1", dst])


if __name__ == "__main__":
    only = set(sys.argv[1:])
    os.makedirs(TAKES, exist_ok=True)
    lengths = {}
    for line in LINES:
        raw = os.path.join(TAKES, f"{line['id']}.raw.wav")
        wav = os.path.join(TAKES, f"{line['id']}.wav")
        if (only and line["id"] in only) or not os.path.exists(wav):
            open(raw, "wb").write(murf(line["say"]))
            trimmed(raw, wav)
        lengths[line["id"]] = round(duration(wav), 3)
        print(f"{line['id']:10} {lengths[line['id']]:6.2f} s")
    json.dump(lengths, open(os.path.join(TAKES, "lengths.json"), "w"), indent=1)
    print(f"total speech {sum(lengths.values()):.1f} s")
