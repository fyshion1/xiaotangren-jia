// Browser microphone -> 16 kHz PCM16, 100 ms packets. Runs off the UI thread.
class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.phase = 0
    this.sum = 0
    this.count = 0
    this.packet = new Int16Array(1600)
    this.used = 0
  }
  process(inputs, outputs) {
    // Keep this node alive without feeding microphone audio to the speakers.
    for (const channel of outputs[0] || []) channel.fill(0)
    const channels = inputs[0]
    if (!channels?.length) return true
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0
      for (const channel of channels) sample += channel[i] / channels.length
      this.sum += sample
      this.count++
      this.phase += 16000
      if (this.phase >= sampleRate) {
        this.phase -= sampleRate
        const value = Math.max(-1, Math.min(1, this.sum / this.count))
        this.packet[this.used++] = Math.round(value * (value < 0 ? 32768 : 32767))
        this.sum = this.count = 0
        if (this.used === this.packet.length) {
          this.port.postMessage(this.packet.buffer, [this.packet.buffer])
          this.packet = new Int16Array(1600)
          this.used = 0
        }
      }
    }
    return true
  }
}
registerProcessor('voice-capture', VoiceCapture)
