"""A small OpenAI-compatible speech endpoint around Kokoro, a local neural voice model."""

import io
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import soundfile as sf
from kokoro_onnx import Kokoro

MODELS = "/app/tts-models"
kokoro = Kokoro(MODELS + "/kokoro-v1.0.onnx", MODELS + "/voices-v1.0.bin")
voices = set(kokoro.get_voices())
# One synthesis at a time: parallel runs only compete for the same CPU cores.
lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body, kind="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", kind)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, {"ok": True, "voices": sorted(voices)})
        self.reply(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/v1/audio/speech":
            return self.reply(404, {"error": "Not found"})
        try:
            length = int(self.headers.get("content-length", 0))
            if not 0 < length <= 200_000:
                raise ValueError("Request body is missing or too large")
            request = json.loads(self.rfile.read(length))
            text = str(request.get("input", "")).strip()[:16_000]
            voice = str(request.get("voice") or "af_heart")
            if not text:
                raise ValueError("Nothing to speak")
            if voice not in voices:
                raise ValueError("Unknown voice: " + voice[:60])
            # British voice ids start with "b".
            language = "en-gb" if voice.startswith("b") else "en-us"
            with lock:
                samples, rate = kokoro.create(
                    text, voice=voice, speed=1.0, lang=language
                )
            audio = io.BytesIO()
            sf.write(audio, samples, rate, format="MP3")
            self.reply(200, audio.getvalue(), "audio/mpeg")
        except (ValueError, TypeError, AttributeError) as error:
            self.reply(400, {"error": str(error)})


ThreadingHTTPServer(("0.0.0.0", 8880), Handler).serve_forever()
