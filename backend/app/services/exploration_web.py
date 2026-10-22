"""Credential-free public HTTPS GET. DNS is validated and pinned per redirect."""
from __future__ import annotations

import http.client
from html.parser import HTMLParser
import ipaddress
import json
import socket
import ssl
import time
from urllib.parse import quote, urljoin, urlsplit

from fastapi import HTTPException


class Text(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.hidden = 0
        self.links = []

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'noscript'):
            self.hidden += 1
        if tag == 'a' and len(self.links) < 20:
            link = dict(attrs).get('href', '')
            if link and len(link) <= 1000:
                self.links.append(link)

    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'noscript'):
            self.hidden = max(0, self.hidden-1)

    def handle_data(self, data):
        if not self.hidden and data.strip():
            self.parts.append(data.strip())


def resolve_fake_ip(host):
    """A TUN Fake-IP is never an allowed destination. Resolve via fixed DoH,
    then run the same public-address checks. No local proxy or DNS is trusted
    to grant private-network access; the resolver itself has a fixed public IP.
    """
    connection = http.client.HTTPSConnection('1.1.1.1', timeout=6)
    try:
        connection.request('GET', '/dns-query?name='+quote(host, safe='')+'&type=A',
                           headers={'Accept': 'application/dns-json', 'Accept-Encoding': 'identity'})
        response = connection.getresponse()
        if response.status != 200:
            raise ValueError('DNS query failed')
        body = response.read(16385)
        if len(body) > 16384:
            raise ValueError('DNS query too large')
        data = json.loads(body)
        if data.get('Status') != 0:
            raise ValueError('DNS query failed')
        return [r['data'] for r in data.get('Answer', []) if r.get('type') == 1]
    finally:
        connection.close()


def destination(url):
    if not isinstance(url, str) or len(url) > 1500 or any(ord(x) <= 32 for x in url):
        raise HTTPException(422, '网址无效')
    try:
        parsed = urlsplit(url)
        host = parsed.hostname
        if parsed.scheme != 'https' or not host or parsed.port not in (None, 443) or parsed.username or parsed.password:
            raise ValueError()
        host = host.encode('idna').decode('ascii')
        # Reject hostname aliases for local services before resolving as well.
        if host.lower().rstrip('.') in ('localhost', 'metadata.google.internal') or host.endswith(('.local', '.localhost', '.internal')):
            raise ValueError()
        addresses = list({r[4][0] for r in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)})
        fake_pool = ipaddress.ip_network('198.18.0.0/15')
        if addresses and all(ipaddress.ip_address(address) in fake_pool for address in addresses):
            addresses = resolve_fake_ip(host)
        def public(address):
            ip = ipaddress.ip_address(address)
            if not ip.is_global or ip.is_multicast or ip.is_reserved:
                return False
            if ip.version == 6:
                return ip in ipaddress.ip_network('2000::/3') and not ip.sixtofour and not ip.teredo
            return True
        if not addresses or any(not public(address) for address in addresses):
            raise ValueError()
        return parsed, host, addresses[0]
    except (ValueError, UnicodeError, OSError, http.client.HTTPException):
        raise HTTPException(422, '仅允许公开 HTTPS 网站；本机、局域网及特殊地址禁止访问') from None


def fetch(url):
    deadline = time.monotonic()+15
    for _ in range(4):
        if time.monotonic() > deadline:
            raise HTTPException(422, '公开网页读取超时')
        parsed, host, address = destination(url)

        class PinnedHTTPS(http.client.HTTPSConnection):
            def connect(self):
                sock = socket.create_connection((address, 443), timeout=6)
                try:
                    self.sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
                except BaseException:
                    sock.close()
                    raise

        connection = PinnedHTTPS(host, timeout=6)
        try:
            path = parsed.path or '/'
            if parsed.query:
                path += '?' + parsed.query
            connection.request('GET', path, headers={'User-Agent': 'Xiaotangren-ReadOnly/1.0', 'Accept': 'text/html,text/plain', 'Accept-Encoding': 'identity'})
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader('Location')
                if not location:
                    raise HTTPException(422, '网站重定向缺少地址')
                url = urljoin(url, location)
                continue
            if response.status != 200:
                raise HTTPException(422, '公开网页暂不可读')
            mime = response.getheader('Content-Type', '').split(';')[0].strip().lower()
            if mime not in ('text/html', 'text/plain') or response.getheader('Content-Encoding', 'identity') != 'identity':
                raise HTTPException(422, '仅支持未压缩的网页文字，不下载其他文件')
            data = bytearray()
            # Fixed total byte and read count limits as well as socket timeouts.
            for _ in range(64):
                if time.monotonic() > deadline:
                    raise HTTPException(422, '公开网页读取超时')
                chunk = response.read1(8192)
                if not chunk:
                    break
                data.extend(chunk)
            text = data.decode('utf-8', errors='replace')
            parser = Text()
            parser.feed(text)
            return {'url': url, 'text': ('\n'.join(parser.parts) if mime == 'text/html' else text)[:8000],
                    'links': [urljoin(url, x) for x in parser.links if x.startswith(('https://', '/', './'))][:20],
                    'action': '读取公开网页文字；未登录、未互动'}
        except (OSError, http.client.HTTPException):
            raise HTTPException(422, '公开网页读取失败') from None
        finally:
            connection.close()
    raise HTTPException(422, '网页重定向次数过多')
