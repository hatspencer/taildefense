#!/usr/bin/env python3
"""Screenshots of the browser client from a headless Chrome, with nothing but the stdlib.

    tools/shot.py '#lab=h0&dist=6' screenshots/art-hero0.png
    tools/shot.py '#demo&nosplash&vol=0' screenshots/art-demo.png --wait 30 --size 1600x900
    tools/shot.py '#lab=3' screenshots/art-walk.png --frames 6 --every 0.15   # art-walk-0.png ...
    tools/shot.py '#demo&nosplash' out.png --eval 'document.title'              # prints the value

Loads internal/web/dist/index.html of the checkout this file is in (build it first with
./build.sh web) from file://, waits for the scene (shaders take a while to compile), and
writes PNGs. Each run starts its own Chrome on its own port with its own profile, so any
number can run side by side. Console errors are printed to stderr. Exit 1 if the page
threw or nothing was drawn.
"""
import argparse
import base64
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class WS:
    """A minimal RFC 6455 client: text frames, masked on the way out."""

    def __init__(self, url):
        assert url.startswith('ws://')
        hostport, path = url[5:].split('/', 1)
        host, port = hostport.split(':')
        self.s = socket.create_connection((host, int(port)))
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f'GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\n'
                        f'Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n'
                        'Sec-WebSocket-Version: 13\r\n\r\n').encode())
        buf = b''
        while b'\r\n\r\n' not in buf:
            buf += self.s.recv(4096)
        self.buf = buf.split(b'\r\n\r\n', 1)[1]

    def send(self, text):
        data = text.encode()
        head = bytearray([0x81])
        n = len(data)
        if n < 126:
            head.append(0x80 | n)
        elif n < 65536:
            head.append(0x80 | 126)
            head += struct.pack('>H', n)
        else:
            head.append(0x80 | 127)
            head += struct.pack('>Q', n)
        mask = os.urandom(4)
        head += mask
        self.s.sendall(bytes(head) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.s.recv(1 << 20)
            if not chunk:
                raise ConnectionError('chrome closed the socket')
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self, timeout=None):
        self.s.settimeout(timeout)
        try:
            msg = b''
            while True:
                b0, b1 = self._read(2)
                n = b1 & 0x7F
                if n == 126:
                    n = struct.unpack('>H', self._read(2))[0]
                elif n == 127:
                    n = struct.unpack('>Q', self._read(8))[0]
                payload = self._read(n)
                op = b0 & 0x0F
                if op == 8:
                    raise ConnectionError('chrome closed the socket')
                if op in (0, 1, 2):
                    msg += payload
                    if b0 & 0x80:
                        return msg.decode('utf-8', 'replace')
        except socket.timeout:
            return None
        finally:
            self.s.settimeout(None)


class Page:
    def __init__(self, ws):
        self.ws, self.id, self.errors = ws, 0, []

    def _event(self, m):
        method = m.get('method')
        if method == 'Runtime.exceptionThrown':
            d = m['params']['exceptionDetails']
            self.errors.append(d.get('exception', {}).get('description') or d.get('text', 'exception'))
        elif method == 'Runtime.consoleAPICalled' and m['params']['type'] == 'error':
            self.errors.append(' '.join(str(a.get('value', a.get('description', ''))) for a in m['params']['args']))

    def call(self, method, **params):
        self.id += 1
        self.ws.send(json.dumps({'id': self.id, 'method': method, 'params': params}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get('id') == self.id:
                if 'error' in m:
                    raise RuntimeError(f"{method}: {m['error']}")
                return m.get('result', {})
            self._event(m)

    def wait(self, secs):
        end = time.time() + secs
        while True:
            left = end - time.time()
            if left <= 0:
                return
            raw = self.ws.recv(timeout=left)
            if raw:
                self._event(json.loads(raw))

    def eval(self, expr):
        r = self.call('Runtime.evaluate', expression=expr, returnByValue=True, awaitPromise=True)
        return r.get('result', {}).get('value')

    def shot(self, path):
        r = self.call('Page.captureScreenshot', format='png')
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, 'wb') as f:
            f.write(base64.b64decode(r['data']))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('hash', help="the page's hash, e.g. '#lab=h0' or '#demo&nosplash'")
    ap.add_argument('out', help='PNG to write; with --frames, out-0.png, out-1.png, ...')
    ap.add_argument('--wait', type=float, default=22, help='seconds to wait before the first shot (default 22)')
    ap.add_argument('--size', default='1280x800', help='viewport, WxH (default 1280x800)')
    ap.add_argument('--frames', type=int, default=1, help='shots to take')
    ap.add_argument('--every', type=float, default=0.2, help='seconds between frames')
    ap.add_argument('--keys', default='', help="keys to press before the first shot, e.g. 'b,1' (KeyboardEvent.key values)")
    ap.add_argument('--click', default='', help="a click at 'x,y' (viewport pixels) before the first shot")
    ap.add_argument('--eval', default='', help='a JavaScript expression to evaluate after the wait; its value is printed')
    ap.add_argument('--page', default='', help='another HTML file to load instead of the built client')
    a = ap.parse_args()

    chrome = os.environ.get('CHROME') or shutil.which('google-chrome') or shutil.which('chromium') or shutil.which('chromium-browser')
    if not chrome:
        sys.exit('shot: no google-chrome or chromium on PATH (set CHROME)')
    index = a.page or os.path.join(ROOT, 'internal/web/dist/index.html')
    if not os.path.exists(index):
        sys.exit(f'shot: {index} is missing; run ./build.sh web first')
    w, h = (int(v) for v in a.size.split('x'))
    profile = tempfile.mkdtemp(prefix='td-shot-')
    # No swiftshader flags: the scene renders black with them. The GPU is used when there is one.
    proc = subprocess.Popen(
        [chrome, '--headless=new', '--remote-debugging-port=0', f'--user-data-dir={profile}',
         f'--window-size={w},{h}', '--hide-scrollbars', '--mute-audio', '--no-first-run',
         '--no-default-browser-check', '--allow-file-access-from-files', '--enable-unsafe-webgpu',
         '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
         '--disable-backgrounding-occluded-windows', 'about:blank'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    rc = 0
    try:
        port_file = os.path.join(profile, 'DevToolsActivePort')
        for _ in range(100):
            if os.path.exists(port_file) and open(port_file).read().strip():
                break
            time.sleep(0.1)
        else:
            sys.exit('shot: chrome did not start')
        port = open(port_file).read().split()[0]
        tabs = json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json'))
        tab = next(t for t in tabs if t['type'] == 'page')
        page = Page(WS(tab['webSocketDebuggerUrl']))
        page.call('Page.enable')
        page.call('Runtime.enable')
        page.call('Network.enable')
        page.call('Network.setCacheDisabled', cacheDisabled=True)
        page.call('Emulation.setDeviceMetricsOverride', width=w, height=h, deviceScaleFactor=1, mobile=False)
        page.call('Page.navigate', url='file://' + os.path.abspath(index) + a.hash)
        page.wait(a.wait)
        if a.click:
            x, y = (float(v) for v in a.click.split(','))
            for kind in ('mousePressed', 'mouseReleased'):
                page.call('Input.dispatchMouseEvent', type=kind, x=x, y=y, button='left', clickCount=1)
            page.wait(0.3)
        for key in [k for k in a.keys.split(',') if k]:
            code = ('Key' + key.upper()) if len(key) == 1 and key.isalpha() else ('Digit' + key) if key.isdigit() else key
            for kind in ('keyDown', 'keyUp'):
                page.call('Input.dispatchKeyEvent', type=kind, key=key, code=code, text=key if kind == 'keyDown' and len(key) == 1 else '')
            page.wait(0.3)
        if a.eval:
            print(json.dumps(page.eval(a.eval)))
        base, ext = os.path.splitext(a.out)
        for i in range(a.frames):
            path = a.out if a.frames == 1 else f'{base}-{i}{ext}'
            page.shot(path)
            print(path)
            if i + 1 < a.frames:
                page.wait(a.every)
        for e in page.errors:
            print('console error:', e, file=sys.stderr)
        if page.errors:
            rc = 1
    finally:
        proc.terminate()
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)
    sys.exit(rc)


if __name__ == '__main__':
    main()
