export type VoiceSetup = {
  character_id: string; persona_id: string; session_id: string
  base_url: string; api_key: string; model: string; max_tokens: number | null
  uncensored: boolean; auto_memory: boolean
  asr_provider: string; asr_key: string; asr_model: string; asr_region: string
  fish_key: string; fish_model: string; voice_id: string
  tts_provider: string
  cosyvoice_playback?: 'smooth' | 'stream'
  input_only?: boolean
  mode?: 'single' | 'group'
  feature_id?: 'core' | 'desktop_pet'
}
export type VoiceEvent = { type: string; generation?: number; segment?: number; sample_rate?: number; text?: string; final?: boolean; message?: string }

/** One owned call, including every media resource; safe to close while connecting. */
export class VoiceCall {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private socket: WebSocket | null = null
  private input: MediaStreamAudioSourceNode | null = null
  private capture: AudioWorkletNode | null = null
  private sources = new Set<AudioBufferSourceNode>()
  private sampleRates = new Map<number, number>()
  private segments = new Map<number, { pending: number; ended: boolean; acked: boolean }>()
  private nextTime = 0
  private generation = 0
  private blocked = new Set<number>()
  private closed = false
  private ready = false
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private onEvent: (event: VoiceEvent) => void,
              private transport?: { socket: () => WebSocket; worklet: string }) {}

  async start(setup: VoiceSetup) {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('麦克风需要 HTTPS 或 localhost 地址')
    try {
      // Created from the Connect click; resume before awaiting microphone permissions.
      const context = new AudioContext({ latencyHint: 'interactive' })
      this.context = context
      await context.resume()
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1,
      } })
      if (this.closed) { this.stream.getTracks().forEach(t => t.stop()); return }
      await context.audioWorklet.addModule(this.transport?.worklet || '/voice-capture.js')
      if (this.closed) return
      this.input = context.createMediaStreamSource(this.stream)
      this.capture = new AudioWorkletNode(context, 'voice-capture')
      this.input.connect(this.capture)
      this.capture.connect(context.destination)
      const socket = this.transport?.socket() || new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/voice/call/ws`)
      this.socket = socket
      socket.binaryType = 'arraybuffer'
      this.timer = setTimeout(() => this.fail('连接语音服务超时，请检查服务配置和网络'), 40000)
      socket.onopen = () => { if (!this.closed) socket.send(JSON.stringify(setup)) }
      socket.onmessage = event => {
        if (this.closed) return
        try {
          if (typeof event.data !== 'string') { this.audio(event.data as ArrayBuffer); return }
          const message = JSON.parse(event.data) as VoiceEvent
          if (message.type === 'ready') { this.ready = true; clearTimeout(this.timer) }
          if (message.type === 'reply-start') {
            this.stopAudio()
            this.generation = message.generation!
          }
          if (message.type === 'interrupted') {
            this.blocked.add(message.generation!)
            if (message.generation === this.generation) this.stopAudio()
          }
          if ((message.type === 'delta' || message.type === 'done') &&
            (message.generation !== this.generation || this.blocked.has(message.generation!))) return
          if (message.type === 'audio-start' && !this.blocked.has(message.generation!) && message.generation === this.generation) {
            this.segments.set(message.segment!, { pending: 0, ended: false, acked: false })
            if (!Number.isInteger(message.sample_rate) || message.sample_rate! < 8000 || message.sample_rate! > 48000) throw new Error('Invalid sample rate')
            this.sampleRates.set(message.segment!, message.sample_rate!)
          }
          if (message.type === 'audio-end' && message.generation === this.generation && !this.blocked.has(message.generation!)) {
            const segment = this.segments.get(message.segment!)
            if (segment) { segment.ended = true; this.acknowledge(message.segment!) }
          }
          this.onEvent(message)
          if (message.type === 'fatal') this.close()
        } catch { this.fail('语音数据未能完整播放，请重新拨打') }
      }
      socket.onclose = () => { if (!this.closed) this.fail('通话已断开，请重新拨打') }
      socket.onerror = () => this.fail('无法连接语音服务，请检查网络或重启后端')
      this.capture.port.onmessage = event => {
        if (!this.ready || this.closed || socket.readyState !== WebSocket.OPEN) return
        // Fail explicitly instead of accumulating stale microphone audio on a weak link.
        if (socket.bufferedAmount > 64000) { this.fail('网络上传跟不上收音，请改善网络后重新拨打'); return }
        socket.send(event.data)
      }
      this.stream.getAudioTracks()[0].onended = () => this.fail('麦克风已断开，请重新拨打')
      context.onstatechange = () => {
        if (!this.closed && this.ready && context.state === 'suspended') this.onEvent({ type: 'suspended', message: '音频暂停，请点“恢复声音”' })
      }
    } catch (error) {
      this.close()
      throw error
    }
  }

  private audio(packet: ArrayBuffer) {
    if (packet.byteLength < 10 || packet.byteLength % 2) throw new Error('Invalid PCM')
    const view = new DataView(packet)
    const generation = view.getUint32(0, true), number = view.getUint32(4, true)
    if (this.blocked.has(generation) || generation !== this.generation || this.closed) return
    const segment = this.segments.get(number), context = this.context
    if (!segment || !context) throw new Error('Unknown audio segment')
    const buffer = context.createBuffer(1, (packet.byteLength - 8) / 2, this.sampleRates.get(number) || 24000)
    const samples = buffer.getChannelData(0)
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(8 + i * 2, true) / 32768
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    segment.pending++
    this.sources.add(source)
    source.onended = () => {
      this.sources.delete(source)
      source.disconnect()
      segment.pending--
      if (!this.closed && generation === this.generation && !this.blocked.has(generation)) this.acknowledge(number)
    }
    this.nextTime = Math.max(this.nextTime, context.currentTime + 0.06)
    source.start(this.nextTime)
    this.nextTime += buffer.duration
  }

  private acknowledge(number: number) {
    const segment = this.segments.get(number)
    if (segment && segment.ended && segment.pending === 0 && !segment.acked) {
      segment.acked = true
      this.send({ type: 'played', generation: this.generation, segment: number })
    }
  }

  private send(value: object) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(value)) }
  setMuted(muted: boolean) { this.stream?.getAudioTracks().forEach(track => { track.enabled = !muted }) }
  sendText(text: string) { if (this.ready && text.trim()) { this.interrupt(); this.send({ type: 'text', text: text.trim() }) } }
  interrupt() {
    this.blocked.add(this.generation)
    this.stopAudio()
    this.send({ type: 'interrupt' })
  }
  async resume() { await this.context?.resume() }
  private stopAudio() {
    for (const source of this.sources) { source.onended = null; try { source.stop(); source.disconnect() } catch { /* already stopped */ } }
    this.sources.clear()
    this.segments.clear()
    this.sampleRates.clear()
    this.nextTime = 0
  }
  private fail(message: string) { if (!this.closed) { this.onEvent({ type: 'fatal', message }); this.close() } }
  close() {
    if (this.closed) return
    this.closed = true
    this.ready = false
    clearTimeout(this.timer)
    this.send({ type: 'hangup' })
    this.stopAudio()
    if (this.socket) { this.socket.onclose = null; this.socket.onerror = null; this.socket.onmessage = null; this.socket.close() }
    if (this.capture) { this.capture.port.onmessage = null; this.capture.disconnect() }
    this.input?.disconnect()
    this.stream?.getTracks().forEach(track => track.stop())
    void this.context?.close().catch(() => {})
  }
}
