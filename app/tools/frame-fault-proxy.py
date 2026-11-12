#!/usr/bin/env python3
"""Forward frame HTTP traffic, interrupting one named request for hardware tests.

Write {"id":"unique-case", "path":"/api/upload-thumb", "mode":"cut-request"}
to --fault-file to cut an upstream request body, or use "drop-response" to
discard a response after the frame has handled the request. Each id fires once.
The JSONL audit records attempts and upstream outcomes without photo bodies.
"""

import argparse
import hashlib
import http.client
import ipaddress
import json
from pathlib import Path
import re
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

MAX_BODY = 24 * 1024 * 1024
HOP_HEADERS = {"connection", "keep-alive", "proxy-connection", "transfer-encoding",
               "te", "trailer", "upgrade", "host", "content-length"}


class ProxyState:
    def __init__(self, upstream, fault_file, audit_file):
        self.upstream = urlsplit(upstream)
        address = ipaddress.ip_address(self.upstream.hostname)
        if (self.upstream.scheme != "http" or not address.is_private
                or self.upstream.path not in ("", "/") or self.upstream.query
                or self.upstream.fragment or self.upstream.username):
            raise ValueError("Use a private HTTP upstream origin without credentials or a path")
        self.fault_file = Path(fault_file)
        self.audit_file = Path(audit_file)
        self.lock = threading.Lock()
        self.used = set()
        self.sequence = 0

    def start(self, method, path):
        with self.lock:
            self.sequence += 1
            sequence = self.sequence
            fault = None
            if self.fault_file.exists():
                plan = json.loads(self.fault_file.read_text())
                matches = path.startswith(plan["path"]) if plan.get("prefix") else path == plan["path"]
                if (matches and method == plan.get("method", "POST")
                        and plan["id"] not in self.used):
                    if plan["mode"] not in ("cut-request", "drop-response"):
                        raise ValueError("Unknown fault mode")
                    self.used.add(plan["id"])
                    fault = plan
            self._append({"event": "start", "sequence": sequence, "method": method,
                          "path": path, "fault": fault})
            return sequence, fault

    def _append(self, event):
        event["time_unix_ms"] = round(time.time() * 1000)
        with self.audit_file.open("a") as output:
            output.write(json.dumps(event, separators=(",", ":")) + "\n")

    def finish(self, sequence, **fields):
        with self.lock:
            self._append({"event": "finish", "sequence": sequence, **fields})


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def disconnect(self):
        self.close_connection = True
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.connection.close()

    def do_GET(self):
        self.forward()

    def do_POST(self):
        self.forward()

    def forward(self):
        if not self.path.startswith("/") or self.path.startswith("//"):
            self.send_error(400)
            return
        state = self.server.proxy_state
        sequence, fault = state.start(self.command, self.path)
        fields = {}
        connection = None
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 <= length <= MAX_BODY or self.headers.get("Transfer-Encoding"):
                self.send_error(413)
                return
            self.connection.settimeout(65)
            body = self.rfile.read(length)
            fields.update(request_bytes=len(body), request_sha256=hashlib.sha256(body).hexdigest())
            filename = re.search(rb'filename="([^"\r\n]+)"', body[:4096])
            if filename:
                fields["filename"] = filename[1].decode("utf-8", errors="replace")
            if len(body) != length:
                raise ConnectionError("Client disconnected before completing its body")
            upstream = state.upstream
            connection = http.client.HTTPConnection(upstream.hostname, upstream.port or 80, timeout=65)
            headers = {key: value for key, value in self.headers.items() if key.lower() not in HOP_HEADERS}
            headers.update({"Content-Length": str(length), "Connection": "close"})
            if fault and fault["mode"] == "cut-request":
                if length < 2:
                    raise ValueError("cut-request requires a body of at least two bytes")
                prefix = max(1, min(4096, length // 2))
                connection.request(self.command, self.path, body[:prefix], headers)
                connection.sock.shutdown(socket.SHUT_RDWR)
                fields.update(forwarded_bytes=prefix, outcome="request-cut")
                self.disconnect()
                return
            fields["forwarded_bytes"] = length
            connection.request(self.command, self.path, body, headers)
            response = connection.getresponse()
            result = response.read(MAX_BODY + 1)
            if len(result) > MAX_BODY:
                raise ValueError("Upstream response exceeded limit")
            fields.update(upstream_status=response.status, response_bytes=len(result))
            if self.path == "/flash" or self.path.startswith("/api/flash/status/"):
                fields["upstream_json"] = json.loads(result)
            if fault and fault["mode"] == "drop-response":
                fields["outcome"] = "response-dropped"
                self.disconnect()
                return
            self.send_response(response.status)
            self.send_header("Content-Type", response.getheader("Content-Type", "application/octet-stream"))
            self.send_header("Content-Length", str(len(result)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(result)
            self.close_connection = True
            fields["outcome"] = "forwarded"
        except (OSError, ValueError, http.client.HTTPException) as error:
            fields.update(outcome="error", error=str(error))
            self.disconnect()
        finally:
            if connection:
                connection.close()
            state.finish(sequence, **fields)


def make_server(bind, port, state):
    server = ThreadingHTTPServer((bind, port), Handler)
    server.proxy_state = state
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", required=True)
    parser.add_argument("--fault-file", required=True)
    parser.add_argument("--audit-file", required=True)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18080)
    args = parser.parse_args()
    state = ProxyState(args.upstream, args.fault_file, args.audit_file)
    with make_server(args.bind, args.port, state) as server:
        print(json.dumps({"listening": server.server_address, "upstream": args.upstream}), file=sys.stderr, flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
