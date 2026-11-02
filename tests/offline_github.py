# -*- coding: utf-8 -*-
"""
离线仿真一个最小的 github.com：自签证书 + 桩 HTTP(S) 服务。

为什么需要：内容脚本只匹配 https://github.com/*，而本机对 github.com 的连接时好时坏
（整个会话里 RST/超时反复出现），导致「快捷键触发后给出与按钮同款提示」这类
只能靠真实页面验证的用例长期跑不到。把 github.com 映射到本地桩之后，
控制条、提示文案、去重逻辑都能确定性验证。

只提供被测点需要的最小响应：
  *.zip            → application/zip 的真 zip（几十字节），让队列能正常收敛到 done
  其它任意路径      → 一个含 results-list 或普通标题的 HTML 骨架
"""
import io
import os
import socket
import ssl
import subprocess
import tempfile
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def tiny_zip():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("README.md", "# offline stub repo\n")
        z.writestr("src/main.js", "console.log('gzg offline fixture');\n")
    return buf.getvalue()


ZIP_BYTES = tiny_zip()

REPO_HTML = """<!doctype html><html><head><meta charset="utf-8"><title>stub repo</title></head>
<body><h1>octocat / Hello-World</h1><div id="stub">本地仿真仓库页</div></body></html>"""


SAN_HOSTS = ["github.com", "*.github.com", "codeload.github.com", "api.github.com", "raw.githubusercontent.com"]

CNF = """[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = github.com
[v3]
subjectAltName = @alt
basicConstraints = CA:TRUE
keyUsage = digitalSignature, keyEncipherment
[alt]
{alts}
IP.1 = 127.0.0.1
""".format(alts="\n".join("DNS.{} = {}".format(i + 1, h) for i, h in enumerate(SAN_HOSTS)))


def ensure_cert(workdir=None):
    """生成一张一次性自签证书（含 github.com SAN）。需要系统里有 openssl。

    注意：Git for Windows 自带的 openssl 是旧版，不认 -addext，所以走 -config；
    万一失败再退回 -addext 写法。
    """
    workdir = workdir or tempfile.mkdtemp(prefix="gzg-cert-")
    key = os.path.join(workdir, "github-key.pem")
    crt = os.path.join(workdir, "github-cert.pem")
    if os.path.exists(crt) and os.path.exists(key):
        return crt, key
    cnf = os.path.join(workdir, "github.cnf")
    with io.open(cnf, "w", encoding="utf-8", newline="\n") as f:
        f.write(CNF)
    base = ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", key, "-out", crt, "-days", "2"]
    san = "subjectAltName=" + ",".join("DNS:" + h for h in SAN_HOSTS)
    attempts = [base + ["-config", cnf],
                base + ["-subj", "/CN=github.com", "-addext", san],
                base + ["-subj", "/CN=github.com"]]
    last = None
    for cmd in attempts:
        try:
            subprocess.run(cmd, check=True, capture_output=True)
            if os.path.exists(crt) and os.path.exists(key):
                return crt, key
        except Exception as exc:  # CalledProcessError / FileNotFoundError
            last = exc
    raise RuntimeError("openssl 生成自签证书失败：" + str(last)[:200])


class StubHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        path = self.path.split("?")[0]
        if path.endswith(".zip"):
            body = ZIP_BYTES
            ctype = "application/zip"
        else:
            body = REPO_HTML.encode("utf-8")
            ctype = "text/html; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *args):
        pass


def serve(cert, key):
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), StubHandler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=cert, keyfile=key)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


if __name__ == "__main__":
    import time

    c, k = ensure_cert()
    srv, port = serve(c, k)
    print("stub https://127.0.0.1:%d  cert=%s  zip=%dB" % (port, c, len(ZIP_BYTES)))
    print('把 github.com 指过去：--host-resolver-rules="MAP github.com 127.0.0.1:%d"' % port)
    while True:
        time.sleep(5)
