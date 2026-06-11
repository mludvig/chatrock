import { useState, useCallback } from 'react'
import { useChatStore } from '../store/chatStore'

interface Options {
  successMsg?: string
}

export function useAsyncAction<T extends unknown[]>(
  fn: (...args: T) => Promise<void>,
  opts: Options = {}
) {
  const [pending, setPending] = useState(false)
  const { pushToast } = useChatStore()

  const run = useCallback(async (...args: T) => {
    setPending(true)
    try {
      await fn(...args)
      if (opts.successMsg) pushToast({ kind: 'success', text: opts.successMsg })
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setPending(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fn, opts.successMsg, pushToast])

  return { run, pending }
}
