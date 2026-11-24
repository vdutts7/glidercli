import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from mitmproxy import ctx


SCHEMA = "glider-mitm-exact/v1"


class ExactCapture:
    def __init__(self):
        self.capture_dir = None
        self.body_dir = None
        self.index_path = None
        self.terminal_count = 0
        self.response_count = 0
        self.error_count = 0
        self.capture_error_count = 0

    def load(self, loader):
        loader.add_option(
            "glider_capture_dir",
            str,
            "",
            "Private directory for Glider byte-exact proxy evidence.",
        )

    def running(self):
        configured = ctx.options.glider_capture_dir
        if not configured:
            raise RuntimeError("glider_capture_dir is required")
        self.capture_dir = Path(configured).resolve()
        self.body_dir = self.capture_dir / "bodies"
        self.index_path = self.capture_dir / "flows.jsonl"
        self.capture_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.body_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.capture_dir, 0o700)
        os.chmod(self.body_dir, 0o700)
        descriptor = os.open(
            self.index_path,
            os.O_CREAT | os.O_EXCL | os.O_WRONLY,
            0o600,
        )
        os.close(descriptor)
        self._write_json(
            self.capture_dir / "ready.json",
            {
                "schema": SCHEMA,
                "readyAt": self._now(),
                "pid": os.getpid(),
            },
        )

    def response(self, flow):
        self._record_terminal(flow, "response")

    def error(self, flow):
        self._record_terminal(flow, "error")

    def done(self):
        if self.capture_dir is None:
            return
        self._write_json(
            self.capture_dir / "final.json",
            {
                "schema": SCHEMA,
                "finishedAt": self._now(),
                "terminalCount": self.terminal_count,
                "responseCount": self.response_count,
                "errorCount": self.error_count,
                "captureErrorCount": self.capture_error_count,
            },
        )

    def _record_terminal(self, flow, terminal):
        try:
            request_body = self._store_body("request", flow.request.raw_content)
            response_body = None
            if flow.response is not None:
                response_body = self._store_body(
                    "response",
                    flow.response.raw_content,
                )
            row = {
                "schema": SCHEMA,
                "flowId": flow.id,
                "terminal": terminal,
                "observedAt": self._now(),
                "method": flow.request.method,
                "url": flow.request.pretty_url,
                "status": flow.response.status_code if flow.response is not None else None,
                "timestamps": {
                    "requestStart": flow.request.timestamp_start,
                    "requestEnd": flow.request.timestamp_end,
                    "responseStart": (
                        flow.response.timestamp_start
                        if flow.response is not None
                        else None
                    ),
                    "responseEnd": (
                        flow.response.timestamp_end
                        if flow.response is not None
                        else None
                    ),
                },
                "requestBody": request_body,
                "responseBody": response_body,
                "error": (
                    {
                        "message": flow.error.msg,
                        "timestamp": flow.error.timestamp,
                    }
                    if flow.error is not None
                    else None
                ),
            }
            self._append_json(row)
            self.terminal_count += 1
            if terminal == "response":
                self.response_count += 1
            else:
                self.error_count += 1
        except Exception as error:
            self.capture_error_count += 1
            self._append_capture_error(flow, terminal, error)
            raise

    def _store_body(self, kind, content):
        if content is None:
            return None
        digest = hashlib.sha256(content).hexdigest()
        relative = Path("bodies") / f"{kind}-{digest}.body"
        destination = self.capture_dir / relative
        if destination.exists():
            existing = destination.read_bytes()
            if len(existing) != len(content) or hashlib.sha256(existing).hexdigest() != digest:
                raise RuntimeError(f"existing body artifact failed validation: {relative}")
        else:
            temporary = self.capture_dir / f".{kind}-{digest}-{os.getpid()}.partial"
            descriptor = os.open(
                temporary,
                os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                0o600,
            )
            try:
                with os.fdopen(descriptor, "wb", closefd=True) as output:
                    output.write(content)
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, destination)
                os.chmod(destination, 0o600)
            finally:
                if temporary.exists():
                    temporary.unlink()
        return {
            "artifact": relative.as_posix(),
            "bytes": len(content),
            "sha256": digest,
        }

    def _append_json(self, value):
        payload = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
        descriptor = os.open(self.index_path, os.O_APPEND | os.O_WRONLY)
        with os.fdopen(descriptor, "ab", closefd=True) as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())

    def _append_capture_error(self, flow, terminal, error):
        path = self.capture_dir / "capture-errors.jsonl"
        payload = (
            json.dumps(
                {
                    "schema": SCHEMA,
                    "flowId": getattr(flow, "id", None),
                    "terminal": terminal,
                    "observedAt": self._now(),
                    "error": f"{type(error).__name__}: {error}",
                },
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n"
        ).encode()
        descriptor = os.open(
            path,
            os.O_APPEND | os.O_CREAT | os.O_WRONLY,
            0o600,
        )
        with os.fdopen(descriptor, "ab", closefd=True) as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())

    def _write_json(self, destination, value):
        temporary = destination.with_name(f".{destination.name}-{os.getpid()}.partial")
        payload = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
        descriptor = os.open(
            temporary,
            os.O_CREAT | os.O_EXCL | os.O_WRONLY,
            0o600,
        )
        try:
            with os.fdopen(descriptor, "wb", closefd=True) as output:
                output.write(payload)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, destination)
            os.chmod(destination, 0o600)
        finally:
            if temporary.exists():
                temporary.unlink()

    @staticmethod
    def _now():
        return datetime.now(timezone.utc).isoformat()


addons = [ExactCapture()]
