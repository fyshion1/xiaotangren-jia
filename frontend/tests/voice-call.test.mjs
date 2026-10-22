import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../src/lib/voiceCall.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText
const { VoiceCall } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

test('playback acknowledgements wait for the final sample; interrupted packets never play', async () => {
  const sources = [], events = []
  let stopped = 0, socket, context
  class FakeContext {
    currentTime = 0
    state = 'running'
    destination = {}
    audioWorklet = { addModule: async () => {} }
    constructor() { context = this }
    async resume() {}
    async close() { this.state = 'closed' }
    createMediaStreamSource() { return { connect() {}, disconnect() {} } }
    createBuffer(_channels, length, rate) { const data = new Float32Array(length); this.lastRate = rate; return { getChannelData: () => data, duration: length / rate } }
    createBufferSource() {
      const node = { connect() {}, disconnect() {}, start(at) { this.at = at }, stop() { this.stopped = true }, onended: null }
      sources.push(node)
      return node
    }
  }
  class FakeSocket {
    static OPEN = 1
    readyState = 1
    bufferedAmount = 0
    sent = []
    constructor() { socket = this }
    send(value) { this.sent.push(value) }
    close() { this.readyState = 3 }
    message(value) { this.onmessage?.({ data: typeof value === 'object' && !(value instanceof ArrayBuffer) ? JSON.stringify(value) : value }) }
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => {
    const track = { stop() { stopped++ }, enabled: true }
    return { getTracks: () => [track], getAudioTracks: () => [track] }
  } } } })
  globalThis.window = { isSecureContext: true }
  globalThis.location = { protocol: 'http:', host: 'localhost:5173' }
  globalThis.AudioContext = FakeContext
  globalThis.AudioWorkletNode = class { port = {}; connect() {} disconnect() {} }
  globalThis.WebSocket = FakeSocket
  const call = new VoiceCall(event => events.push(event))
  await call.start({ api_key: 'never-in-url' })
  socket.onopen()
  socket.message({ type: 'ready' })
  socket.message({ type: 'reply-start', generation: 1 })
  socket.message({ type: 'audio-start', generation: 1, segment: 1, sample_rate: 22050 })
  function pcm(generation, segment, samples) {
    const buffer = new ArrayBuffer(8 + samples.length * 2), view = new DataView(buffer)
    view.setUint32(0, generation, true); view.setUint32(4, segment, true)
    samples.forEach((sample, index) => view.setInt16(8 + 2 * index, sample, true))
    return buffer
  }
  socket.message(pcm(1, 1, [32000, -32000]))
  assert.equal(context.lastRate, 22050)
  socket.message(pcm(1, 1, [1])) // tiny final packet
  socket.message({ type: 'audio-end', generation: 1, segment: 1 })
  const played = () => socket.sent.filter(value => typeof value === 'string' && JSON.parse(value).type === 'played')
  assert.equal(played().length, 0)
  sources[0].onended()
  assert.equal(played().length, 0)
  sources[1].onended()
  assert.equal(played().length, 1)
  assert.deepEqual(JSON.parse(played()[0]), { type: 'played', generation: 1, segment: 1 })
  socket.message({ type: 'audio-start', generation: 1, segment: 2, sample_rate: 24000 })
  socket.message(pcm(1, 2, [123]))
  socket.message({ type: 'interrupted', generation: 1 })
  assert.equal(sources[2].stopped, true)
  socket.message(pcm(1, 2, [123]))
  assert.equal(sources.length, 3)
  socket.message({ type: 'reply-start', generation: 2 })
  socket.message({ type: 'audio-start', generation: 2, segment: 1, sample_rate: 24000 })
  socket.message(pcm(1, 2, [123]))
  assert.equal(sources.length, 3)
  socket.message(pcm(2, 1, [456]))
  assert.equal(sources.length, 4)
  call.close()
  call.close()
  assert.equal(stopped, 1)
  assert.equal(context.state, 'closed')
  assert.equal(socket.readyState, 3)
  assert.equal(events.some(e => e.type === 'fatal'), false)
})

test('AudioWorklet captures one second as exactly ten PCM packets and never feeds back the microphone', async () => {
  const workletSource = await readFile(new URL('../public/voice-capture.js', import.meta.url), 'utf8')
  for (const rate of [48000, 44100, 16000]) {
    let Processor
    const packets = []
    vm.runInNewContext(workletSource, {
      AudioWorkletProcessor: class { port = { postMessage: buffer => packets.push(new Int16Array(buffer)) } },
      registerProcessor: (_name, processor) => { Processor = processor }, sampleRate: rate,
    })
    const capture = new Processor()
    for (let offset = 0; offset < rate; offset += 128) {
      const input = new Float32Array(Math.min(128, rate - offset))
      input.fill(0.25)
      const output = new Float32Array(input.length).fill(1)
      capture.process([[input]], [[output]])
      assert.ok(output.every(value => value === 0))
    }
    assert.equal(packets.length, 10, `sample rate ${rate}`)
    assert.equal(packets.reduce((sum, packet) => sum + packet.length, 0), 16000)
    assert.ok(packets.every(packet => packet.every(sample => Math.abs(sample - 8192) <= 1)))
  }
})
