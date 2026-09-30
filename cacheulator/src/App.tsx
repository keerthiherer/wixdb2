import { useState } from 'react'
import { CodeEditor } from './components/CodeEditor'
import { LeftPanel } from './components/LeftPanel'
import { DevicesTable, MetricsPanel, TerminalView } from './components/RightPanel'
import { StatusBar } from './components/StatusBar'
import { Toolbar } from './components/Toolbar'
import { useSimulator } from './hooks/useSimulator'
import { cx } from './lib/format'

type RightTab = 'terminal' | 'devices' | 'metrics'

export default function App() {
  const sim = useSimulator()
  const [rightTab, setRightTab] = useState<RightTab>('terminal')
  const [selected, setSelected] = useState<string | null>(null)
  const [statusCollapsed, setStatusCollapsed] = useState(false)
  const m = sim.machine

  const stats = m.stats()
  const dirty = sim.draft !== m.program.source

  return (
    <div className="app">
      <Toolbar
        finished={m.finished}
        running={sim.running}
        lookups={stats.totalRequests}
        sampleGroups={sim.grouped}
        sampleId={sim.sampleId}
        onLoadSample={sim.loadSample}
        onStepInto={sim.stepOnce}
        onStepOver={sim.stepOver}
        onStepOut={sim.stepOut}
        onContinue={sim.continueRun}
        onStop={sim.stop}
        onRestart={sim.restart}
        onReload={sim.reload}
        speed={sim.speed}
        setSpeed={sim.setSpeed}
        dirty={dirty}
      />

      <div className="workspace">
        <LeftPanel
          machine={m}
          displayFormat={sim.displayFormat}
          setDisplayFormat={sim.setDisplayFormat}
          wordSize={sim.wordSize}
          setWordSize={sim.setWordSize}
          showLines={sim.showLines}
          setShowLines={sim.setShowLines}
          selected={selected}
          setSelected={setSelected}
          addWatch={sim.addWatch}
          tick={sim.tick}
        />

        <main className="center">
          {dirty && (
            <div className="dirty-banner">
              editor has uncompiled changes — press <b>Reload</b> to assemble and re-run from pc 0
            </div>
          )}
          {m.program.errors.length > 0 && (
            <div className="error-banner">
              {m.program.errors.map((e) => (
                <div key={e.line}>
                  line {e.line}: {e.message}
                </div>
              ))}
            </div>
          )}
          <CodeEditor
            source={sim.draft}
            program={m.program}
            currentLine={m.currentLine}
            breakpoints={m.breakpoints}
            showLines={sim.showLines}
            finished={m.finished}
            onChange={sim.setDraft}
            onToggleBreakpoint={(line) => {
              m.toggleBreakpoint(line)
              sim.tick()
            }}
          />
        </main>

        <aside className="panel right">
          <div className="tabs">
            <button className={cx('tab', rightTab === 'terminal' && 'active')} onClick={() => setRightTab('terminal')}>
              Terminal
            </button>
            <button className={cx('tab', rightTab === 'devices' && 'active')} onClick={() => setRightTab('devices')}>
              Devices
            </button>
            <button className={cx('tab', rightTab === 'metrics' && 'active')} onClick={() => setRightTab('metrics')}>
              Metrics
              <i className="badge live">{(stats.hitRate * 100).toFixed(0)}%</i>
            </button>
          </div>
          <div className="tab-body right-body">
            {rightTab === 'terminal' && <TerminalView lines={m.terminal} />}
            {rightTab === 'devices' && <DevicesTable machine={m} />}
            {rightTab === 'metrics' && <MetricsPanel machine={m} comparison={sim.comparison} onRunComparison={sim.runComparison} />}
          </div>
        </aside>
      </div>

      <StatusBar
        lines={m.status}
        running={sim.running}
        finished={m.finished}
        pc={m.currentLine}
        clock={m.clock.t}
        policy={m.config.policy}
        capacity={m.config.capacity}
        collapsed={statusCollapsed}
        onToggle={() => setStatusCollapsed((v) => !v)}
      />
    </div>
  )
}
