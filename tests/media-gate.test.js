// Step 8.7 media-gate tests (THEAAAAA-567).
//
// Generates two synthetic 1080x1920 h264/aac fixtures with ffmpeg:
//   - silent.mp4: anullsrc audio (negative case — proxy for the Run 527 reel that
//     shipped a silent track and slipped through the legacy gate)
//   - voice.mp4: full-amplitude sine tone (positive case — non-silent audio)
//
// silent.mp4 MUST fail the new voice-presence check; voice.mp4 MUST pass every
// check. We also exercise the silencedetect parser directly so we don't depend
// on the ffmpeg locale / line-format for the core math.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runMediaGate,
  parseSilenceRegions,
  measureVoiceFraction,
  loadConfig,
  DEFAULTS,
} from "../scripts/media-gate.mjs";

const HAS_FFMPEG = spawnSync("ffmpeg", ["-version"]).status === 0;

function buildFixture(outPath, { silent }) {
  // Build a 4-second 1080x1920 h264/aac mp4. Silent fixture uses anullsrc;
  // voice fixture uses a continuous 440Hz sine that silencedetect treats as
  // non-silent at any reasonable noise floor.
  const audioInput = silent
    ? ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"]
    : ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100"];
  const r = spawnSync(
    "ffmpeg",
    [
      "-y", "-hide_banner", "-nostats", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=black:s=1080x1920:r=30",
      ...audioInput,
      "-t", "4",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ar", "44100", "-ac", "2",
      "-shortest",
      outPath,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`fixture build failed: ${r.stderr}`);
}

test("parseSilenceRegions handles unterminated trailing region", () => {
  // ffmpeg may not emit a matching silence_end when silence runs to EOF.
  const stderr = [
    "[silencedetect @ 0x1] silence_start: 0",
    "[silencedetect @ 0x1] silence_end: 1.5 | silence_duration: 1.5",
    "[silencedetect @ 0x1] silence_start: 3.0",
  ].join("\n");
  const regions = parseSilenceRegions(stderr, 4);
  assert.deepEqual(regions, [
    { start: 0, end: 1.5 },
    { start: 3, end: 4 },
  ]);
});

test("loadConfig honours env overrides", () => {
  const cfg = loadConfig({
    VOICE_NOISE_DB: "-40",
    VOICE_SILENCE_MIN_DURATION: "0.25",
    VOICE_MIN_NONSILENT_FRACTION: "0.5",
  });
  assert.equal(cfg.noiseDb, -40);
  assert.equal(cfg.silenceMinDuration, 0.25);
  assert.equal(cfg.minNonSilentFraction, 0.5);
  // Defaults still applied for unset entries.
  const def = loadConfig({});
  assert.equal(def.noiseDb, DEFAULTS.noiseDb);
  assert.equal(def.minNonSilentFraction, DEFAULTS.minNonSilentFraction);
});

test("media gate: silent reel fails voice-presence; tone reel passes (run-527 regression)", { skip: !HAS_FFMPEG }, () => {
  const dir = mkdtempSync(join(tmpdir(), "media-gate-"));
  const silent = join(dir, "silent.mp4");
  const voice = join(dir, "voice.mp4");
  try {
    buildFixture(silent, { silent: true });
    buildFixture(voice, { silent: false });
    assert.ok(existsSync(silent) && existsSync(voice));

    // Negative: the silent-track reel must be rejected by the voice check
    // (this is the Run 527 / THEAAAAA-566 regression).
    const silentResult = runMediaGate(silent);
    assert.equal(silentResult.ok, false);
    assert.ok(
      silentResult.reasons.some((r) => r.includes("voice-presence")),
      `expected voice-presence reason, got: ${JSON.stringify(silentResult.reasons)}`,
    );
    // Pre-existing gate facets still pass (proves we didn't regress the legacy checks).
    assert.equal(silentResult.facts.width, 1080);
    assert.equal(silentResult.facts.height, 1920);
    assert.equal(silentResult.facts.videoCodec, "h264");
    assert.equal(silentResult.facts.audioCodec, "aac");
    assert.ok(silentResult.facts.duration > 0);

    // Positive: a non-silent reel passes every check.
    const voiceResult = runMediaGate(voice);
    assert.equal(voiceResult.ok, true, `voice reel failed: ${JSON.stringify(voiceResult)}`);
    assert.ok(voiceResult.facts.voiceFraction >= DEFAULTS.minNonSilentFraction);

    // Spot-check measureVoiceFraction directly: a 4s sine is ~100% non-silent.
    const cfg = loadConfig({});
    const fraction = measureVoiceFraction(voice, cfg, voiceResult.facts.duration);
    assert.ok(fraction > 0.9, `expected near-100% voice fraction, got ${fraction}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
