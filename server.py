"""Studio Recorder - local server.

Serves the recorder UI, receives recording chunks from the browser and writes them
straight to disk (no RAM limit on long recordings), then finalizes each recording
into an MP4 (H.264 + AAC 320k, faststart) with ffmpeg.

Run:  python server.py            (starts server + opens the recorder window)
      python server.py --no-browser
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

APP_DIR = Path(__file__).resolve().parent
PORT = 47615
URL = f"http://127.0.0.1:{PORT}/"
OUT_DIR = Path.home() / "Videos" / "Studio Recorder"
RAW_DIR = OUT_DIR / ".raw"
LOG_FILE = APP_DIR / "server.log"
IDLE_SHUTDOWN_S = 120  # exit when the recorder window has been closed this long
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

sessions = {}
sessions_lock = threading.Lock()
last_ping = time.time()


def log(msg):
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}\n")
    except OSError:
        pass


def ffmpeg_exe():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def unique_path(p: Path) -> Path:
    if not p.exists():
        return p
    i = 2
    while True:
        c = p.with_name(f"{p.stem}_{i}{p.suffix}")
        if not c.exists():
            return c
        i += 1


def finalize(sid):
    s = sessions[sid]
    raw: Path = s["raw"]
    label = "Reel" if s["mode"] == "vert" else "Video"
    stem = f"{s['started']:%Y-%m-%d_%H-%M-%S}_{label}"
    out = unique_path(OUT_DIR / f"{stem}.mp4")
    exe = ffmpeg_exe()
    try:
        if raw.stat().st_size == 0:
            raw.unlink(missing_ok=True)
            s.update(state="error", error="Recording was empty")
            return
        if exe:
            h264 = any(k in s["mime"].lower() for k in ("avc1", "h264"))
            cmd = [exe, "-y", "-hide_banner", "-loglevel", "error", "-fflags", "+genpts", "-i", str(raw)]
            if h264:
                cmd += ["-c:v", "copy"]
            else:
                cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p"]
            # aresample async: fill any audio gaps with silence so sound stays in sync with video
            cmd += ["-af", "aresample=async=1:first_pts=0", "-c:a", "aac", "-b:a", "320k", "-ar", "48000",
                    "-movflags", "+faststart", str(out)]
            r = subprocess.run(cmd, capture_output=True, text=True, creationflags=NO_WINDOW)
            if r.returncode == 0 and out.exists() and out.stat().st_size > 0:
                raw.unlink(missing_ok=True)
                s.update(state="done", file=str(out))
                log(f"saved {out} ({out.stat().st_size / 1e6:.1f} MB)")
                return
            log(f"ffmpeg failed for {sid}: {r.stderr[-1500:]}")
        fallback = unique_path(OUT_DIR / f"{stem}.{s['ext']}")
        shutil.move(str(raw), fallback)
        s.update(state="done", file=str(fallback),
                 warning="MP4 conversion unavailable - saved the original recording")
    except Exception as e:  # keep the raw file if anything goes wrong
        log(f"finalize error {sid}: {e!r}")
        s.update(state="error", error=f"{e}. Raw file kept at {raw}")


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".wasm": "application/wasm",
        ".tflite": "application/octet-stream",
        ".svg": "image/svg+xml",
    }

    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(APP_DIR), **k)

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _query(self):
        u = urlparse(self.path)
        return u.path, {k: v[0] for k, v in parse_qs(u.query).items()}

    def do_GET(self):
        global last_ping
        path, q = self._query()
        if path == "/api/ping":
            last_ping = time.time()
            return self._json({"ok": True})
        if path == "/api/info":
            return self._json({"outDir": str(OUT_DIR), "ffmpeg": bool(ffmpeg_exe())})
        if path == "/api/status":
            s = sessions.get(q.get("id", ""))
            if not s:
                return self._json({"error": "unknown id"}, 404)
            return self._json({k: s.get(k) for k in ("state", "file", "error", "warning", "bytes")})
        if path == "/api/open-folder":
            f = q.get("file")
            if f and Path(f).exists():
                subprocess.Popen(["explorer", "/select,", str(Path(f))])
            else:
                os.startfile(OUT_DIR)
            return self._json({"ok": True})
        if path == "/api/combine/files":
            return self._json({"face": recent_videos(ZOOM_DIR, "*/*"), "screen": [v for v in recent_videos(OUT_DIR, "*") if "_Combined_" not in v["path"]]})
        if path == "/api/combine/status":
            j = jobs.get(q.get("id", ""))
            if not j:
                return self._json({"error": "unknown id"}, 404)
            return self._json({k: j.get(k) for k in ("state", "progress", "file", "error")})
        if path.startswith("/api/"):
            return self._json({"error": "not found"}, 404)
        return super().do_GET()

    def do_POST(self):
        path, q = self._query()
        n = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(n) if n else b""

        if path.startswith("/api/combine/"):
            try:
                params = json.loads(data or b"{}")
                if path == "/api/combine/cancel":
                    j = jobs.get(params.get("id", ""))
                    if j and j.get("proc"):
                        j["proc"].kill()
                    return self._json({"ok": True})
                params["screenPath"] = video_path(params.get("screenPath"))
                params["facePath"] = video_path(params.get("facePath"))
                if path == "/api/combine/analyze":
                    return self._json(combine_analysis(params["screenPath"], params["facePath"]))
                if path == "/api/combine/preview":
                    import combine
                    import tempfile
                    a = combine_analysis(params["screenPath"], params["facePath"])
                    with tempfile.TemporaryDirectory() as tmp:
                        img = Path(tmp) / "preview.jpg"
                        r = combine.run([*combine.command(a, params, img, Path(tmp), at=float(params.get("at", 5)))])
                        if not img.exists():
                            raise RuntimeError(r.stderr.decode("utf-8", "replace")[-600:])
                        body = img.read_bytes()
                    self.send_response(200)
                    self.send_header("Content-Type", "image/jpeg")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                if path == "/api/combine/render":
                    jid = uuid.uuid4().hex[:10]
                    jobs[jid] = {"state": "rendering", "progress": 0.0}
                    threading.Thread(target=run_render, args=(jid, params), daemon=True).start()
                    return self._json({"id": jid})
            except Exception as e:
                log(f"combine error: {e!r}")
                return self._json({"error": str(e)}, 400)
            return self._json({"error": "not found"}, 404)

        if path == "/api/start":
            ext = q.get("ext") if q.get("ext") in ("mp4", "webm") else "webm"
            sid = uuid.uuid4().hex[:12]
            raw = RAW_DIR / f"{sid}.{ext}"
            raw.write_bytes(b"")
            with sessions_lock:
                sessions[sid] = {
                    "raw": raw, "ext": ext, "mime": q.get("mime", ""), "mode": q.get("mode", "land"),
                    "started": datetime.now(), "state": "recording", "bytes": 0, "lock": threading.Lock(),
                }
            log(f"start {sid} mime={q.get('mime')} mode={q.get('mode')}")
            return self._json({"id": sid})

        s = sessions.get(q.get("id", ""))
        if not s:
            return self._json({"error": "unknown id"}, 404)

        if path == "/api/chunk":
            with s["lock"]:
                with open(s["raw"], "r+b") as f:
                    if "pos" in q:  # MP4 muxer writes at explicit byte offsets
                        f.seek(int(q["pos"]))
                    else:
                        f.seek(0, os.SEEK_END)
                    f.write(data)
                s["bytes"] += len(data)
            return self._json({"ok": True, "bytes": s["bytes"]})

        if path == "/api/finish":
            if s["state"] == "recording":
                s["state"] = "finalizing"
                threading.Thread(target=finalize, args=(q["id"],), daemon=True).start()
            return self._json({"ok": True})

        return self._json({"error": "not found"}, 404)


# ---------------------------------------------------------------- combine (face video + screen video)
ZOOM_DIR = Path.home() / "Documents" / "Zoom"
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm", ".m4v"}
analyses = {}
jobs = {}


def video_path(p):
    path = Path(p or "")
    if not path.is_file() or path.suffix.lower() not in VIDEO_EXT:
        raise ValueError(f"not a video file: {p}")
    return str(path)


def recent_videos(folder, pattern, limit=40):
    if not folder.exists():
        return []
    files = sorted(folder.glob(pattern), key=lambda f: f.stat().st_mtime, reverse=True)
    out = []
    for f in files:
        if f.suffix.lower() in VIDEO_EXT and f.stat().st_size > 200_000:
            out.append({"path": str(f), "name": f"{f.parent.name if folder == ZOOM_DIR else ''} {f.name}".strip(),
                        "mtime": f.stat().st_mtime, "mb": round(f.stat().st_size / 1e6, 1)})
        if len(out) >= limit:
            break
    return out


def combine_analysis(screen, face):
    import combine
    key = (screen, face)
    if key not in analyses:
        analyses[key] = combine.analyze(screen, face)
    return analyses[key]


def run_render(jid, params):
    import combine
    import tempfile
    job = jobs[jid]
    try:
        a = combine_analysis(params["screenPath"], params["facePath"])
        _, _, dur = combine.timing(a, params)
        dur = min(dur, float(params.get("trimEnd") or dur)) - float(params.get("trimStart", 0))
        label = "Reel" if params["format"] == "vert" else "Video"
        out = unique_path(OUT_DIR / f"{datetime.now():%Y-%m-%d_%H-%M-%S}_Combined_{label}_{params['layout']}.mp4")
        job["file"] = str(out)
        with tempfile.TemporaryDirectory() as tmp:
            cmd = [combine.FF, "-hide_banner", "-loglevel", "error", *combine.command(a, params, out, Path(tmp))]
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, creationflags=NO_WINDOW)
            job["proc"] = proc
            for line in proc.stdout:
                if line.startswith("out_time_us=") and line.strip() != "out_time_us=N/A":
                    job["progress"] = min(0.999, int(line.split("=")[1]) / 1e6 / max(dur, 0.1))
            err = proc.stderr.read()
            proc.wait()
        if proc.returncode == 0 and out.exists():
            job.update(state="done", progress=1.0)
            log(f"combined {out}")
        else:
            out.unlink(missing_ok=True)
            job.update(state="error", error=(err or "render cancelled")[-800:])
    except Exception as e:
        log(f"render error: {e!r}")
        job.update(state="error", error=str(e))


def find_browser():
    env = os.path.expandvars
    for p in (
        r"%ProgramFiles%\Google\Chrome\Application\chrome.exe",
        r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe",
        r"%LocalAppData%\Google\Chrome\Application\chrome.exe",
        r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe",
        r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe",
    ):
        if Path(env(p)).exists():
            return env(p)
    return None


def launch_browser():
    exe = find_browser()
    if not exe:
        webbrowser.open(URL)
        return
    profile = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "StudioRecorder" / "browser-profile"
    subprocess.Popen([
        exe, f"--app={URL}", f"--user-data-dir={profile}", "--window-size=1520,960",
        "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required",
        # keep rendering/recording at full speed while the window is minimized or covered
        "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion",
    ])


def port_in_use():
    with socket.socket() as sock:
        sock.settimeout(0.3)
        return sock.connect_ex(("127.0.0.1", PORT)) == 0


def watchdog(srv):
    while True:
        time.sleep(15)
        busy = any(s["state"] in ("recording", "finalizing") for s in list(sessions.values())) or             any(j["state"] == "rendering" for j in list(jobs.values()))
        if not busy and time.time() - last_ping > IDLE_SHUTDOWN_S:
            log("idle - shutting down")
            srv.shutdown()
            return


def main():
    no_browser = "--no-browser" in sys.argv
    if port_in_use():
        if not no_browser:
            launch_browser()
        return
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=watchdog, args=(srv,), daemon=True).start()
    log(f"server on {URL}, saving to {OUT_DIR}")
    if not no_browser:
        launch_browser()
    srv.serve_forever()


if __name__ == "__main__":
    main()
