import { useState, useEffect, useRef } from 'react'
import jsPDF from 'jspdf'

/* ─── Firebase REST helpers ─── */
const DB = import.meta.env.VITE_FIREBASE_URL  // e.g. https://your-app-default-rtdb.firebaseio.com

const fbGet = async (path) => {
  try {
    const res = await fetch(`${DB}/${path}.json`)
    return await res.json()
  } catch { return null }
}

const fbSet = async (path, data) => {
  try {
    await fetch(`${DB}/${path}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  } catch {}
}

/* ─── Constants ─── */
const COLORS = ['#C0392B','#2980B9','#27AE60','#D4850A','#7D3C98','#148F77','#BA4A00','#1A5276']

const STATUS_CONFIG = {
  out:   { label: 'Not started', bg: '#F5F5F5', color: '#666' },
  in:    { label: 'Clocked in',  bg: '#E8F5E9', color: '#1B5E20' },
  lunch: { label: 'On lunch',    bg: '#FFF3E0', color: '#E65100' },
  done:  { label: 'Clocked out', bg: '#F5F5F5', color: '#666' },
}

/* ─── Helpers ─── */
const fmt     = ts => ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--'
const fmtDate = d  => new Date(d + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
const msToHM  = ms => {
  if (!ms || ms <= 0) return '0h 00m'
  return `${Math.floor(ms / 3600000)}h ${String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0')}m`
}
const initials = n => n.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
const getToday = () => new Date().toISOString().split('T')[0]

const getWeekDates = () => {
  // Pay week: Friday → Monday → Tuesday → Wednesday → Thursday
  const now = new Date()
  const day = now.getDay() // 0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri,6=Sat
  const daysBackToFriday = (day + 2) % 7
  const friday = new Date(now)
  friday.setDate(now.getDate() - daysBackToFriday)
  // Fri=+0, Mon=+3, Tue=+4, Wed=+5, Thu=+6
  return [0, 3, 4, 5, 6].map(offset => {
    const d = new Date(friday)
    d.setDate(friday.getDate() + offset)
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

/* ─── Main App ─── */
export default function App() {
  const [employees, setEmployees] = useState([])
  const [records,   setRecords]   = useState([])
  const [settings,  setSettings]  = useState({ email: '' })
  const [view,      setView]      = useState('home')
  const [selEmpId,  setSelEmpId]  = useState(null)
  const [settEmail, setSettEmail] = useState('')
  const [toast,     setToast]     = useState('')
  const [loading,   setLoading]   = useState(true)
  const [, setTick] = useState(0)
  const newNameRef = useRef('')
  const inputRef   = useRef(null)

  /* ─── Load shared data from Firebase ─── */
  const loadAll = async () => {
    const [emps, recs, sett] = await Promise.all([
      fbGet('employees'),
      fbGet('records'),
      fbGet('settings'),
    ])
    if (Array.isArray(emps))         setEmployees(emps)
    if (Array.isArray(recs))         setRecords(recs)
    if (sett?.email !== undefined)   { setSettings(sett); setSettEmail(sett.email || '') }
    setLoading(false)
  }

  useEffect(() => {
    loadAll()
    const onVisible = () => { if (document.visibilityState === 'visible') loadAll() }
    document.addEventListener('visibilitychange', onVisible)
    const t = setInterval(() => setTick(x => x + 1), 30000)
    return () => { document.removeEventListener('visibilitychange', onVisible); clearInterval(t) }
  }, [])

  /* ─── Save helpers ─── */
  const saveEmployees = async emps => { setEmployees(emps); await fbSet('employees', emps) }
  const saveRecords   = async recs => { setRecords(recs);   await fbSet('records', recs) }
  const saveSettings  = async sett => { setSettings(sett);  await fbSet('settings', sett) }

  const showToast = msg => { setToast(msg); setTimeout(() => setToast(''), 3000) }

  /* ─── Record helpers ─── */
  const getTodayRec = empId => records.find(r => r.empId === empId && r.date === getToday())
  const getStatus = empId => {
    const r = getTodayRec(empId)
    if (!r?.clockIn) return 'out'
    if (r.clockOut)  return 'done'
    if (r.lunchStart && !r.lunchEnd) return 'lunch'
    return 'in'
  }

  /* ─── Clock actions ─── */
  const doClockIn = async empId => {
    if (getTodayRec(empId)) return
    await saveRecords([...records, { id: `${empId}-${Date.now()}`, empId, date: getToday(), clockIn: Date.now(), clockOut: null, lunchStart: null, lunchEnd: null }])
  }
  const doClockOut = async empId => {
    await saveRecords(records.map(r => r.empId === empId && r.date === getToday() ? { ...r, clockOut: Date.now(), lunchEnd: r.lunchStart && !r.lunchEnd ? Date.now() : r.lunchEnd } : r))
  }
  const doLunchStart = async empId => {
    await saveRecords(records.map(r => r.empId === empId && r.date === getToday() ? { ...r, lunchStart: Date.now() } : r))
  }
  const doLunchEnd = async empId => {
    await saveRecords(records.map(r => r.empId === empId && r.date === getToday() ? { ...r, lunchEnd: Date.now() } : r))
  }

  /* ─── Employee actions ─── */
  const addEmployee = async () => {
    const name = newNameRef.current.trim()
    if (!name) return
    const emp = { id: Date.now(), name, color: COLORS[employees.length % COLORS.length] }
    await saveEmployees([...employees, emp])
    newNameRef.current = ''
    if (inputRef.current) inputRef.current.value = ''
    showToast(`${name} added!`)
  }

  const removeEmployee = async id => {
    if (!confirm('Remove this employee? Their time records will remain.')) return
    await saveEmployees(employees.filter(e => e.id !== id))
  }

  /* ─── PDF — matches physical time sheet ─── */
  const generatePDF = emp => {
    const wd   = getWeekDates() // [Fri, Mon, Tue, Wed, Thu]
    const recs = records.filter(r => r.empId === emp.id && wd.includes(r.date))
    const doc  = new jsPDF({ unit: 'mm', format: 'letter' })

    const PW = 215.9, PH = 279.4
    const M  = 14   // margin

    // ── Cream background ──
    doc.setFillColor(245, 238, 220)
    doc.rect(0, 0, PW, PH, 'F')

    // ── Double border ──
    doc.setDrawColor(120, 75, 55)
    doc.setLineWidth(1.2)
    doc.rect(7, 7, PW - 14, PH - 14)
    doc.setLineWidth(0.4)
    doc.rect(10, 10, PW - 20, PH - 20)

    // ── Header: Name + TIME SHEET ──
    doc.setTextColor(80, 35, 20)
    doc.setFontSize(12); doc.setFont(undefined, 'normal')
    doc.text('Name:', M + 2, 26)
    doc.setFont(undefined, 'bold'); doc.setFontSize(11)
    doc.text(emp.name, M + 18, 26)
    // Underline name
    const nameW = doc.getTextWidth(emp.name)
    doc.setLineWidth(0.4)
    doc.line(M + 18, 27.5, M + 18 + nameW, 27.5)

    // TIME SHEET title
    doc.setFontSize(22); doc.setFont(undefined, 'bold')
    doc.text('TIME SHEET', PW - M - 2, 26, { align: 'right' })
    const tsW = doc.getTextWidth('TIME SHEET')
    doc.setLineWidth(0.6)
    doc.line(PW - M - 2 - tsW, 27.8, PW - M - 2, 27.8)

    // ── Week Ending / Off Days / Leaving Early ──
    const weekEndDate = new Date(wd[4] + 'T12:00:00')
    const weekEndStr  = weekEndDate.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })
    doc.setFontSize(10); doc.setFont(undefined, 'normal')
    doc.text('Week Ending:', M + 2, 38)
    doc.setFont(undefined, 'bold')
    doc.text(weekEndStr, M + 28, 38)
    // ── Table setup ──
    const TT  = 54   // table top y
    const RH  = 12   // row height
    const TL  = M + 2               // table left x
    const TR  = PW - M - 2          // table right x
    const TW  = TR - TL             // table width = ~187.9mm

    // Column x positions (left edge of each column)
    const C = {
      day:   TL,
      date:  TL + 38,
      start: TL + 65,
      end:   TL + 100,
      lunch: TL + 135,
      total: TL + 162,
    }

    // ── Column headers ──
    doc.setFont(undefined, 'bold'); doc.setFontSize(8.5)
    doc.setTextColor(80, 35, 20)
    doc.text('DATE',       C.day   + 1, TT - 9)
    doc.text('DATE',       C.date  + 1, TT - 9)
    doc.text('START TIME', C.start + 1, TT - 9)
    doc.text('END TIME',   C.end   + 1, TT - 9)
    doc.text('LUNCH',      C.lunch + 1, TT - 13)
    doc.text('BREAK',      C.lunch + 1, TT - 7)
    doc.text('TOTAL HOURS',C.total + 1, TT - 9)

    // ── Draw table grid ──
    doc.setDrawColor(120, 75, 55)
    doc.setLineWidth(0.45)

    // Horizontal lines: top of header, top of data, after each row, bottom
    const rows = 5 // Fri Mon Tue Wed Thu
    doc.line(TL, TT - 15, TR, TT - 15) // top of header
    doc.line(TL, TT,      TR, TT)       // below header / top of data
    for (let i = 1; i <= rows + 1; i++) {
      doc.line(TL, TT + i * RH, TR, TT + i * RH)
    }

    // Vertical lines
    ;[C.day, C.date, C.start, C.end, C.lunch, C.total, TR].forEach(x => {
      doc.line(x, TT - 15, x, TT + (rows + 1) * RH)
    })

    // ── Data rows ──
    const DAY_NAMES = ['Friday','Monday','Tuesday','Wednesday','Thursday']
    let totalWorkedMs = 0, totalLunchMs = 0

    doc.setFont(undefined, 'normal'); doc.setFontSize(10)

    wd.forEach((date, i) => {
      const r      = recs.find(x => x.date === date)
      const worked = calcWorked(r)
      const lunch  = calcLunch(r)
      totalWorkedMs += worked
      totalLunchMs  += lunch

      const y = TT + i * RH + RH - 3.5

      doc.setFont(undefined, 'normal'); doc.setFontSize(10)
      doc.setTextColor(30, 20, 15)
      doc.text(DAY_NAMES[i], C.day + 1, y)

      const dateStr = new Date(date + 'T12:00:00').toLocaleDateString([], { month: 'numeric', day: 'numeric', year: '2-digit' })
      doc.text(dateStr, C.date + 1, y)

      doc.setFontSize(9.5)
      if (r?.clockIn)  doc.text(fmt(r.clockIn),  C.start + 1, y)
      if (r?.clockOut) doc.text(fmt(r.clockOut), C.end   + 1, y)
      if (lunch > 0)   doc.text(msToHM(lunch),   C.lunch + 1, y)
      if (worked > 0)  doc.text(msToHM(worked),  C.total + 1, y)
    })

    // ── Weekly Totals row ──
    const totY = TT + rows * RH
    doc.setFont(undefined, 'bold'); doc.setFontSize(9)
    doc.setTextColor(80, 35, 20)
    doc.text('WEEKLY TOTALS', C.day   + 1, totY + RH - 3.5)
    doc.text('--',            C.date  + 1, totY + RH - 3.5)
    doc.text('--',            C.start + 1, totY + RH - 3.5)
    doc.text('--',            C.end   + 1, totY + RH - 3.5)
    doc.setFontSize(10); doc.setFont(undefined, 'bold')
    doc.setTextColor(30, 20, 15)
    if (totalLunchMs  > 0) doc.text(msToHM(totalLunchMs),  C.lunch + 1, totY + RH - 3.5)
    if (totalWorkedMs > 0) doc.text(msToHM(totalWorkedMs), C.total + 1, totY + RH - 3.5)

    // ── Signature boxes ──
    const sigTop = TT + (rows + 1) * RH + 14
    const sigH   = 22
    const sigW   = TW

    doc.setDrawColor(120, 75, 55)
    doc.setLineWidth(0.4)
    doc.setFont(undefined, 'italic'); doc.setFontSize(10)
    doc.setTextColor(80, 35, 20)

    // Employee signature
    doc.rect(TL, sigTop, sigW, sigH)
    doc.text('Employee signature:', TL + 3, sigTop + 7)
    // Signature line
    doc.setLineWidth(0.3)
    doc.line(TL + 45, sigTop + 16, TL + sigW - 4, sigTop + 16)

    // Supervisor signature
    doc.rect(TL, sigTop + sigH + 5, sigW, sigH)
    doc.text('Supervisor signature:', TL + 3, sigTop + sigH + 12)
    doc.line(TL + 47, sigTop + sigH + 21, TL + sigW - 4, sigTop + sigH + 21)

    return doc
  }

  const downloadAllPDFs = () => {
    const wd = getWeekDates()
    employees.forEach(emp => generatePDF(emp).save(`${emp.name.replace(/\s+/g,'-')}-timesheet-week-ending-${wd[4]}.pdf`))
    showToast(`Downloaded ${employees.length} PDF${employees.length!==1?'s':''}`)
  }

  const sendEmailReport = () => {
    if (!settings.email) { showToast('Set a report email in Settings first'); return }
    const wd = getWeekDates()
    let body = `Weekly Time Reports\nWeek of ${fmtDate(wd[0])} to ${fmtDate(wd[4])}\n${'═'.repeat(50)}\n\n`
    employees.forEach(emp => {
      const recs = records.filter(r => r.empId === emp.id && wd.includes(r.date))
      let total = 0; body += `${emp.name}\n${'─'.repeat(30)}\n`
      wd.slice(0,5).forEach(date => {
        const r = recs.find(x=>x.date===date); const w=calcWorked(r); total+=w
        body += `${fmtDate(date)}: In ${r?.clockIn?fmt(r.clockIn):'--'} | Lunch ${r?.lunchStart?msToHM(calcLunch(r)):'--'} | Out ${r?.clockOut?fmt(r.clockOut):'--'} | ${w>0?msToHM(w):'No hours'}\n`
      })
      body += `TOTAL: ${msToHM(total)}\n\n`
    })
    window.open(`mailto:${settings.email}?subject=${encodeURIComponent(`Weekly Time Reports – ${fmtDate(wd[0])} to ${fmtDate(wd[4])}`)}&body=${encodeURIComponent(body)}`)
    showToast('Opening email…')
  }

  const selEmp = employees.find(e => e.id === selEmpId) ?? null

  /* ─── Guard: Firebase not configured ─── */
  if (!DB) return (
    <div style={{padding:24,maxWidth:420,margin:'0 auto',fontFamily:'system-ui'}}>
      <h2 style={{marginBottom:12}}>⚠️ Firebase not configured</h2>
      <p style={{fontSize:14,lineHeight:1.6,color:'#444'}}>
        Add <code style={{background:'#f0f0f0',padding:'2px 6px',borderRadius:4}}>VITE_FIREBASE_URL</code> to your Vercel environment variables. See the README.
      </p>
    </div>
  )

  if (loading) return (
    <div style={{display:'flex',alignItems:'center',justifyContent:'center',minHeight:'100dvh',fontFamily:'system-ui',color:'#666',fontSize:14}}>
      Loading…
    </div>
  )

  const NAV_ITEMS = [
    { id:'home',      icon:'ti-home',     label:'Home' },
    { id:'employees', icon:'ti-users',     label:'Employees' },
    { id:'reports',   icon:'ti-chart-bar', label:'Reports' },
    { id:'settings',  icon:'ti-settings',  label:'Settings' },
  ]

  const wd = getWeekDates()

  return (
    <div style={{minHeight:'100dvh',display:'flex',flexDirection:'column',background:'#F7F7F6'}}>
      <h1 style={{position:'absolute',width:1,height:1,overflow:'hidden',clip:'rect(0,0,0,0)'}}>TimeTrack — Employee time clock</h1>

      {toast && <div className="toast-wrap"><div className="toast">{toast}</div></div>}

      <main className="page">

        {/* ── HOME ── */}
        {view === 'home' && (
          <>
            <div className="page-header">
              <div>
                <div className="app-title">TimeTrack</div>
                <div className="page-heading">{new Date().toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'})}</div>
              </div>
              <div className="clock-time">{new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div>
            </div>
            <div style={{padding:'12px 16px',display:'flex',flexDirection:'column',gap:8}}>
              {employees.length === 0 ? (
                <div className="empty"><i className="ti ti-users" aria-hidden="true"/>No employees yet.<br/>Add them in the Employees tab.</div>
              ) : employees.map(emp => {
                const st=getStatus(emp.id), rec=getTodayRec(emp.id), w=calcWorked(rec), sc=STATUS_CONFIG[st]
                return (
                  <div key={emp.id} className="card emp-row" onClick={()=>{setSelEmpId(emp.id);setView('employee')}}>
                    <div className="avatar" style={{background:emp.color}}>{initials(emp.name)}</div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontWeight:600,fontSize:15,marginBottom:3}}>{emp.name}</div>
                      <div style={{display:'flex',alignItems:'center',gap:6}}>
                        <span className="pill" style={{background:sc.bg,color:sc.color}}>{sc.label}</span>
                        {w>0 && <span style={{fontSize:12,color:'var(--muted)'}}>{msToHM(w)}</span>}
                      </div>
                    </div>
                    <div style={{textAlign:'right',fontSize:11,color:'var(--muted)',lineHeight:1.7}}>
                      {rec?.clockIn  && <div>In: {fmt(rec.clockIn)}</div>}
                      {rec?.clockOut && <div>Out: {fmt(rec.clockOut)}</div>}
                    </div>
                    <i className="ti ti-chevron-right" style={{color:'var(--muted)',fontSize:16}} aria-hidden="true"/>
                  </div>
                )
              })}
            </div>
          </>
        )}

        {/* ── EMPLOYEE DETAIL ── */}
        {view === 'employee' && selEmp && (()=>{
          const emp=selEmp, st=getStatus(emp.id), rec=getTodayRec(emp.id)
          const w=calcWorked(rec), ln=calcLunch(rec), sc=STATUS_CONFIG[st]
          const wRecs=records.filter(r=>r.empId===emp.id&&wd.includes(r.date))
          const wTotal=wRecs.reduce((s,r)=>s+calcWorked(r),0)
          return (
            <>
              <div className="page-header">
                <div>
                  <button className="back-btn" onClick={()=>setView('home')}><i className="ti ti-arrow-left" aria-hidden="true"/> Back</button>
                  <div className="page-heading">{emp.name}</div>
                </div>
                <span className="pill" style={{background:sc.bg,color:sc.color}}>{sc.label}</span>
              </div>
              <div style={{padding:16}}>
                <div className="metrics">
                  <div className="metric"><div className="metric-label">Today</div><div className="metric-value">{msToHM(w)}</div></div>
                  <div className="metric"><div className="metric-label">This week</div><div className="metric-value">{msToHM(wTotal)}</div></div>
                </div>

                {rec && (
                  <div className="card" style={{marginBottom:18}}>
                    <div className="label">Today's record</div>
                    {[['Clock in',fmt(rec.clockIn)],['Lunch start',fmt(rec.lunchStart)],['Lunch end',fmt(rec.lunchEnd)],['Clock out',fmt(rec.clockOut)]].map(([l,v])=>(
                      <div className="time-row" key={l}><span className="t-label">{l}</span><span className="t-val">{v}</span></div>
                    ))}
                    {ln>0 && <div className="time-row"><span className="t-label">Lunch duration</span><span className="t-val">{msToHM(ln)}</span></div>}
                  </div>
                )}

                <div style={{display:'flex',flexDirection:'column',gap:10,marginBottom:24}}>
                  {st==='out' && <button className="btn btn-green" onClick={()=>doClockIn(emp.id)}><i className="ti ti-clock" aria-hidden="true"/> Clock In</button>}
                  {st==='in' && (<>
                    <button className="btn btn-amber" onClick={()=>doLunchStart(emp.id)}><i className="ti ti-soup" aria-hidden="true"/> Start Lunch Break</button>
                    <button className="btn" onClick={()=>doClockOut(emp.id)}><i className="ti ti-clock-off" aria-hidden="true"/> Clock Out</button>
                  </>)}
                  {st==='lunch' && (<>
                    <button className="btn btn-amber" onClick={()=>doLunchEnd(emp.id)}><i className="ti ti-soup" aria-hidden="true"/> End Lunch Break</button>
                    <button className="btn" onClick={()=>doClockOut(emp.id)}><i className="ti ti-clock-off" aria-hidden="true"/> Clock Out</button>
                  </>)}
                  {st==='done' && (
                    <div style={{textAlign:'center',padding:'16px 0',color:'var(--muted)',fontSize:13}}>
                      <i className="ti ti-circle-check" style={{color:'#27AE60',fontSize:22,display:'block',marginBottom:6}} aria-hidden="true"/>
                      Done for today — clocked out at {fmt(rec?.clockOut)}
                    </div>
                  )}
                </div>

                <div className="label">This week</div>
                <div style={{display:'flex',flexDirection:'column',gap:4}}>
                  {wd.slice(0,5).map(date=>{
                    const r=wRecs.find(x=>x.date===date), dw=calcWorked(r), isToday=date===getToday()
                    return (
                      <div key={date} className={`week-row ${isToday?'today':dw>0?'worked':''}`}>
                        <span className="wday">{fmtDate(date)}</span>
                        <span className="whrs">{dw>0?msToHM(dw):'—'}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            </>
          )
        })()}

        {/* ── EMPLOYEES ── */}
        {view === 'employees' && (
          <>
            <div className="page-header">
              <div><div className="app-title">TimeTrack</div><div className="page-heading">Employees</div></div>
            </div>
            <div style={{padding:16}}>
              <div className="label">Add employee</div>
              <div style={{display:'flex',gap:8,marginBottom:24}}>
                <input
                  ref={inputRef}
                  className="text-input"
                  style={{flex:1}}
                  onChange={e => { newNameRef.current = e.target.value }}
                  onKeyDown={e => e.key==='Enter' && addEmployee()}
                  placeholder="Full name"
                  autoComplete="off"
                />
                <button onClick={addEmployee} style={{padding:'10px 18px',borderRadius:8,background:'#111',color:'#fff',border:'none',fontSize:14,fontWeight:600,cursor:'pointer',whiteSpace:'nowrap'}}>
                  Add
                </button>
              </div>

              <div className="label">Team ({employees.length})</div>
              {employees.length === 0 ? (
                <div className="empty" style={{padding:'20px 0'}}><i className="ti ti-users" aria-hidden="true"/> No employees added yet.</div>
              ) : (
                <div style={{display:'flex',flexDirection:'column',gap:8}}>
                  {employees.map(emp => {
                    const sc=STATUS_CONFIG[getStatus(emp.id)]
                    return (
                      <div key={emp.id} className="card" style={{display:'flex',alignItems:'center',gap:10}}>
                        <div className="avatar" style={{background:emp.color,width:36,height:36,fontSize:12}}>{initials(emp.name)}</div>
                        <div style={{flex:1}}>
                          <div style={{fontWeight:600,fontSize:14}}>{emp.name}</div>
                          <span className="pill" style={{background:sc.bg,color:sc.color}}>{sc.label}</span>
                        </div>
                        <button onClick={()=>removeEmployee(emp.id)} style={{background:'none',border:'none',cursor:'pointer',color:'var(--muted)',fontSize:20,lineHeight:1,padding:4}} aria-label={`Remove ${emp.name}`}>
                          <i className="ti ti-trash" aria-hidden="true"/>
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </>
        )}

        {/* ── REPORTS ── */}
        {view === 'reports' && (
          <>
            <div className="page-header">
              <div><div className="app-title">TimeTrack</div><div className="page-heading">Weekly Report</div></div>
              <div className="clock-time" style={{fontSize:12}}>{fmtDate(wd[0])} – {fmtDate(wd[4])}</div>
            </div>
            <div style={{padding:16}}>
              {employees.length===0 ? (
                <div className="empty"><i className="ti ti-chart-bar" aria-hidden="true"/>No employees yet.</div>
              ) : (
                <div style={{display:'flex',flexDirection:'column',gap:10,marginBottom:24}}>
                  {employees.map(emp=>{
                    const recs=records.filter(r=>r.empId===emp.id&&wd.includes(r.date))
                    const total=recs.reduce((s,r)=>s+calcWorked(r),0), days=recs.filter(r=>r.clockIn).length
                    return (
                      <div key={emp.id} className="card report-card">
                        <div className="report-header">
                          <div className="avatar" style={{background:emp.color,width:34,height:34,fontSize:11}}>{initials(emp.name)}</div>
                          <div style={{flex:1}}>
                            <div className="report-name">{emp.name}</div>
                            <div className="report-sub">{days} day{days!==1?'s':''} this week</div>
                          </div>
                          <div className="report-total">{msToHM(total)}</div>
                        </div>
                        <div className="week-bars">
                          {wd.slice(0,5).map(date=>{
                            const r=recs.find(x=>x.date===date), w=calcWorked(r)
                            return (
                              <div key={date} className="week-bar-col">
                                <div className="week-bar-day">{new Date(date+'T12:00:00').toLocaleDateString([],{weekday:'narrow'})}</div>
                                <div className="week-bar-track" style={{background:w>0?emp.color:'#E0E0E0'}}/>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
              <div style={{display:'flex',flexDirection:'column',gap:10}}>
                <button className="btn" onClick={downloadAllPDFs} disabled={employees.length===0}>
                  <i className="ti ti-file-download" aria-hidden="true"/> Download Individual PDFs
                </button>
                <button className="btn btn-primary" onClick={sendEmailReport} disabled={employees.length===0}>
                  <i className="ti ti-mail" aria-hidden="true"/>
                  {settings.email ? `Send to ${settings.email}` : 'Send Email Report'}
                </button>
              </div>
              {!settings.email && <p style={{textAlign:'center',fontSize:12,color:'var(--muted)',marginTop:8}}>Set a report email in Settings</p>}
            </div>
          </>
        )}

        {/* ── SETTINGS ── */}
        {view === 'settings' && (
          <>
            <div className="page-header">
              <div><div className="app-title">TimeTrack</div><div className="page-heading">Settings</div></div>
            </div>
            <div style={{padding:16}}>
              <div className="info-box">
                <strong>How weekly reports work</strong><br/>
                "Send Email" opens your mail app pre-filled with everyone's hours Mon–Fri.<br/>
                "Download PDFs" saves one PDF per employee — attach them to the email.
              </div>
              <div className="label">Report email address</div>
              <input className="text-input" type="email" value={settEmail} onChange={e=>setSettEmail(e.target.value)} placeholder="reports@yourcompany.com" style={{marginBottom:10}}/>
              <button className="btn btn-primary" onClick={()=>{saveSettings({...settings,email:settEmail});showToast('Email saved!')}} style={{marginBottom:28}}>
                <i className="ti ti-check" aria-hidden="true"/> Save Email
              </button>
              <div className="label">Data management</div>
              <button className="btn btn-danger" onClick={()=>{if(confirm('Clear all time records? This cannot be undone.')){saveRecords([]);showToast('Records cleared')}}}>
                <i className="ti ti-trash" aria-hidden="true"/> Clear All Time Records
              </button>
              <p style={{fontSize:12,color:'var(--muted)',marginTop:28,lineHeight:1.6,textAlign:'center'}}>TimeTrack v1.1.0 · Shared data via Firebase</p>
            </div>
          </>
        )}

      </main>

      {view !== 'employee' && (
        <nav className="bottom-nav" aria-label="Main navigation">
          {NAV_ITEMS.map(item=>(
            <button key={item.id} className={`nav-btn ${view===item.id?'active':''}`} onClick={()=>setView(item.id)} aria-current={view===item.id?'page':undefined}>
              <i className={`ti ${item.icon}`} aria-hidden="true"/>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  )
}
