#!/usr/bin/env bash
# build_reel.sh — Golpo animation + static image → 9:16 reel mp4
# Usage: build_reel.sh "<headline>" "<post_body>" "<static_image_url_or_path>" "<output_path>"
# Env: GOLPOAI_API_KEY, GOLPOAI_API_BASE_URL (default https://api.golpoai.com)
# Output: final 9:16 reel mp4 at <output_path>
# Requires: ffmpeg, curl, jq
# Defaults: loaded from golpoai-defaults.json (mirror of golpoai-runbook skill §7)
# Governance: https://paperclip-vicf.srv1571762.hstgr.cloud (skill e95e1ff3-4515-4429-a94a-2bc2715e2fc1)

set -euo pipefail

HEADLINE="${1:?Headline required}"
POST_BODY="${2:?Post body required}"
STATIC_IMAGE="${3:?Static image URL or path required}"
OUTPUT="${4:?Output path required}"

API_BASE="${GOLPOAI_API_BASE_URL:-https://api.golpoai.com}"
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

echo "[build_reel] Workdir: $WORKDIR"

# --- Load §7 defaults from golpoai-defaults.json ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULTS_FILE="$SCRIPT_DIR/golpoai-defaults.json"
if [ ! -f "$DEFAULTS_FILE" ]; then
  echo "[build_reel] ERROR: $DEFAULTS_FILE not found. Cannot proceed without §7 defaults." >&2
  exit 1
fi
echo "[build_reel] Loaded defaults from $DEFAULTS_FILE"

# --- Step 1: Submit Golpo render ---
PROMPT="$HEADLINE

$POST_BODY"

echo "[build_reel] Submitting Golpo render..."
SUBMIT_RESP=$(curl -sf -X POST "$API_BASE/api/v2/videos/generate" \
  -H "x-api-key: $GOLPOAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg prompt "$PROMPT" \
    --slurpfile d "$DEFAULTS_FILE" \
    '$d[0] | del(._source, ._note) | .prompt = $prompt')")

JOB_ID=$(echo "$SUBMIT_RESP" | jq -r '.job_id')
echo "[build_reel] Golpo job_id: $JOB_ID"

if [ -z "$JOB_ID" ] || [ "$JOB_ID" = "null" ]; then
  echo "[build_reel] ERROR: No job_id returned. Response: $SUBMIT_RESP" >&2
  exit 1
fi

# --- Step 2: Poll until completed (max 120 min) ---
MAX_WAIT=7200
POLL_INTERVAL=60
ELAPSED=0
VIDEO_URL=""

echo "[build_reel] Polling job $JOB_ID (max ${MAX_WAIT}s)..."
while [ $ELAPSED -lt $MAX_WAIT ]; do
  STATUS_RESP=$(curl -sf "$API_BASE/api/v2/videos/status/$JOB_ID" \
    -H "x-api-key: $GOLPOAI_API_KEY")
  STATUS=$(echo "$STATUS_RESP" | jq -r '.status')
  VIDEO_URL=$(echo "$STATUS_RESP" | jq -r '.video_url // empty')

  echo "[build_reel] ${ELAPSED}s: status=$STATUS"

  if [ "$STATUS" = "completed" ] && [ -n "$VIDEO_URL" ]; then
    echo "[build_reel] Completed. URL: $VIDEO_URL"
    break
  fi

  sleep $POLL_INTERVAL
  ELAPSED=$((ELAPSED + POLL_INTERVAL))
done

if [ -z "$VIDEO_URL" ]; then
  echo "[build_reel] ERROR: Timed out or no video_url after ${ELAPSED}s" >&2
  exit 1
fi

# --- Step 3: Download Golpo mp4 ---
GOLPO_MP4="$WORKDIR/golpo.mp4"
echo "[build_reel] Downloading Golpo mp4..."
curl -sf -L -o "$GOLPO_MP4" "$VIDEO_URL"
echo "[build_reel] Golpo mp4 saved: $(du -h "$GOLPO_MP4" | cut -f1)"

# --- Step 4: Prepare static image (download if URL) ---
if echo "$STATIC_IMAGE" | grep -qE '^https?://'; then
  STATIC_LOCAL="$WORKDIR/static_image.jpg"
  curl -sf -L -o "$STATIC_LOCAL" "$STATIC_IMAGE"
  STATIC_IMAGE="$STATIC_LOCAL"
fi

# --- Step 5: Build 3s intro from static image (1080x1920, black canvas) ---
INTRO_MP4="$WORKDIR/intro.mp4"
echo "[build_reel] Building 3s intro from static image..."
ffmpeg -y -loop 1 -i "$STATIC_IMAGE" -t 3 \
  -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1" \
  -c:v libx264 -pix_fmt yuv420p -r 30 \
  -an \
  "$INTRO_MP4"

# --- Step 6: Reframe Golpo 16:9 → 9:16 (black canvas, no crop) ---
GOLPO_9X16="$WORKDIR/golpo_9x16.mp4"
echo "[build_reel] Reframing Golpo 1536x864 → 1080x1920 (black canvas)..."
ffmpeg -y -i "$GOLPO_MP4" \
  -vf "scale=1080:608:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30" \
  -c:v libx264 -pix_fmt yuv420p -r 30 \
  -c:a aac -ar 44100 \
  "$GOLPO_9X16"

# --- Step 7: Concat intro + animation ---
CONCAT_LIST="$WORKDIR/concat.txt"
printf "file '%s'\nfile '%s'\n" "$INTRO_MP4" "$GOLPO_9X16" > "$CONCAT_LIST"

echo "[build_reel] Concatenating intro + animation..."
ffmpeg -y -f concat -safe 0 -i "$CONCAT_LIST" \
  -c:v libx264 -pix_fmt yuv420p -r 30 \
  -c:a aac -ar 44100 \
  "$OUTPUT"

echo "[build_reel] Done. Final reel: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
