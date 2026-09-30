// 浏览器语音识别（ASR）占位实现。
// 用 Web Speech API（Chrome/Edge 内置，即时可用、零后端），后续按《项目要求》§6
// 替换为 sherpa-onnx / Whisper 本地引擎时，只需换掉这里的实现，调用方（ChatView）不变。
import { useCallback, useEffect, useRef, useState } from 'react'

function SR(): any {
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
}

export function speechAvailable(): boolean {
  return Boolean(SR())
}

export function useSpeechToText() {
  const [listening, setListening] = useState(false)
  const recRef = useRef<any>(null)

  const stop = useCallback(() => {
    try {
      recRef.current?.stop()
    } catch {
      /* ignore */
    }
    setListening(false)
  }, [])

  useEffect(
    () => () => {
      try {
        recRef.current?.abort()
      } catch {
        /* ignore */
      }
    },
    [],
  )

  // onInterim：实时可识别到的候选文本（非最终）；onFinal：一句说完了的确定文本。
  const start = useCallback(
    (onInterim: (t: string) => void, onFinal: (t: string) => void, onError: (m: string) => void) => {
      const SRImpl = SR()
      if (!SRImpl) {
        onError('当前浏览器不支持语音识别（请用 Chrome / Edge）')
        return
      }
      const rec = new SRImpl()
      rec.lang = 'zh-CN'
      rec.continuous = false
      rec.interimResults = true
      rec.onresult = (e: any) => {
        let interim = ''
        let final = ''
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript
          if (e.results[i].isFinal) final += t
          else interim += t
        }
        if (final) onFinal(final)
        if (interim) onInterim(interim)
      }
      rec.onerror = (e: any) => {
        if (e.error && e.error !== 'no-speech') onError(`语音识别错误：${e.error}`)
        setListening(false)
      }
      rec.onend = () => setListening(false)
      recRef.current = rec
      rec.start()
      setListening(true)
    },
    [],
  )

  return { listening, start, stop, available: speechAvailable() }
}