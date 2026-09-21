import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore } from '../store'

export function ThoughtTerminal() {
  const terminalOpen = useStore((s) => s.terminalOpen)
  const setTerminalOpen = useStore((s) => s.setTerminalOpen)
  const thoughtLogs = useStore((s) => s.thoughtLogs)
  const clearThoughts = useStore((s) => s.clearThoughts)
  const activeThought = useStore((s) => s.activeThought)
  const activeTask = useStore((s) => s.activeTask)
  const recentTasks = useStore((s) => s.recentTasks)

  const bodyRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  useEffect(() => {
    if (autoScroll && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [thoughtLogs, activeThought, autoScroll])

  const handleScroll = () => {
    if (!bodyRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = bodyRef.current
    const atBottom = scrollHeight - (scrollTop + clientHeight) < 40
    setAutoScroll(atBottom)
  }

  return (
    <AnimatePresence>
      {terminalOpen && (
        <motion.div
          className="thought-terminal"
          initial={{ opacity: 0, y: 16, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.98 }}
          transition={{ duration: 0.22, ease: 'easeOut' }}
        >
          <div className="terminal-header">
            <div className="terminal-title">
              <span className="terminal-glyph">◈</span>
              <span className="terminal-name">AGY CLI TELEMETRY // TASK MONITOR</span>
              {activeTask ? (
                <span className="terminal-status-badge active">
                  <span className="pulse-dot" />
                  TASK IN FLIGHT
                </span>
              ) : (
                <span className="terminal-status-badge idle">IDLE</span>
              )}
            </div>

            <div className="terminal-actions">
              <button
                type="button"
                className="terminal-btn"
                onClick={() => setAutoScroll(true)}
                title="Scroll to bottom"
              >
                {autoScroll ? 'AUTO-SCROLL ON' : 'SCROLL TO LIVE'}
              </button>
              <button
                type="button"
                className="terminal-btn"
                onClick={clearThoughts}
                title="Clear output logs"
              >
                CLEAR
              </button>
              <button
                type="button"
                className="terminal-btn close-btn"
                onClick={() => setTerminalOpen(false)}
                title="Close terminal (T)"
              >
                ✕
              </button>
            </div>
          </div>

          {/* Task status telemetry summary */}
          <div className="terminal-tasks-bar">
            <div className="task-stat-col">
              <span className="stat-label">ACTIVE TASK:</span>
              <span className="stat-val">
                {activeTask ? (
                  <>
                    <span className="highlight">"{activeTask.prompt}"</span>
                    {activeTask.tools && activeTask.tools.length > 0 && (
                      <span className="stat-tools"> [{activeTask.tools.join(', ')}]</span>
                    )}
                  </>
                ) : (
                  <span className="dim">None running</span>
                )}
              </span>
            </div>

            {recentTasks && recentTasks.length > 0 && (
              <div className="task-stat-col recent-col">
                <span className="stat-label">LAST COMPLETED:</span>
                <span className="stat-val">
                  <span className="recent-prompt">"{recentTasks[0].prompt}"</span>
                  <span className={`status-pill status-${recentTasks[0].status}`}>
                    {recentTasks[0].status.toUpperCase()}
                  </span>
                </span>
              </div>
            )}
          </div>

          {/* Terminal log output */}
          <div className="terminal-body" ref={bodyRef} onScroll={handleScroll}>
            {thoughtLogs.length === 0 ? (
              <div className="terminal-empty">
                <p>Telemetry stream ready. Output from agy CLI, thoughts, and tools will render here live.</p>
                <p className="subtext">Say a command or ask a question to observe AI reasoning in real time.</p>
              </div>
            ) : (
              thoughtLogs.map((log) => (
                <div key={log.id} className={`terminal-line line-${log.source}`}>
                  <span className="line-time">[{log.time}]</span>
                  <span className={`line-tag tag-${log.source}`}>
                    [{log.source.toUpperCase()}]
                  </span>
                  <span className="line-text">{log.text}</span>
                </div>
              ))
            )}
            {activeThought && (
              <div className="terminal-line line-active">
                <span className="line-tag tag-active">[REASONING]</span>
                <span className="line-text">{activeThought}</span>
                <span className="cursor-blink">▌</span>
              </div>
            )}
          </div>

          <div className="terminal-footer">
            <span className="terminal-hint">
              Press <kbd>T</kbd> to hide / show · auto-scrolling telemetry feed
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
