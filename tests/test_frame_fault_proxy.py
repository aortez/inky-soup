import http.client
import importlib.util
import json
from contextlib import closing
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

spec = importlib.util.spec_from_file_location(
    "frame_fault_proxy", Path(__file__).parents[1] / "app/tools/frame-fault-proxy.py")
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


class FaultProxyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.received = []
        self.received_event = threading.Event()
        owner = self

        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                owner.received.append(body)
                owner.received_event.set()
                try:
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b'{"job_id":7}')
                except (BrokenPipeError, ConnectionResetError):
                    pass

            do_GET = do_POST

        self.upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        state = proxy.ProxyState(f"http://127.0.0.1:{self.upstream.server_port}",
                                 self.root / "fault.json", self.root / "audit.jsonl")
        self.server = proxy.make_server("127.0.0.1", 0, state)
        for server in (self.upstream, self.server):
            threading.Thread(target=server.serve_forever, daemon=True).start()

    def tearDown(self):
        for server in (self.server, self.upstream):
            server.shutdown()
            server.server_close()
        self.directory.cleanup()

    def request(self, path="/flash", body=b"request-body", method="POST"):
        with closing(http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)) as connection:
            connection.request(method, path, body)
            return connection.getresponse().read()

    def arm(self, mode):
        (self.root / "fault.json").write_text(json.dumps({"id": "case-1", "path": "/flash", "mode": mode}))

    def test_cut_request_forwards_only_a_prefix(self):
        self.arm("cut-request")
        with self.assertRaises((http.client.RemoteDisconnected, ConnectionResetError)):
            self.request(body=b"x" * 10000)
        self.assertTrue(self.received_event.wait(3))
        self.assertEqual(self.received, [b"x" * 4096])

    def test_drop_response_does_not_resubmit_and_fires_once(self):
        self.arm("drop-response")
        with self.assertRaises((http.client.RemoteDisconnected, ConnectionResetError)):
            self.request()
        self.assertEqual(self.received, [b"request-body"])
        self.assertEqual(self.request(), b'{"job_id":7}')
        self.assertEqual(len(self.received), 2)

    def test_other_paths_pass_and_keep_fault_armed(self):
        self.arm("drop-response")
        self.assertEqual(self.request("/api/upload-thumb"), b'{"job_id":7}')
        with self.assertRaises((http.client.RemoteDisconnected, ConnectionResetError)):
            self.request()
        self.assertEqual(len(self.received), 2)

    def test_status_prefix_drops_one_get_without_resubmitting(self):
        (self.root / "fault.json").write_text(json.dumps({
            "id": "status", "path": "/api/flash/status/", "prefix": True,
            "method": "GET", "mode": "drop-response"}))
        with self.assertRaises((http.client.RemoteDisconnected, ConnectionResetError)):
            self.request("/api/flash/status/7", body=None, method="GET")
        self.assertEqual(self.received, [b""])
        self.assertEqual(self.request("/api/flash/status/7", body=None, method="GET"), b'{"job_id":7}')
        self.assertEqual(self.received, [b"", b""])


if __name__ == "__main__":
    unittest.main()
