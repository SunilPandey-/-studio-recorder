# Studio Recorder

Local screen recorder for Windows: screen + face cam, 16:9 videos or 9:16 Reels/Shorts,
background blur, auto-framing and face enhancement. Runs in Chrome/Edge as an app window,
saves MP4 (H.264 + AAC 320k) to `%USERPROFILE%\Videos\Studio Recorder`.

## Start
Double-click **`Studio Recorder.bat`** (or `python server.py`). It starts a tiny local server
(127.0.0.1:47615) and opens the recorder in a dedicated Chrome/Edge window. The server exits by
itself ~2 min after the window is closed.

## Use
1. **Output** – Full video 16:9 (720p–4K) or Reel/Short 9:16 (1080×1920), 30/60 fps.
2. **Choose screen / window** – tick *Also share system audio* in Chrome's dialog for PC sound.
3. **Layout** (keys 1–4, switchable while recording)
   - 16:9: Screen + Face bubble · Side by side · Face only · Screen only
   - 9:16: Stacked (screen top, face bottom) · Screen + Face · Face only · Screen only
4. **Face cam** – size, shape (circle / rounded / square / tall card for head + body / cut-out),
   drag it on the preview, scroll over it to resize. *Auto-frame* keeps your face centred.
   *Zoom*: right enlarges your face, left (down to 0.5×) zooms out to show more of you; below 1×
   the edges are filled with a soft blurred extension of the scene.
5. **Background** – original, blur, or solid colour (person segmentation, MediaPipe).
6. **Face beautify** (GPU, skin only) – presets Off / Natural / Soft / Glam, plus sliders:
   remove spots & dark patches, smooth skin, even tone, brighten, sharpen eyes & details.
   *Hold to compare* shows the original; *Show skin area* highlights where it is applied.
   Also auto light, warmth, contrast, vibrance.
7. **Audio** – voice enhance (EQ + leveller + limiter), noise suppression, echo cancellation, levels.
8. **Record** (`R`), **Pause** (`P`), **Stop**. *Mini controls* opens a small always-on-top
   controller (note: it is visible if you record the entire screen).

Tip: when recording the entire screen, minimize the recorder window (it keeps recording at full
speed) or record a specific window instead.

## Combine a Zoom face recording + a screen recording
For Zoom's camera quality (Touch up, low light) with these layouts: open **Combine Zoom + screen →**
(top of the recorder) or `combine.html`.
1. Zoom: meeting alone, Touch up / low light / blur on, **no screen share**, *Record on this computer*.
2. Studio Recorder: layout **Screen only**, Record. Clap once at the start.
3. In Combine: pick both files (newest first), **Sync & find face**, choose 16:9 or Reel and a layout
   (side by side, screen + face, stacked, face only), adjust zoom/shape, preview, **Create video**.
Sync is automatic from the audio (adjustable ±0.1 s); the face is located with OpenCV YuNet.
Output: `Videos\Studio Recorder\<date>_Combined_<Video|Reel>_<layout>.mp4` (H.264 CRF 18 + AAC).

## How it works
- `app.js` – capture, compositing on a canvas, UI. Video is encoded with WebCodecs H.264
  (hardware when available); MediaRecorder is the fallback.
- `vision-worker.js` – MediaPipe selfie segmentation + Face Landmarker (478 points) in a worker.
- `beauty.js` – WebGL2 beautifier: skin mask from landmarks + skin-colour test; frequency-separation
  smoothing; spot removal by morphological closing (black top-hat) with a hair/brow density guard.
- `encoder-worker.js` – Opus audio encoding + MP4 muxing (`vendor/mp4-muxer.mjs`), streamed to disk.
- `combine.py` – audio sync, face location and the ffmpeg layout graph for Combine.
- `server.py` – serves the app, writes chunks to disk, finalizes with ffmpeg (from `imageio-ffmpeg`).
- The screen is captured at the output size (not native 4K) to keep the pipeline light.

Troubleshooting URL switches: `?engine=mediarecorder` (fallback recorder), `?encoder=software`.
Logs: `server.log`.
