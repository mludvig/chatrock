#!/usr/bin/env node
// Test WebSocket connectivity against both CloudFront and direct API GW endpoints.
// Honors https_proxy / HTTPS_PROXY env vars (Node ignores them natively).
// Usage: node scripts/ws-test.mjs <access-token>

import https from 'https'
import http from 'http'
import tls from 'tls'
import crypto from 'crypto'

const token = process.argv[2]
if (!token) {
  console.error('Usage: node scripts/ws-test.mjs <access-token>')
  console.error('\nGet a fresh token from DevTools → Network → any /api/ request → Authorization header (strip "Bearer ").')
  process.exit(1)
}

const WS_ENDPOINTS = [
  { label: 'CloudFront  ', url: `wss://chatrock.ccxdemo.dev/ws?token=${token}` },
  { label: 'Direct APIGW', url: `wss://3xv0bte7j2.execute-api.ap-southeast-2.amazonaws.com/ws?token=${token}` },
]

const PROXY_URL = process.env.https_proxy || process.env.HTTPS_PROXY || ''
if (PROXY_URL) console.log(`Using proxy: ${PROXY_URL}\n`)

// WebSocket handshake over a given socket (used for both direct and proxy paths)
function wsHandshake(socket, label, url, key, resolve) {
  const req = https.request({
    createConnection: () => socket,
    hostname: url.hostname,
    port: 443,
    path: url.pathname + url.search,
    method: 'GET',
    headers: {
      'Host': url.hostname,
      'Upgrade': 'websocket',
      'Connection': 'Upgrade',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
      'Origin': 'https://chatrock.ccxdemo.dev',
    },
  }, res => {
    let body = ''
    res.on('data', d => body += d)
    res.on('end', () => {
      console.log(`❌  ${label}  HTTP ${res.statusCode} — FAILED`)
      if (body) console.log(`    Body: ${body.slice(0, 200)}`)
      for (const h of ['x-amzn-errortype', 'x-amz-apigw-id', 'x-cache', 'server']) {
        if (res.headers[h]) console.log(`    ${h}: ${res.headers[h]}`)
      }
      resolve({ label, status: res.statusCode })
    })
  })
  req.on('upgrade', (_, sock) => {
    console.log(`✅  ${label}  HTTP 101 Switching Protocols — WS upgrade OK`)
    sock.destroy()
    resolve({ label, status: 101 })
  })
  req.on('error', err => {
    console.log(`❌  ${label}  Error: ${err.message}`)
    resolve({ label, status: 0 })
  })
  req.setTimeout(10000, () => {
    console.log(`❌  ${label}  Timeout`)
    req.destroy()
    resolve({ label, status: 0 })
  })
  req.end()
}

function testWS(label, wsUrl) {
  return new Promise(resolve => {
    const url = new URL(wsUrl)
    const key = crypto.randomBytes(16).toString('base64')

    if (PROXY_URL) {
      const proxy = new URL(PROXY_URL)
      const tunnel = http.request({
        hostname: proxy.hostname,
        port: Number(proxy.port) || 8080,
        method: 'CONNECT',
        path: `${url.hostname}:443`,
        headers: { Host: `${url.hostname}:443` },
      })
      tunnel.on('connect', (_res, socket) => {
        const tlsSocket = tls.connect({ socket, servername: url.hostname }, () => {
          wsHandshake(tlsSocket, label, url, key, resolve)
        })
        tlsSocket.on('error', err => {
          console.log(`❌  ${label}  TLS error: ${err.message}`)
          resolve({ label, status: 0 })
        })
      })
      tunnel.on('error', err => {
        console.log(`❌  ${label}  Proxy error: ${err.message}`)
        resolve({ label, status: 0 })
      })
      tunnel.end()
      return
    }

    // Direct (no proxy) — use a plain TLS socket
    const socket = tls.connect({ host: url.hostname, port: 443, servername: url.hostname }, () => {
      wsHandshake(socket, label, url, key, resolve)
    })
    socket.on('error', err => {
      console.log(`❌  ${label}  Error: ${err.message}`)
      resolve({ label, status: 0 })
    })
  })
}

console.log('Testing WebSocket connectivity...\n')
for (const ep of WS_ENDPOINTS) {
  await testWS(ep.label, ep.url)
}
console.log('\nDone.')
