// Step 8.7 media gate (THEAAAAA-567).
//
// Verifies a reel mp4 before it is allowed to advance to Step 9 publish:
//   1. Container is readable; video stream is 1080x1920 h264 with duration > 0.
//   2. Audio stream is present and AAC.
//   3. Voice presence — non-silent audio covers at least VOICE_MIN_NONSILENT_FRACTION
//      of the duration, computed from ffmpeg `silencedetect` regions.
//
// (3) closes the regression from Run 527 (THEAAAAA-566): a reel with a silent track
// passed the legacy gate (which only confirmed the AAC stream existed, not that any
// speech / sound was carried). Fail-closed per THEAAAAA-382 — any failed check
// returns a non-zero exit and the calling Step 8.7 must mark `blocked`.
//
// Config (env or defaults):
//   VOICE_NOISE_DB                 silencedetect noise floor in dB (default -30)
//   VOICE_SILENCE_MIN_DURATION     min silent region length, seconds (default 0.5)
//   VOICE_MIN_NONSILENT_FRACTION   minimum non-silent fraction of total duration (default 0.30)
//
// Usage:
//   node scripts/media-gate.mjs <path-to-reel.mp4>
//
// Exits 0 only if every check passes; otherwise prints the failure reasons to stderr
// and exits 1.

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";

export const DEFAULTS = {
  width: 1080,
  height: 1920,
  videoCodec: "h264",
  audioCodec: "aac",
  noiseDb: -30,
  silenceMinDuration: 0.5,
  minNonSilentFraction: 0.30,
};

function num(envName, fallback) {
  const raw = process.env[envName];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env = process.env) {
  const orig = process.env;
  process.env = env;
  try {
    return {
      width: DEFAULTS.width,
      height: DEFAULTS.height,
      videoCodec: DEFAULTS.videoCodec,
      audioCodec: DEFAULTS.audioCodec,
      noiseDb: num("VOICE_NOISE_DB", DEFAULTS.noiseDb),
      silenceMinDuration: num("VOICE_SILENCE_MIN_DURATION", DEFAULTS.silenceMinDuration),
      minNonSilentFraction: num("VOICE_MIN_NONSILENT_FRACTION", DEFAULTS.minNonSilentFraction),
    };
  } finally {
    process.env = orig;
  }
}

// Probe video + audio streams and format duration.
export function probeMedia(path) {
  statSync(path);
  const r = spawnSync(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "stream=index,codec_type,codec_name,width,height:format=duration",
      "-of", "json",
      path,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr || r.status}`);
  const probe = JSON.parse(r.stdout);
  const streams = probe.streams || [];
  const video = streams.find((s) => s.codec_type === "video") || null;
  const audio = streams.find((s) => s.codec_type === "audio") || null;
  const duration = Number(probe.format && probe.format.duration);
  return { video, audio, duration };
}

// Parse silencedetect stderr (it writes to stderr, not stdout) into silent regions.
export function parseSilenceRegions(stderr, totalDuration) {
  const starts = [];
  const ends = [];
  for (const line of stderr.split("\n")) {
    const ms = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (ms) starts.push(Number(ms[1]));
    const me = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (me) ends.push(Number(me[1]));
  }
  const regions = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = Math.max(0, starts[i]);
    // If the file ends inside a silent region ffmpeg may not emit a matching
    // silence_end. Clamp to total duration so we still count it.
    const end = i < ends.length ? Math.min(totalDuration, ends[i]) : totalDuration;
    if (end > start) regions.push({ start, end });
  }
  return regions;
}

// Returns the non-silent fraction of the audio track in [0,1].
export function measureVoiceFraction(path, { noiseDb, silenceMinDuration }, totalDuration) {
  const r = spawnSync(
    "ffmpeg",
    [
      "-hide_banner", "-nostats",
      "-i", path,
      "-af", `silencedetect=noise=${noiseDb}dB:d=${silenceMinDuration}`,
      "-f", "null", "-",
    ],
    { encoding: "utf8" },
  );
  // ffmpeg exits 0 even when it just reports silence. A non-zero exit is a real read failure.
  if (r.status !== 0 && !/silence_/.test(r.stderr || "")) {
    throw new Error(`ffmpeg silencedetect failed: ${r.stderr || r.status}`);
  }
  const regions = parseSilenceRegions(r.stderr || "", totalDuration);
  const silentTotal = regions.reduce((acc, x) => acc + (x.end - x.start), 0);
  if (!(totalDuration > 0)) return 0;
  const fraction = Math.max(0, 1 - silentTotal / totalDuration);
  return Math.min(1, fraction);
}

// Run every Step 8.7 gate check. Returns { ok, reasons, facts }.
export function runMediaGate(path, config = loadConfig()) {
  const reasons = [];
  let probe;
  try {
    probe = probeMedia(path);
  } catch (err) {
    return { ok: false, reasons: [`media unreadable: ${err.message}`], facts: null };
  }
  const { video, audio, duration } = probe;

  if (!video) reasons.push("no video stream");
  if (video && Number(video.width) !== config.width)
    reasons.push(`video width ${video.width} != ${config.width}`);
  if (video && Number(video.height) !== config.height)
    reasons.push(`video height ${video.height} != ${config.height}`);
  if (video && video.codec_name !== config.videoCodec)
    reasons.push(`video codec ${video.codec_name} != ${config.videoCodec}`);

  if (!audio) reasons.push("no audio stream");
  if (audio && audio.codec_name !== config.audioCodec)
    reasons.push(`audio codec ${audio.codec_name} != ${config.audioCodec}`);

  if (!(duration > 0)) reasons.push("non-positive duration");

  let voiceFraction = null;
  if (audio && duration > 0) {
    try {
      voiceFraction = measureVoiceFraction(path, config, duration);
      if (voiceFraction < config.minNonSilentFraction) {
        reasons.push(
          `voice-presence ${(voiceFraction * 100).toFixed(1)}% non-silent < ` +
          `${(config.minNonSilentFraction * 100).toFixed(1)}% threshold ` +
          `(noise=${config.noiseDb}dB, d=${config.silenceMinDuration}s)`,
        );
      }
    } catch (err) {
      reasons.push(`voice-presence check failed: ${err.message}`);
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    facts: {
      width: video?.width,
      height: video?.height,
      videoCodec: video?.codec_name,
      audioCodec: audio?.codec_name,
      duration,
      voiceFraction,
      config,
    },
  };
}

function isMain() {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write("usage: node scripts/media-gate.mjs <path-to-reel.mp4>\n");
    process.exit(2);
  }
  const result = runMediaGate(path);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.ok) {
    process.stderr.write("media-gate FAIL: " + result.reasons.join("; ") + "\n");
    process.exit(1);
  }
}
