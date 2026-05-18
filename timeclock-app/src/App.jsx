import { useState, useEffect, useCallback } from 'react'
import jsPDF from 'jspdf'

/* ─── Constants ─── */
const COLORS = ['#C0392B','#2980B9','#27AE60','#D4850A','#7D3C98','#148F77','#BA4A00','#1A5276']

const STATUS_CONFIG = {
  out:   { label: 'Not started', bg: '#F5F5F5',               color: '#666' },
  in:    { label: 'Clocked in',  bg: '#E8F5E9',               color: '#1B5E20' },
  lunch: { label: 'On lunch',    bg: '#FFF3E0',               color: '#E65100' },
  done:  { label: 'Clocked out', bg: '#F5F5F5',               color: '#666' },
}

/* ─── Helpers ─── */
const fmt    = ts => ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--'
const fmtDate = d => new Date(d + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
const msToHM  = ms => {
  if (!ms || ms <= 0) return '0h 00m'
  return `${Math.floor(ms / 3600000)}h ${String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0')}m`
}
const initials = n => n.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
const getToday = () => new Date().toISOString().split('T')[0]

const getWeekDates = () => {
  const now = new Date(), day = now.getDay(), diff = day === 0 ? -6 : 1 - day
  const mon = new Date(now)
  mon.setDate(now.getDate() + diff)
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(mon)
    d.setDate(mon.getDate() + i)
    return d.toISOString().split('T')[0]
  })
}

const calcWorked = r => {
  if (!r?.clockIn) return 0
  const end = r.clockOut ?? Date.now()
  let ms = end - r.clockIn
  if (r.lunchStart) ms -= ((r.lunchEnd ?? (r.clockOut ?? Date.now())) - r.lunchStart)
  return Math.max(0, ms)
}

const calcLunch = r => {
  if (!r?.lunchStart) return 0
  return Math.max(0, (r.lunchEnd ?? Date.now()) - r.lunchStart)
}

/* ─── Storage hook ─── */
function useLS(key, initial) {
  const [val, setVal] = useState(() => {
    try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : initial }
    catch { return initial }
  })
  const set = useCallback(v => {
    setVal(v)
    try { localStorage.setItem(key, JSON.stringify(v)) } catch {}
  }, [key])
  return [val, set]
}

/* ─── Main App ─── */
export default function App() {
  const [employees, setEmployees] = useLS('tc_emp', [])
  const [records,   setRecords]   = useLS('tc_recs', [])
  const [settings,  setSettings]  = useLS('tc_sett', { email: '' })
  const [view,    setView]    = useState('home')
  const [selEmp,  setSelEmp]  = useState(null)
  const [newName, setNewName] = useState('')
  const [settEmail, setSettEmail] = useState('')
  const [toast, setToast] = useState('')
  const [, setTick] = useState(0)

  useEffect(() => {
    setSettEmail(settings.email || '')
    const t = setInterval(() => setTick(x => x + 1), 30000)
    return () => clearInterval(t)
  }, [])

  const showToast = msg => {
    setToast(msg)
    setTimeout(() => setToast(''), 3000)
  }

  /* ─── Record helpers ─── */
  const getTodayRec = empId => records.find(r => r.empId === empId && r.date === getToday())
  const getStatus = empId => {
    const r = getTodayRec(empId)
    if (!r?.clockIn) return 'out'
    if (r.clockOut) return 'done'
    if (r.lunchStart && !r.lunchEnd) return 'lunch'
    return 'in'
  }

  /* ─── Actions ─── */
  const doClockIn = empId => {
    if (getTodayRec(empId)) return
    setRecords([...records, {
      id: `${empId}-${Date.now()}`, empId, date: getToday(),
      clockIn: Date.now(), clockOut: null, lunchStart: null, lunchEnd: null,
    }])
  }

  const doClockOut = empId => {
    setRecords(records.map(r =>
      r.empId === empId && r.date === getToday()
        ? { ...r, clockOut: Date.now(), lunchEnd: r.lunchStart && !r.lunchEnd ? Date.now() : r.lunchEnd }
        : r
    ))
  }

  const doLunchStart = empId => {
    setRecords(records.map(r =>
      r.empId === empId && r.date === getToday() ? { ...r, lunchStart: Date.now() } : r
    ))
  }

  const doLunchEnd = empId => {
    setRecords(records.map(r =>
      r.empId === empId && r.date === getToday() ? { ...r, lunchEnd: Date.now() } : r
    ))
  }

  const addEmployee = () => {
    const name = newName.trim()
    if (!name) return
    const emp = { id: Date.now(), name, color: COLORS[employees.length % COLORS.length] }
    setEmployees([...employees, emp])
    setNewName('')
    showToast(`${name} added!`)
  }

  const removeEmployee = id => {
    if (!confirm('Remove this employee? Their time records will remain.')) return
    setEmployees(employees.filter(e => e.id !== id))
  }

  /* ─── PDF generation ─── */
  const generatePDF = emp => {
    const wd = getWeekDates()
    const recs = records.filter(r => r.empId === emp.id && wd.includes(r.date))
    const doc = new jsPDF()

    // Header
    doc.setFillColor(17, 17, 17)
    doc.rect(0, 0, 210, 36, 'F')
    doc.setTextColor(255, 255, 255)
    doc.setFontSize(20)
    doc.setFont(undefined, 'bold')
    doc.text('TimeTrack', 15, 15)
    doc.setFontSize(11)
    doc.setFont(undefined, 'normal')
    doc.text('Weekly Time Report', 15, 24)
    doc.text(`Week of ${fmtDate(wd[0])} – ${fmtDate(wd[4])}`, 15, 31)

    // Employee name
    doc.setTextColor(17, 17, 17)
    doc.setFontSize(18)
    doc.setFont(undefined, 'bold')
    doc.text(emp.name, 15, 52)
    doc.setFontSize(10)
    doc.setFont(undefined, 'normal')
    doc.setTextColor(100, 100, 100)
    doc.text(`Generated ${new Date().toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`, 15, 59)

    // Table header
    doc.setFillColor(245, 245, 245)
    doc.rect(15, 66, 180, 9, 'F')
    doc.setTextColor(80, 80, 80)
    doc.setFontSize(9)
    doc.setFont(undefined, 'bold')
    const cols = [15, 55, 90, 128, 158, 178]
    const headers = ['Date', 'Clock In', 'Lunch', 'Clock Out', 'Lunch Dur.', 'Worked']
    headers.forEach((h, i) => doc.text(h, cols[i], 72))

    // Rows
    doc.setFont(undefined, 'normal')
    let y = 86
    let totalMs = 0

    wd.slice(0, 5).forEach((date, idx) => {
      const r = recs.find(x => x.date === date)
      const worked = calcWorked(r)
      const lunch  = calcLunch(r)
      totalMs += worked

      if (idx % 2 === 0) {
        doc.setFillColor(251, 251, 250)
        doc.rect(15, y - 6, 180, 10, 'F')
      }

      doc.setTextColor(17, 17, 17)
      doc.setFontSize(9)
      doc.text(fmtDate(date),                cols[0], y)
      doc.text(r?.clockIn  ? fmt(r.clockIn)  : '—',   cols[1], y)

      const lunchStr = r?.lunchStart
        ? `${fmt(r.lunchStart)} – ${r.lunchEnd ? fmt(r.lunchEnd) : 'open'}`
        : '—'
      doc.text(lunchStr,                               cols[2], y)
      doc.text(r?.clockOut ? fmt(r.clockOut) : '—',   cols[3], y)
      doc.text(lunch  > 0  ? msToHM(lunch)   : '—',   cols[4], y)
      doc.text(worked > 0  ? msToHM(worked)  : '—',   cols[5], y)
      y += 12
    })

    // Total
    doc.setDrawColor(200, 200, 200)
    doc.line(15, y - 4, 195, y - 4)
    doc.setFont(undefined, 'bold')
    doc.setFontSize(11)
    doc.setTextColor(17, 17, 17)
    doc.text('Total Hours:', cols[4] - 10, y + 4)
    doc.setFontSize(13)
    doc.text(msToHM(totalMs), cols[5], y + 4)

    // Footer
    doc.setFont(undefined, 'normal')
    doc.setFontSize(8)
    doc.setTextColor(150, 150, 150)
    doc.text('Generated by TimeTrack', 105, 285, { align: 'center' })

    return doc
  }

  const downloadAllPDFs = () => {
    employees.forEach(emp => {
      const doc = generatePDF(emp)
      doc.save(`${emp.name.replace(/\s+/g, '-')}-week-${getToday()}.pdf`)
    })
    showToast(`Downloaded ${employees.length} PDF${employees.length !== 1 ? 's' : ''}`)
  }

  const sendEmailReport = () => {
    if (!settings.email) { showToast('Set a report email in Settings first'); return }
    const wd = getWeekDates()
    let body = `Weekly Time Reports\nWeek of ${fmtDate(wd[0])} to ${fmtDate(wd[4])}\n${'═'.repeat(50)}\n\n`

    employees.forEach(emp => {
      const recs = records.filter(r => r.empId === emp.id && wd.includes(r.date))
      let total = 0
      body += `${emp.name}\n${'─'.repeat(30)}\n`
      wd.slice(0, 5).forEach(date => {
        const r = recs.find(x => x.date === date)
        const w = calcWorked(r)
        total += w
        body += `${fmtDate(date)}: `
        body += `In ${r?.clockIn ? fmt(r.clockIn) : '--'} `
        body += `| Lunch ${r?.lunchStart ? msToHM(calcLunch(r)) : '--'} `
        body += `| Out ${r?.clockOut ? fmt(r.clockOut) : '--'} `
        body += `| ${w > 0 ? msToHM(w) : 'No hours'}\n`
      })
      body += `TOTAL: ${msToHM(total)}\n\n`
    })

    const subject = `Weekly Time Reports – ${fmtDate(wd[0])} to ${fmtDate(wd[4])}`
    window.open(`mailto:${settings.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`)
    showToast('Opening email…')
  }

  /* ─── Views ─── */
  const HomeView = () => {
    const today = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
    const time  = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

    return (
      <>
        <div className="page-header">
          <div>
            <div className="app-title">TimeTrack</div>
            <div className="page-heading">{today}</div>
          </div>
          <div className="clock-time">{time}</div>
        </div>

        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {employees.length === 0 ? (
            <div className="empty">
              <i className="ti ti-users" aria-hidden="true" />
              No employees yet.<br />Add them in the Employees tab.
            </div>
          ) : employees.map(emp => {
            const st  = getStatus(emp.id)
            const rec = getTodayRec(emp.id)
            const w   = calcWorked(rec)
            const sc  = STATUS_CONFIG[st]
            return (
              <div
                key={emp.id}
                className="card emp-row"
                onClick={() => { setSelEmp(emp); setView('employee') }}
              >
                <div className="avatar" style={{ background: emp.color }}>{initials(emp.name)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 3 }}>{emp.name}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className="pill" style={{ background: sc.bg, color: sc.color }}>{sc.label}</span>
                    {w > 0 && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{msToHM(w)}</span>}
                  </div>
                </div>
                <div style={{ textAlign: 'right', fontSize: 11, color: 'var(--muted)', lineHeight: 1.7 }}>
                  {rec?.clockIn  && <div>In: {fmt(rec.clockIn)}</div>}
                  {rec?.clockOut && <div>Out: {fmt(rec.clockOut)}</div>}
                </div>
                <i className="ti ti-chevron-right" style={{ color: 'var(--muted)', fontSize: 16 }} aria-hidden="true" />
              </div>
            )
          })}
        </div>
      </>
    )
  }

  const EmployeeView = () => {
    const emp = selEmp
    if (!emp) return null
    const st   = getStatus(emp.id)
    const rec  = getTodayRec(emp.id)
    const w    = calcWorked(rec)
    const ln   = calcLunch(rec)
    const sc   = STATUS_CONFIG[st]
    const wd   = getWeekDates()
    const wRecs = records.filter(r => r.empId === emp.id && wd.includes(r.date))
    const wTotal = wRecs.reduce((s, r) => s + calcWorked(r), 0)

    return (
      <>
        <div className="page-header">
          <div>
            <button className="back-btn" onClick={() => setView('home')}>
              <i className="ti ti-arrow-left" aria-hidden="true" /> Back
            </button>
            <div className="page-heading">{emp.name}</div>
          </div>
          <span className="pill" style={{ background: sc.bg, color: sc.color }}>{sc.label}</span>
        </div>

        <div style={{ padding: 16 }}>
          {/* Metrics */}
          <div className="metrics">
            <div className="metric">
              <div className="metric-label">Today</div>
              <div className="metric-value">{msToHM(w)}</div>
            </div>
            <div className="metric">
              <div className="metric-label">This week</div>
              <div className="metric-value">{msToHM(wTotal)}</div>
            </div>
          </div>

          {/* Today detail */}
          {rec && (
            <div className="card" style={{ marginBottom: 18 }}>
              <div className="label">Today's record</div>
              {[
                ["Clock in",    fmt(rec.clockIn)],
                ["Lunch start", fmt(rec.lunchStart)],
                ["Lunch end",   fmt(rec.lunchEnd)],
                ["Clock out",   fmt(rec.clockOut)],
              ].map(([l, v]) => (
                <div className="time-row" key={l}>
                  <span className="t-label">{l}</span>
                  <span className="t-val">{v}</span>
                </div>
              ))}
              {ln > 0 && (
                <div className="time-row">
                  <span className="t-label">Lunch duration</span>
                  <span className="t-val">{msToHM(ln)}</span>
                </div>
              )}
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
            {st === 'out' && (
              <button className="btn btn-green" onClick={() => { doClockIn(emp.id) }}>
                <i className="ti ti-clock" aria-hidden="true" /> Clock In
              </button>
            )}
            {st === 'in' && (
              <>
                <button className="btn btn-amber" onClick={() => doLunchStart(emp.id)}>
                  <i className="ti ti-soup" aria-hidden="true" /> Start Lunch Break
                </button>
                <button className="btn" onClick={() => doClockOut(emp.id)}>
                  <i className="ti ti-clock-off" aria-hidden="true" /> Clock Out
                </button>
              </>
            )}
            {st === 'lunch' && (
              <>
                <button className="btn btn-amber" onClick={() => doLunchEnd(emp.id)}>
                  <i className="ti ti-soup" aria-hidden="true" /> End Lunch Break
                </button>
                <button className="btn" onClick={() => doClockOut(emp.id)}>
                  <i className="ti ti-clock-off" aria-hidden="true" /> Clock Out
                </button>
              </>
            )}
            {st === 'done' && (
              <div style={{ textAlign: 'center', padding: '16px 0', color: 'var(--muted)', fontSize: 13 }}>
                <i className="ti ti-circle-check" style={{ color: '#27AE60', fontSize: 22, display: 'block', marginBottom: 6 }} aria-hidden="true" />
                Done for today — clocked out at {fmt(rec?.clockOut)}
              </div>
            )}
          </div>

          {/* Week summary */}
          <div className="label">This week</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {wd.slice(0, 5).map(date => {
              const r  = wRecs.find(x => x.date === date)
              const dw = calcWorked(r)
              const isToday = date === getToday()
              return (
                <div key={date} className={`week-row ${isToday ? 'today' : dw > 0 ? 'worked' : ''}`}>
                  <span className="wday">{fmtDate(date)}</span>
                  <span className="whrs">{dw > 0 ? msToHM(dw) : '—'}</span>
                </div>
              )
            })}
          </div>
        </div>
      </>
    )
  }

  const EmployeesView = () => (
    <>
      <div className="page-header">
        <div><div className="app-title">TimeTrack</div><div className="page-heading">Employees</div></div>
      </div>
      <div style={{ padding: 16 }}>
        <div className="label">Add employee</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
          <input
            className="text-input"
            style={{ flex: 1 }}
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addEmployee()}
            placeholder="Full name"
          />
          <button
            onClick={addEmployee}
            style={{ padding: '10px 18px', borderRadius: 8, background: '#111', color: '#fff', border: 'none', fontSize: 14, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}
          >Add</button>
        </div>

        <div className="label">Team ({employees.length})</div>
        {employees.length === 0 ? (
          <div className="empty" style={{ padding: '20px 0' }}>
            <i className="ti ti-users" aria-hidden="true" /> No employees added yet.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {employees.map(emp => {
              const sc = STATUS_CONFIG[getStatus(emp.id)]
              return (
                <div key={emp.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div className="avatar" style={{ background: emp.color, width: 36, height: 36, fontSize: 12 }}>{initials(emp.name)}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{emp.name}</div>
                    <span className="pill" style={{ background: sc.bg, color: sc.color }}>{sc.label}</span>
                  </div>
                  <button
                    onClick={() => removeEmployee(emp.id)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 20, lineHeight: 1, padding: 4 }}
                    aria-label={`Remove ${emp.name}`}
                  >
                    <i className="ti ti-trash" aria-hidden="true" />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )

  const ReportsView = () => {
    const wd = getWeekDates()
    return (
      <>
        <div className="page-header">
          <div>
            <div className="app-title">TimeTrack</div>
            <div className="page-heading">Weekly Report</div>
          </div>
          <div className="clock-time" style={{ fontSize: 12 }}>{fmtDate(wd[0])} – {fmtDate(wd[4])}</div>
        </div>
        <div style={{ padding: 16 }}>
          {employees.length === 0 ? (
            <div className="empty"><i className="ti ti-chart-bar" aria-hidden="true" />No employees yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
              {employees.map(emp => {
                const recs  = records.filter(r => r.empId === emp.id && wd.includes(r.date))
                const total = recs.reduce((s, r) => s + calcWorked(r), 0)
                const days  = recs.filter(r => r.clockIn).length
                return (
                  <div key={emp.id} className="card report-card">
                    <div className="report-header">
                      <div className="avatar" style={{ background: emp.color, width: 34, height: 34, fontSize: 11 }}>{initials(emp.name)}</div>
                      <div style={{ flex: 1 }}>
                        <div className="report-name">{emp.name}</div>
                        <div className="report-sub">{days} day{days !== 1 ? 's' : ''} this week</div>
                      </div>
                      <div className="report-total">{msToHM(total)}</div>
                    </div>
                    <div className="week-bars">
                      {wd.slice(0, 5).map(date => {
                        const r = recs.find(x => x.date === date)
                        const w = calcWorked(r)
                        return (
                          <div key={date} className="week-bar-col">
                            <div className="week-bar-day">{new Date(date + 'T12:00:00').toLocaleDateString([], { weekday: 'narrow' })}</div>
                            <div className="week-bar-track" style={{ background: w > 0 ? emp.color : '#E0E0E0' }} />
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button
              className="btn"
              onClick={downloadAllPDFs}
              disabled={employees.length === 0}
            >
              <i className="ti ti-file-download" aria-hidden="true" /> Download Individual PDFs
            </button>
            <button
              className="btn btn-primary"
              onClick={sendEmailReport}
              disabled={employees.length === 0}
            >
              <i className="ti ti-mail" aria-hidden="true" />
              {settings.email ? `Send to ${settings.email}` : 'Send Email Report'}
            </button>
          </div>
          {!settings.email && (
            <p style={{ textAlign: 'center', fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
              Set a report email in Settings
            </p>
          )}
        </div>
      </>
    )
  }

  const SettingsView = () => (
    <>
      <div className="page-header">
        <div><div className="app-title">TimeTrack</div><div className="page-heading">Settings</div></div>
      </div>
      <div style={{ padding: 16 }}>
        <div className="info-box">
          <strong>How weekly reports work</strong><br />
          "Send Email" opens your mail app pre-filled with everyone's hours for Mon–Fri.<br />
          "Download PDFs" saves one PDF per employee — attach them to the email manually.
        </div>

        <div className="label">Report email address</div>
        <input
          className="text-input"
          type="email"
          value={settEmail}
          onChange={e => setSettEmail(e.target.value)}
          placeholder="reports@yourcompany.com"
          style={{ marginBottom: 10 }}
        />
        <button
          className="btn btn-primary"
          onClick={() => { setSettings({ ...settings, email: settEmail }); showToast('Email saved!') }}
          style={{ marginBottom: 28 }}
        >
          <i className="ti ti-check" aria-hidden="true" /> Save Email
        </button>

        <div className="label">Data management</div>
        <button
          className="btn btn-danger"
          onClick={() => { if (confirm('Clear all time records? This cannot be undone.')) { setRecords([]); showToast('Records cleared') } }}
        >
          <i className="ti ti-trash" aria-hidden="true" /> Clear All Time Records
        </button>

        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 28, lineHeight: 1.6, textAlign: 'center' }}>
          TimeTrack v1.0.0 · Data stored in your browser
        </p>
      </div>
    </>
  )

  /* ─── Render ─── */
  const NAV_ITEMS = [
    { id: 'home',      icon: 'ti-home',      label: 'Home' },
    { id: 'employees', icon: 'ti-users',      label: 'Employees' },
    { id: 'reports',   icon: 'ti-chart-bar',  label: 'Reports' },
    { id: 'settings',  icon: 'ti-settings',   label: 'Settings' },
  ]

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', background: '#F7F7F6' }}>
      <h1 style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>
        TimeTrack — Employee time clock
      </h1>

      {toast && (
        <div className="toast-wrap">
          <div className="toast">{toast}</div>
        </div>
      )}

      <main className="page">
        {view === 'home'      && <HomeView />}
        {view === 'employee'  && <EmployeeView />}
        {view === 'employees' && <EmployeesView />}
        {view === 'reports'   && <ReportsView />}
        {view === 'settings'  && <SettingsView />}
      </main>

      {view !== 'employee' && (
        <nav className="bottom-nav" aria-label="Main navigation">
          {NAV_ITEMS.map(item => (
            <button
              key={item.id}
              className={`nav-btn ${view === item.id ? 'active' : ''}`}
              onClick={() => setView(item.id)}
              aria-current={view === item.id ? 'page' : undefined}
            >
              <i className={`ti ${item.icon}`} aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  )
}
