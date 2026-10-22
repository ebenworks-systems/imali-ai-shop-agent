#!/usr/bin/env python3
"""Puts the narration and captions on the recorded film.

    python3 tools/video/compose.py

Reads submission/work/film-raw.mp4, its events (scene start times) and the takes from narrate.py. Each scene's lines
start 0.3 s after the scene begins, 0.35 s apart. Captions are drawn on a white card at the foot of the picture.
Writes submission/imali-ai-shop-agent-demo.mp4 and .srt, with the sound brought to -16 LUFS.
"""
import json, os, subprocess

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
WORK = os.path.join(ROOT, "submission", "work")
LINES = json.load(open(os.path.join(os.path.dirname(__file__), "narration.json")))
LENGTHS = json.load(open(os.path.join(WORK, "takes", "lengths.json")))
EVENTS = json.load(open(os.path.join(WORK, "film-raw.events.json")))
GAP, LEAD = 0.35, 0.3
OUT = os.path.join(ROOT, "submission", "imali-ai-shop-agent-demo.mp4")


def stamp(t, sep):
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h)}:{int(m):02d}:{s:05.2f}" if sep == "." else f"{int(h):02d}:{int(m):02d}:{s:06.3f}".replace(".", ",")


def timeline():
    starts = {e["label"]: e["t"] for e in EVENTS["events"]}
    out, cursor = [], 0.0
    for scene in dict.fromkeys(l["scene"] for l in LINES):
        t = max(starts[scene] + LEAD, cursor + GAP)
        for line in [l for l in LINES if l["scene"] == scene]:
            out.append({**line, "start": round(t, 3), "end": round(t + LENGTHS[line["id"]], 3)})
            t += LENGTHS[line["id"]] + GAP
        cursor = t
    return out


def ass(lines, w, h):
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Geist,40,&H001C201E,&H001C201E,&H00F6F8FA,&H10FFFFFF,0,0,0,0,100,100,0,0,3,18,0,2,260,260,46,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    body = "".join(f"Dialogue: 0,{stamp(l['start'], '.')},{stamp(l['end'] + 0.25, '.')},Cap,,0,0,0,,{l['caption']}\n" for l in lines)
    return head + body


def main():
    lines = timeline()
    w, h = EVENTS["width"], EVENTS["height"]
    film = os.path.join(WORK, "film-raw.mp4")
    total = max(EVENTS["seconds"], lines[-1]["end"] + 2.0)
    captions = "/tmp/imali-ai-shop-agent-captions.ass"  # a path with no spaces or brackets, for the filter graph
    open(captions, "w").write(ass(lines, w, h))
    with open(OUT.replace(".mp4", ".srt"), "w") as srt:
        for i, l in enumerate(lines, 1):
            srt.write(f"{i}\n{stamp(l['start'], ',')} --> {stamp(l['end'] + 0.25, ',')}\n{l['caption']}\n\n")
    inputs, filters = ["-i", film], []
    for i, l in enumerate(lines, 1):
        inputs += ["-i", os.path.join(WORK, "takes", f"{l['id']}.wav")]
        ms = int(l["start"] * 1000)
        filters.append(f"[{i}:a]adelay={ms}|{ms}[a{i}]")
    mix = "".join(f"[a{i}]" for i in range(1, len(lines) + 1))
    filters.append(f"{mix}amix=inputs={len(lines)}:normalize=0:dropout_transition=0,apad=whole_dur={total:.3f},loudnorm=I=-16:TP=-1.5:LRA=11[aud]")
    filters.append(f"[0:v]tpad=stop_mode=clone:stop_duration={max(0, total - EVENTS['seconds']) + 0.1:.3f},ass={captions}[vid]")
    subprocess.check_call(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(filters), "-map", "[vid]", "-map", "[aud]",
                           "-t", f"{total:.3f}", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
                           "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", OUT])
    print(f"{OUT}: {total:.1f} s, {len(lines)} lines")
    for l in lines:
        print(f"  {l['start']:6.1f}-{l['end']:6.1f}  {l['id']}")


if __name__ == "__main__":
    main()
