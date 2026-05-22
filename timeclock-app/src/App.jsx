import { useState, useEffect, useRef } from 'react'
import jsPDF from 'jspdf'

/* ─── Firebase REST helpers ─── */
const DB = import.meta.env.VITE_FIREBASE_URL

const fbGet = async (path) => {
  try { const res = await fetch(`${DB}/${path}.json`); return await res.json() }
  catch { return null }
}
const fbSet = async (path, data) => {
  try { await fetch(`${DB}/${path}.json`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) }) }
  catch {}
}

/* ─── Auth helpers ─── */
const hashPassword = async (pw) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('')
}

const canUseBiometric = () => window.PublicKeyCredential !== undefined && navigator.credentials !== undefined

const registerBiometric = async (userId, username) => {
  try {
    const challenge = crypto.getRandomValues(new Uint8Array(32))
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: 'TimeTrack', id: window.location.hostname },
        user: { id: new TextEncoder().encode(userId), name: username, displayName: username },
        pubKeyCredParams: [{ alg:-7, type:'public-key' }, { alg:-257, type:'public-key' }],
        authenticatorSelection: { authenticatorAttachment:'platform', userVerification:'required' },
        timeout: 60000, attestation: 'none'
      }
    })
    const credId = btoa(String.fromCharCode(...new Uint8Array(cred.rawId)))
    localStorage.setItem(`tc_bio_${userId}`, credId)
    return true
  } catch { return false }
}

const verifyBiometric = async (userId) => {
  try {
    const credIdStr = localStorage.getItem(`tc_bio_${userId}`)
    if (!credIdStr) return false
    const credId  = Uint8Array.from(atob(credIdStr), c => c.charCodeAt(0))
    const challenge = crypto.getRandomValues(new Uint8Array(32))
    await navigator.credentials.get({
      publicKey: { challenge, rpId: window.location.hostname, allowCredentials:[{ type:'public-key', id:credId }], userVerification:'required', timeout:60000 }
    })
    return true
  } catch { return false }
}

const hasBiometric = (userId) => !!localStorage.getItem(`tc_bio_${userId}`)

/* ─── Constants ─── */
const COLORS = ['#C0392B','#2980B9','#27AE60','#D4850A','#7D3C98','#148F77','#BA4A00','#1A5276']
const STATUS_CONFIG = {
  out:   { label:'Not started', bg:'#F5F5F5', color:'#666' },
  in:    { label:'Clocked in',  bg:'#E8F5E9', color:'#1B5E20' },
  lunch: { label:'On lunch',    bg:'#FFF3E0', color:'#E65100' },
  done:  { label:'Clocked out', bg:'#F5F5F5', color:'#666' },
}

/* ─── Helpers ─── */
const fmt     = ts => ts ? new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : '--:--'
const fmtDate = d  => new Date(d+'T12:00:00').toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'})
const msToHM  = ms => { if(!ms||ms<=0) return '0h 00m'; return `${Math.floor(ms/3600000)}h ${String(Math.floor((ms%3600000)/60000)).padStart(2,'0')}m` }
const initials = n => n.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2)
const getToday = () => new Date().toISOString().split('T')[0]

const getWeekDates = () => {
  const now = new Date(), day = now.getDay()
  const daysBackToFriday = (day + 2) % 7
  const friday = new Date(now)
  friday.setDate(now.getDate() - daysBackToFriday)
  return [0,3,4,5,6].map(offset => {
    const d = new Date(friday); d.setDate(friday.getDate()+offset); return d.toISOString().split('T')[0]
  })
}

const calcLunch = r => {
  if (!r?.lunches?.length) return 0
  return r.lunches.reduce((sum, lb) => sum + Math.max(0, (lb.end ?? Date.now()) - lb.start), 0)
}
const calcWorked = r => {
  if (!r?.clockIn) return 0
  const end = r.clockOut ?? Date.now()
  return Math.max(0, (end - r.clockIn) - calcLunch(r))
}
const onLunch = r => r?.lunches?.length > 0 && !r.lunches[r.lunches.length - 1].end

/* ─── Main App ─── */
export default function App() {
  const [currentUser, setCurrentUser] = useState(null)
  const [users,      setUsers]      = useState({})
  const [employees,  setEmployees]  = useState([])
  const [records,    setRecords]    = useState([])
  const [settings,   setSettings]   = useState({ email:'' })
  const [view,       setView]       = useState('loading')
  const [selEmpId,   setSelEmpId]   = useState(null)
  const [toast,      setToast]      = useState('')
  const [, setTick] = useState(0)

  // Login
  const [loginError,   setLoginError]   = useState('')
  const [loginLoading, setLoginLoading] = useState(false)
  const loginUserRef  = useRef(''); const loginUserInput  = useRef(null)
  const loginPassRef  = useRef(''); const loginPassInput  = useRef(null)

  // Setup
  const setupUserRef  = useRef(''); const setupUserInput  = useRef(null)
  const setupPassRef  = useRef(''); const setupPassInput  = useRef(null)

  // Add employee form
  const newNameRef  = useRef(''); const newNameInput  = useRef(null)
  const newUserRef  = useRef(''); const newUserInput  = useRef(null)
  const newPassRef  = useRef(''); const newPassInput  = useRef(null)

  // Settings
  const [settEmail, setSettEmail] = useState('')

  // Biometric offer after login
  const [offerBio,   setOfferBio]   = useState(false)
  const [pendingBio, setPendingBio] = useState(null)

  const loadAll = async () => {
    const [usrs,emps,recs,sett] = await Promise.all([fbGet('users'),fbGet('employees'),fbGet('records'),fbGet('settings')])
    if (usrs && typeof usrs==='object') setUsers(usrs)
    if (Array.isArray(emps)) setEmployees(emps)
    if (Array.isArray(recs)) setRecords(recs)
    if (sett?.email !== undefined) { setSettings(sett); setSettEmail(sett.email||'') }
  }

  useEffect(() => {
    const init = async () => {
      const saved = localStorage.getItem('tc_session')
      if (saved) {
        const user = JSON.parse(saved)
        setCurrentUser(user)
        await loadAll()
        setView('home')
      } else {
        const usrs = await fbGet('users')
        if (usrs && typeof usrs==='object' && Object.keys(usrs).length>0) { setUsers(usrs); setView('login') }
        else setView('setup')
      }
    }
    init()
    const onVisible = () => { if(document.visibilityState==='visible') loadAll() }
    document.addEventListener('visibilitychange', onVisible)
    const t = setInterval(()=>setTick(x=>x+1), 30000)
    return () => { document.removeEventListener('visibilitychange',onVisible); clearInterval(t) }
  }, [])

  const showToast = msg => { setToast(msg); setTimeout(()=>setToast(''),3000) }

  const saveEmployees = async emps => { setEmployees(emps); await fbSet('employees',emps) }
  const saveRecords   = async recs => { setRecords(recs);   await fbSet('records',recs) }
  const saveSettings  = async sett => { setSettings(sett);  await fbSet('settings',sett) }
  const saveUsers     = async usrs => { setUsers(usrs);     await fbSet('users',usrs) }

  /* ─── Auth ─── */
  const doLogin = async () => {
    const username = loginUserRef.current.trim()
    const password = loginPassRef.current
    if (!username||!password) { setLoginError('Please enter username and password'); return }
    setLoginLoading(true); setLoginError('')
    try {
      const hash  = await hashPassword(password)
      const match = Object.entries(users).find(([,u]) => u.username.toLowerCase()===username.toLowerCase() && u.passwordHash===hash)
      if (!match) { setLoginError('Invalid username or password'); setLoginLoading(false); return }
      const [userId, userData] = match
      const session = { userId, username:userData.username, role:userData.role, empId:userData.empId??null }
      localStorage.setItem('tc_session', JSON.stringify(session))
      setCurrentUser(session)
      await loadAll()
      if (canUseBiometric() && !hasBiometric(userId)) { setPendingBio({userId,username:userData.username}); setOfferBio(true) }
      else setView('home')
    } catch { setLoginError('Login failed, please try again') }
    setLoginLoading(false)
  }

  const doBiometricLogin = async (userId) => {
    setLoginLoading(true); setLoginError('')
    const success = await verifyBiometric(userId)
    if (success) {
      const userData = users[userId]
      const session  = { userId, username:userData.username, role:userData.role, empId:userData.empId??null }
      localStorage.setItem('tc_session', JSON.stringify(session))
      setCurrentUser(session)
      await loadAll()
      setView('home')
    } else { setLoginError('Biometric authentication failed') }
    setLoginLoading(false)
  }

  const doSetupAdmin = async () => {
    const username = setupUserRef.current.trim()
    const password = setupPassRef.current.trim()
    if (!username||!password) return
    const hash   = await hashPassword(password)
    const userId = `user_${Date.now()}`
    const newUsers = { [userId]:{ username, passwordHash:hash, role:'admin', empId:null } }
    await saveUsers(newUsers)
    const session = { userId, username, role:'admin', empId:null }
    localStorage.setItem('tc_session', JSON.stringify(session))
    setCurrentUser(session)
    setView('home')
  }

  const logout = () => {
    setCurrentUser(null)
    localStorage.removeItem('tc_session')
    setLoginError('')
    if (loginUserInput.current) loginUserInput.current.value = ''
    if (loginPassInput.current) loginPassInput.current.value = ''
    setView(Object.keys(users).length>0 ? 'login' : 'setup')
  }

  const enableBiometric = async () => {
    if (!pendingBio) return
    const ok = await registerBiometric(pendingBio.userId, pendingBio.username)
    setOfferBio(false); setPendingBio(null)
    showToast(ok ? 'Face ID enabled!' : 'Could not enable Face ID')
    setView('home')
  }

  /* ─── Record helpers ─── */
  const getTodayRec = empId => records.find(r=>r.empId===empId&&r.date===getToday())
  const getStatus   = empId => {
    const r = getTodayRec(empId)
    if (!r?.clockIn) return 'out'
    if (r.clockOut)  return 'done'
    if (onLunch(r))  return 'lunch'
    return 'in'
  }

  const doClockIn    = async empId => { if(getTodayRec(empId)) return; await saveRecords([...records,{id:`${empId}-${Date.now()}`,empId,date:getToday(),clockIn:Date.now(),clockOut:null,lunches:[]}]) }
  const doClockOut   = async empId => {
    const updated = records.map(r => {
      if(r.empId!==empId||r.date!==getToday()) return r
      const lunches = onLunch(r) ? r.lunches.map((lb,i)=>i===r.lunches.length-1&&!lb.end?{...lb,end:Date.now()}:lb) : (r.lunches||[])
      return {...r, clockOut:Date.now(), lunches}
    })
    await saveRecords(updated)
  }
  const doLunchStart = async empId => await saveRecords(records.map(r=>r.empId===empId&&r.date===getToday()?{...r,lunches:[...(r.lunches||[]),{start:Date.now(),end:null}]}:r))
  const doLunchEnd   = async empId => await saveRecords(records.map(r=>{
    if(r.empId!==empId||r.date!==getToday()) return r
    const lunches=(r.lunches||[]).map((lb,i)=>i===r.lunches.length-1&&!lb.end?{...lb,end:Date.now()}:lb)
    return {...r,lunches}
  }))

  /* ─── Admin: add/remove employee ─── */
  const addEmployee = async () => {
    const name     = newNameRef.current.trim()
    const username = newUserRef.current.trim()
    const password = newPassRef.current.trim()
    if (!name||!username||!password) { showToast('Please fill in all fields'); return }
    if (Object.values(users).some(u=>u.username.toLowerCase()===username.toLowerCase())) { showToast('Username already taken'); return }
    const hash   = await hashPassword(password)
    const empId  = Date.now()
    const emp    = { id:empId, name, color:COLORS[employees.length%COLORS.length] }
    const userId = `user_${Date.now()+1}`
    await saveEmployees([...employees, emp])
    await saveUsers({ ...users, [userId]:{ username, passwordHash:hash, role:'employee', empId } })
    newNameRef.current=''; newUserRef.current=''; newPassRef.current=''
    if (newNameInput.current)  newNameInput.current.value  = ''
    if (newUserInput.current)  newUserInput.current.value  = ''
    if (newPassInput.current)  newPassInput.current.value  = ''
    showToast(`${name} added!`)
  }

  const removeEmployee = async id => {
    if (!confirm('Remove this employee and their login? Time records will remain.')) return
    await saveEmployees(employees.filter(e=>e.id!==id))
    const updated = {...users}
    Object.entries(updated).forEach(([uid,u])=>{ if(u.empId===id) delete updated[uid] })
    await saveUsers(updated)
  }

  /* ─── PDF ─── */
  const generatePDF = emp => {
    const wd   = getWeekDates()
    const recs = records.filter(r=>r.empId===emp.id&&wd.includes(r.date))
    const doc  = new jsPDF({ unit:'mm', format:'letter' })
    const PW=215.9, PH=279.4, M=14
    doc.setFillColor(245,238,220); doc.rect(0,0,PW,PH,'F')
    doc.setDrawColor(120,75,55); doc.setLineWidth(1.2); doc.rect(7,7,PW-14,PH-14)
    doc.setLineWidth(0.4); doc.rect(10,10,PW-20,PH-20)
    doc.setTextColor(80,35,20); doc.setFontSize(12); doc.setFont(undefined,'normal')
    doc.text('Name:', M+2, 26)
    doc.setFont(undefined,'bold'); doc.setFontSize(11); doc.text(emp.name, M+18, 26)
    const nameW=doc.getTextWidth(emp.name); doc.setLineWidth(0.4); doc.line(M+18,27.5,M+18+nameW,27.5)
    doc.setFontSize(22); doc.setFont(undefined,'bold')
    doc.text('TIME SHEET', PW-M-2, 26, {align:'right'})
    const tsW=doc.getTextWidth('TIME SHEET'); doc.setLineWidth(0.6); doc.line(PW-M-2-tsW,27.8,PW-M-2,27.8)
    const weekEndStr=new Date(wd[4]+'T12:00:00').toLocaleDateString([],{month:'long',day:'numeric',year:'numeric'})
    doc.setFontSize(10); doc.setFont(undefined,'normal'); doc.text('Week Ending:', M+2, 38)
    doc.setFont(undefined,'bold'); doc.text(weekEndStr, M+28, 38)
    const TT=54,RH=12,TL=M+2,TR=PW-M-2,TW=TR-TL
    const C={day:TL,date:TL+38,start:TL+65,end:TL+100,lunch:TL+135,total:TL+162}
    doc.setFont(undefined,'bold'); doc.setFontSize(8.5); doc.setTextColor(80,35,20)
    doc.text('DATE',C.day+1,TT-9); doc.text('DATE',C.date+1,TT-9)
    doc.text('START TIME',C.start+1,TT-9); doc.text('END TIME',C.end+1,TT-9)
    doc.text('LUNCH',C.lunch+1,TT-13); doc.text('BREAK',C.lunch+1,TT-7)
    doc.text('TOTAL HOURS',C.total+1,TT-9)
    doc.setDrawColor(120,75,55); doc.setLineWidth(0.45)
    const rows=5
    doc.line(TL,TT-15,TR,TT-15); doc.line(TL,TT,TR,TT)
    for(let i=1;i<=rows+1;i++) doc.line(TL,TT+i*RH,TR,TT+i*RH)
    ;[C.day,C.date,C.start,C.end,C.lunch,C.total,TR].forEach(x=>doc.line(x,TT-15,x,TT+(rows+1)*RH))
    const DAY_NAMES=['Friday','Monday','Tuesday','Wednesday','Thursday']
    let totalWorkedMs=0,totalLunchMs=0
    wd.forEach((date,i)=>{
      const r=recs.find(x=>x.date===date),worked=calcWorked(r),lunch=calcLunch(r)
      totalWorkedMs+=worked; totalLunchMs+=lunch
      const y=TT+i*RH+RH-3.5
      doc.setFont(undefined,'normal'); doc.setFontSize(10); doc.setTextColor(30,20,15)
      doc.text(DAY_NAMES[i],C.day+1,y)
      doc.text(new Date(date+'T12:00:00').toLocaleDateString([],{month:'numeric',day:'numeric',year:'2-digit'}),C.date+1,y)
      doc.setFontSize(9.5)
      if(r?.clockIn)  doc.text(fmt(r.clockIn),  C.start+1,y)
      if(r?.clockOut) doc.text(fmt(r.clockOut), C.end+1,y)
      if(lunch>0)     doc.text(msToHM(lunch),   C.lunch+1,y)
      if(worked>0)    doc.text(msToHM(worked),  C.total+1,y)
    })
    const totY=TT+rows*RH
    doc.setFont(undefined,'bold'); doc.setFontSize(9); doc.setTextColor(80,35,20)
    doc.text('WEEKLY TOTALS',C.day+1,totY+RH-3.5); doc.text('--',C.date+1,totY+RH-3.5)
    doc.text('--',C.start+1,totY+RH-3.5); doc.text('--',C.end+1,totY+RH-3.5)
    doc.setFontSize(10); doc.setFont(undefined,'bold'); doc.setTextColor(30,20,15)
    if(totalLunchMs>0)  doc.text(msToHM(totalLunchMs), C.lunch+1,totY+RH-3.5)
    if(totalWorkedMs>0) doc.text(msToHM(totalWorkedMs),C.total+1,totY+RH-3.5)
    const sigTop=TT+(rows+1)*RH+14,sigH=22
    doc.setDrawColor(120,75,55); doc.setLineWidth(0.4)
    doc.rect(TL,sigTop,TW,sigH)
    doc.setFont(undefined,'italic'); doc.setFontSize(10); doc.setTextColor(80,35,20)
    doc.text('Employee signature:',TL+3,sigTop+7)
    doc.setLineWidth(0.3); doc.line(TL+45,sigTop+16,TL+TW-4,sigTop+16)
    doc.setFontSize(15); doc.setFont(undefined,'italic'); doc.setTextColor(30,30,120)
    doc.text(emp.name,TL+48,sigTop+15)
    doc.rect(TL,sigTop+sigH+5,TW,sigH)
    doc.setFontSize(10); doc.setFont(undefined,'italic'); doc.setTextColor(80,35,20)
    doc.text('Supervisor signature:',TL+3,sigTop+sigH+12)
    doc.line(TL+47,sigTop+sigH+21,TL+TW-4,sigTop+sigH+21)
    return doc
  }

  const downloadAllPDFs = () => {
    const wd = getWeekDates()
    const list = isAdmin ? employees : employees.filter(e=>e.id===currentUser?.empId)
    list.forEach(emp=>generatePDF(emp).save(`${emp.name.replace(/\s+/g,'-')}-timesheet-${wd[4]}.pdf`))
    showToast(`Downloaded ${list.length} PDF${list.length!==1?'s':''}`)
  }

  const sendEmailReport = async () => {
    if (!settings.email) { showToast('Set a report email in Settings first'); return }
    const wd   = getWeekDates()
    const list = isAdmin ? employees : employees.filter(e=>e.id===currentUser?.empId)
    const files = list.map(emp=>{
      const blob=new Blob([generatePDF(emp).output('arraybuffer')],{type:'application/pdf'})
      return new File([blob],`${emp.name.replace(/\s+/g,'-')}-timesheet-${wd[4]}.pdf`,{type:'application/pdf'})
    })
    if (navigator.canShare&&navigator.canShare({files})) {
      try { await navigator.share({files,title:`Weekly Time Sheets — week ending ${fmtDate(wd[4])}`}); return }
      catch(e){ if(e.name!=='AbortError') console.error(e); return }
    }
    downloadAllPDFs()
    showToast('PDFs downloaded — attach to email!')
  }

  /* ─── Derived ─── */
  const selEmp  = employees.find(e=>e.id===selEmpId) ?? null
  const myEmp   = employees.find(e=>e.id===currentUser?.empId) ?? null
  const wd      = getWeekDates()
  const isAdmin = currentUser?.role === 'admin'

  /* ════════════════════════════════════════
     RENDER
  ════════════════════════════════════════ */
  if (!DB) return <div style={{padding:24,fontFamily:'system-ui'}}><h2>⚠️ Firebase not configured</h2><p>Add VITE_FIREBASE_URL to Vercel environment variables.</p></div>

  /* ── Loading ── */
  if (view==='loading') return <div style={{display:'flex',alignItems:'center',justifyContent:'center',minHeight:'100dvh',fontFamily:'system-ui',color:'#666',fontSize:14}}>Loading…</div>

  /* ── Biometric offer ── */
  if (offerBio) return (
    <div style={{minHeight:'100dvh',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',background:'#F7F7F6',fontFamily:'system-ui',padding:24}}>
      <div style={{fontSize:48,marginBottom:16}}>🔐</div>
      <div style={{fontSize:20,fontWeight:700,marginBottom:8}}>Enable Face ID?</div>
      <div style={{fontSize:14,color:'#666',textAlign:'center',marginBottom:32,lineHeight:1.6,maxWidth:300}}>Log in faster next time using Face ID or fingerprint instead of your password.</div>
      <button onClick={enableBiometric} style={{width:'100%',maxWidth:300,padding:14,borderRadius:14,background:'#111',color:'#fff',border:'none',fontSize:15,fontWeight:600,cursor:'pointer',marginBottom:12}}>Enable Face ID</button>
      <button onClick={()=>{setOfferBio(false);setPendingBio(null);setView('home')}} style={{width:'100%',maxWidth:300,padding:14,borderRadius:14,background:'transparent',color:'#666',border:'none',fontSize:14,cursor:'pointer'}}>Not now</button>
    </div>
  )

  /* ── First-time Setup ── */
  if (view==='setup') return (
    <div style={{minHeight:'100dvh',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',background:'#F7F7F6',fontFamily:'system-ui',padding:24}}>
      <div style={{fontSize:40,marginBottom:8}}>⏱</div>
      <div style={{fontSize:22,fontWeight:700,marginBottom:4}}>TimeTrack</div>
      <div style={{fontSize:14,color:'#666',marginBottom:32,textAlign:'center'}}>Create your admin account to get started</div>
      <div style={{width:'100%',maxWidth:320,display:'flex',flexDirection:'column',gap:12}}>
        <input ref={setupUserInput} placeholder="Admin username" autoComplete="username" autoCapitalize="none"
          onChange={e=>setupUserRef.current=e.target.value}
          style={{padding:'12px 14px',borderRadius:10,border:'1px solid #ddd',fontSize:15,background:'#fff'}}/>
        <input ref={setupPassInput} placeholder="Password" type="password" autoComplete="new-password"
          onChange={e=>setupPassRef.current=e.target.value}
          onKeyDown={e=>e.key==='Enter'&&doSetupAdmin()}
          style={{padding:'12px 14px',borderRadius:10,border:'1px solid #ddd',fontSize:15,background:'#fff'}}/>
        <button onClick={doSetupAdmin} style={{padding:14,borderRadius:12,background:'#111',color:'#fff',border:'none',fontSize:15,fontWeight:600,cursor:'pointer'}}>Create Admin Account</button>
      </div>
    </div>
  )

  /* ── Login ── */
  if (view==='login') {
    const bioUserId = Object.keys(users).find(uid=>hasBiometric(uid))
    const bioUser   = bioUserId ? users[bioUserId] : null
    return (
      <div style={{minHeight:'100dvh',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',background:'#F7F7F6',fontFamily:'system-ui',padding:24}}>
        <div style={{fontSize:40,marginBottom:8}}>⏱</div>
        <div style={{fontSize:24,fontWeight:700,marginBottom:4}}>TimeTrack</div>
        <div style={{fontSize:14,color:'#666',marginBottom:32}}>Sign in to continue</div>
        <div style={{width:'100%',maxWidth:320,display:'flex',flexDirection:'column',gap:12}}>
          <input ref={loginUserInput} placeholder="Username" autoComplete="username" autoCapitalize="none"
            onChange={e=>loginUserRef.current=e.target.value}
            onKeyDown={e=>e.key==='Enter'&&loginPassInput.current?.focus()}
            style={{padding:'12px 14px',borderRadius:10,border:'1px solid #ddd',fontSize:15,background:'#fff'}}/>
          <input ref={loginPassInput} placeholder="Password" type="password" autoComplete="current-password"
            onChange={e=>loginPassRef.current=e.target.value}
            onKeyDown={e=>e.key==='Enter'&&doLogin()}
            style={{padding:'12px 14px',borderRadius:10,border:'1px solid #ddd',fontSize:15,background:'#fff'}}/>
          {loginError && <div style={{fontSize:13,color:'#C0392B',textAlign:'center'}}>{loginError}</div>}
          <button onClick={doLogin} disabled={loginLoading}
            style={{padding:14,borderRadius:12,background:'#111',color:'#fff',border:'none',fontSize:15,fontWeight:600,cursor:'pointer',opacity:loginLoading?0.6:1}}>
            {loginLoading?'Signing in…':'Sign In'}
          </button>
          {bioUser && (
            <button onClick={()=>doBiometricLogin(bioUserId)} disabled={loginLoading}
              style={{padding:14,borderRadius:12,background:'#fff',color:'#111',border:'1px solid #ddd',fontSize:15,fontWeight:500,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:8}}>
              <span style={{fontSize:20}}>🔐</span> Use Face ID as {bioUser.username}
            </button>
          )}
        </div>
      </div>
    )
  }

  const NAV_ADMIN    = [{id:'home',icon:'ti-home',label:'Home'},{id:'reports',icon:'ti-chart-bar',label:'Reports'},{id:'employees',icon:'ti-users',label:'Employees'},{id:'settings',icon:'ti-settings',label:'Settings'}]
  const NAV_EMPLOYEE = [{id:'home',icon:'ti-clock',label:'My Time'},{id:'settings',icon:'ti-settings',label:'Settings'}]
  const NAV_ITEMS    = isAdmin ? NAV_ADMIN : NAV_EMPLOYEE

  return (
    <div style={{minHeight:'100dvh',display:'flex',flexDirection:'column',background:'#F7F7F6'}}>
      {toast && <div className="toast-wrap"><div className="toast">{toast}</div></div>}

      <main className="page">

        {/* ── ADMIN HOME ── */}
        {view==='home' && isAdmin && (
          <>
            <div className="page-header">
              <div><div className="app-title">TimeTrack</div><div className="page-heading">{new Date().toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'})}</div></div>
              <div className="clock-time">{new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div>
            </div>
            <div style={{padding:'12px 16px',display:'flex',flexDirection:'column',gap:8}}>
              {employees.length===0 ? (
                <div className="empty"><i className="ti ti-users" aria-hidden="true"/>No employees yet.<br/>Add them in the Employees tab.</div>
              ) : employees.map(emp=>{
                const st=getStatus(emp.id),rec=getTodayRec(emp.id),w=calcWorked(rec),sc=STATUS_CONFIG[st]
                return (
                  <div key={emp.id} className="card emp-row" onClick={()=>{setSelEmpId(emp.id);setView('employee')}}>
                    <div className="avatar" style={{background:emp.color}}>{initials(emp.name)}</div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontWeight:600,fontSize:15,marginBottom:3}}>{emp.name}</div>
                      <div style={{display:'flex',alignItems:'center',gap:6}}>
                        <span className="pill" style={{background:sc.bg,color:sc.color}}>{sc.label}</span>
                        {w>0&&<span style={{fontSize:12,color:'var(--muted)'}}>{msToHM(w)}</span>}
                      </div>
                    </div>
                    <div style={{textAlign:'right',fontSize:11,color:'var(--muted)',lineHeight:1.7}}>
                      {rec?.clockIn&&<div>In: {fmt(rec.clockIn)}</div>}
                      {rec?.clockOut&&<div>Out: {fmt(rec.clockOut)}</div>}
                    </div>
                    <i className="ti ti-chevron-right" style={{color:'var(--muted)',fontSize:16}} aria-hidden="true"/>
                  </div>
                )
              })}
            </div>
          </>
        )}

        {/* ── EMPLOYEE HOME ── */}
        {view==='home' && !isAdmin && myEmp && (()=>{
          const st=getStatus(myEmp.id),rec=getTodayRec(myEmp.id),w=calcWorked(rec),ln=calcLunch(rec),sc=STATUS_CONFIG[st]
          const wRecs=records.filter(r=>r.empId===myEmp.id&&wd.includes(r.date))
          const wTotal=wRecs.reduce((s,r)=>s+calcWorked(r),0)
          return (
            <>
              <div className="page-header">
                <div><div className="app-title">TimeTrack</div><div className="page-heading">{new Date().toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'})}</div></div>
                <div className="avatar" style={{background:myEmp.color,width:32,height:32,fontSize:11}}>{initials(myEmp.name)}</div>
              </div>
              <div style={{padding:16}}>
                <div style={{marginBottom:18}}>
                  <div style={{fontSize:22,fontWeight:700,marginBottom:4}}>{myEmp.name}</div>
                  <span className="pill" style={{background:sc.bg,color:sc.color}}>{sc.label}</span>
                </div>
                <div className="metrics">
                  <div className="metric"><div className="metric-label">Today</div><div className="metric-value">{msToHM(w)}</div></div>
                  <div className="metric"><div className="metric-label">This week</div><div className="metric-value">{msToHM(wTotal)}</div></div>
                </div>
                {rec&&(
                  <div className="card" style={{marginBottom:18}}>
                    <div className="label">Today's record</div>
                    <div className="time-row"><span className="t-label">Clock in</span><span className="t-val">{fmt(rec.clockIn)}</span></div>
                    {(rec.lunches||[]).map((lb,i)=>(
                      <div key={i}>
                        <div className="time-row"><span className="t-label">Lunch {(rec.lunches||[]).length>1?i+1:''} start</span><span className="t-val">{fmt(lb.start)}</span></div>
                        <div className="time-row"><span className="t-label">Lunch {(rec.lunches||[]).length>1?i+1:''} end</span><span className="t-val">{lb.end?fmt(lb.end):'ongoing'}</span></div>
                      </div>
                    ))}
                    <div className="time-row"><span className="t-label">Clock out</span><span className="t-val">{fmt(rec.clockOut)}</span></div>
                    {ln>0&&<div className="time-row"><span className="t-label">Total lunch</span><span className="t-val">{msToHM(ln)}</span></div>}
                  </div>
                )}
                <div style={{display:'flex',flexDirection:'column',gap:10,marginBottom:24}}>
                  {st==='out'&&<button className="btn btn-green" onClick={()=>doClockIn(myEmp.id)}><i className="ti ti-clock" aria-hidden="true"/> Clock In</button>}
                  {st==='in'&&(<><button className="btn btn-amber" onClick={()=>doLunchStart(myEmp.id)}><i className="ti ti-soup" aria-hidden="true"/> Start Lunch</button><button className="btn" onClick={()=>doClockOut(myEmp.id)}><i className="ti ti-clock-off" aria-hidden="true"/> Clock Out</button></>)}
                  {st==='lunch'&&(<><button className="btn btn-amber" onClick={()=>doLunchEnd(myEmp.id)}><i className="ti ti-soup" aria-hidden="true"/> End Lunch</button><button className="btn" onClick={()=>doClockOut(myEmp.id)}><i className="ti ti-clock-off" aria-hidden="true"/> Clock Out</button></>)}
                  {st==='done'&&<div style={{textAlign:'center',padding:'16px 0',color:'var(--muted)',fontSize:13}}><i className="ti ti-circle-check" style={{color:'#27AE60',fontSize:22,display:'block',marginBottom:6}} aria-hidden="true"/>Done for today — clocked out at {fmt(rec?.clockOut)}</div>}
                </div>
                <div className="label">This week</div>
                <div style={{display:'flex',flexDirection:'column',gap:4}}>
                  {wd.slice(0,5).map(date=>{
                    const r=wRecs.find(x=>x.date===date),dw=calcWorked(r),isToday=date===getToday()
                    return <div key={date} className={`week-row ${isToday?'today':dw>0?'worked':''}`}><span className="wday">{fmtDate(date)}</span><span className="whrs">{dw>0?msToHM(dw):'—'}</span></div>
                  })}
                </div>
              </div>
            </>
          )
        })()}

        {/* ── ADMIN: EMPLOYEE DETAIL ── */}
        {view==='employee' && isAdmin && selEmp && (()=>{
          const emp=selEmp,st=getStatus(emp.id),rec=getTodayRec(emp.id),w=calcWorked(rec),ln=calcLunch(rec),sc=STATUS_CONFIG[st]
          const wRecs=records.filter(r=>r.empId===emp.id&&wd.includes(r.date)),wTotal=wRecs.reduce((s,r)=>s+calcWorked(r),0)
          return (
            <>
              <div className="page-header">
                <div><button className="back-btn" onClick={()=>setView('home')}><i className="ti ti-arrow-left" aria-hidden="true"/> Back</button><div className="page-heading">{emp.name}</div></div>
                <span className="pill" style={{background:sc.bg,color:sc.color}}>{sc.label}</span>
              </div>
              <div style={{padding:16}}>
                <div className="metrics">
                  <div className="metric"><div className="metric-label">Today</div><div className="metric-value">{msToHM(w)}</div></div>
                  <div className="metric"><div className="metric-label">This week</div><div className="metric-value">{msToHM(wTotal)}</div></div>
                </div>
                {rec&&(
                  <div className="card" style={{marginBottom:18}}>
                    <div className="label">Today's record</div>
                    <div className="time-row"><span className="t-label">Clock in</span><span className="t-val">{fmt(rec.clockIn)}</span></div>
                    {(rec.lunches||[]).map((lb,i)=>(
                      <div key={i}>
                        <div className="time-row"><span className="t-label">Lunch {(rec.lunches||[]).length>1?i+1:''} start</span><span className="t-val">{fmt(lb.start)}</span></div>
                        <div className="time-row"><span className="t-label">Lunch {(rec.lunches||[]).length>1?i+1:''} end</span><span className="t-val">{lb.end?fmt(lb.end):'ongoing'}</span></div>
                      </div>
                    ))}
                    <div className="time-row"><span className="t-label">Clock out</span><span className="t-val">{fmt(rec.clockOut)}</span></div>
                    {ln>0&&<div className="time-row"><span className="t-label">Total lunch</span><span className="t-val">{msToHM(ln)}</span></div>}
                  </div>
                )}
                <div className="label">This week</div>
                <div style={{display:'flex',flexDirection:'column',gap:4}}>
                  {wd.slice(0,5).map(date=>{
                    const r=wRecs.find(x=>x.date===date),dw=calcWorked(r),isToday=date===getToday()
                    return <div key={date} className={`week-row ${isToday?'today':dw>0?'worked':''}`}><span className="wday">{fmtDate(date)}</span><span className="whrs">{dw>0?msToHM(dw):'—'}</span></div>
                  })}
                </div>
              </div>
            </>
          )
        })()}

        {/* ── ADMIN: EMPLOYEES TAB ── */}
        {view==='employees' && isAdmin && (
          <>
            <div className="page-header"><div><div className="app-title">TimeTrack</div><div className="page-heading">Employees</div></div></div>
            <div style={{padding:16}}>
              <div className="label">Add employee</div>
              <div style={{display:'flex',flexDirection:'column',gap:8,marginBottom:24}}>
                <input ref={newNameInput} placeholder="Full name" autoComplete="off"
                  onChange={e=>newNameRef.current=e.target.value}
                  style={{padding:'10px 13px',borderRadius:8,border:'0.5px solid var(--border-strong)',background:'#fff',color:'#111',fontSize:15}}/>
                <input ref={newUserInput} placeholder="Username (for login)" autoComplete="off" autoCapitalize="none"
                  onChange={e=>newUserRef.current=e.target.value}
                  style={{padding:'10px 13px',borderRadius:8,border:'0.5px solid var(--border-strong)',background:'#fff',color:'#111',fontSize:15}}/>
                <input ref={newPassInput} placeholder="Temporary password" type="password"
                  onChange={e=>newPassRef.current=e.target.value}
                  style={{padding:'10px 13px',borderRadius:8,border:'0.5px solid var(--border-strong)',background:'#fff',color:'#111',fontSize:15}}/>
                <button onClick={addEmployee} style={{padding:11,borderRadius:10,background:'#111',color:'#fff',border:'none',fontSize:14,fontWeight:600,cursor:'pointer'}}>Add Employee</button>
              </div>
              <div className="label">Team ({employees.length})</div>
              {employees.length===0 ? (
                <div className="empty" style={{padding:'20px 0'}}><i className="ti ti-users" aria-hidden="true"/> No employees yet.</div>
              ) : (
                <div style={{display:'flex',flexDirection:'column',gap:8}}>
                  {employees.map(emp=>{
                    const sc=STATUS_CONFIG[getStatus(emp.id)]
                    const empUser=Object.values(users).find(u=>u.empId===emp.id)
                    return (
                      <div key={emp.id} className="card" style={{display:'flex',alignItems:'center',gap:10}}>
                        <div className="avatar" style={{background:emp.color,width:36,height:36,fontSize:12}}>{initials(emp.name)}</div>
                        <div style={{flex:1}}>
                          <div style={{fontWeight:600,fontSize:14}}>{emp.name}</div>
                          <div style={{fontSize:11,color:'var(--muted)'}}>@{empUser?.username||'—'}</div>
                          <span className="pill" style={{background:sc.bg,color:sc.color}}>{sc.label}</span>
                        </div>
                        <button onClick={()=>removeEmployee(emp.id)} style={{background:'none',border:'none',cursor:'pointer',color:'var(--muted)',fontSize:20,lineHeight:1,padding:4}}>
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

        {/* ── REPORTS (admin only) ── */}
        {view==='reports' && isAdmin && (
          <>
            <div className="page-header">
              <div><div className="app-title">TimeTrack</div><div className="page-heading">Weekly Report</div></div>
              <div className="clock-time" style={{fontSize:12}}>{fmtDate(wd[0])} – {fmtDate(wd[4])}</div>
            </div>
            <div style={{padding:16}}>
              {employees.length===0 ? <div className="empty"><i className="ti ti-chart-bar" aria-hidden="true"/>No employees yet.</div> : (
                <div style={{display:'flex',flexDirection:'column',gap:10,marginBottom:24}}>
                  {employees.map(emp=>{
                    const recs=records.filter(r=>r.empId===emp.id&&wd.includes(r.date))
                    const total=recs.reduce((s,r)=>s+calcWorked(r),0),days=recs.filter(r=>r.clockIn).length
                    return (
                      <div key={emp.id} className="card report-card">
                        <div className="report-header">
                          <div className="avatar" style={{background:emp.color,width:34,height:34,fontSize:11}}>{initials(emp.name)}</div>
                          <div style={{flex:1}}><div className="report-name">{emp.name}</div><div className="report-sub">{days} day{days!==1?'s':''} this week</div></div>
                          <div className="report-total">{msToHM(total)}</div>
                        </div>
                        <div className="week-bars">
                          {wd.slice(0,5).map(date=>{const r=recs.find(x=>x.date===date),w=calcWorked(r);return(<div key={date} className="week-bar-col"><div className="week-bar-day">{new Date(date+'T12:00:00').toLocaleDateString([],{weekday:'narrow'})}</div><div className="week-bar-track" style={{background:w>0?emp.color:'#E0E0E0'}}/></div>)})}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
              <div style={{display:'flex',flexDirection:'column',gap:10}}>
                <button className="btn" onClick={downloadAllPDFs} disabled={employees.length===0}><i className="ti ti-file-download" aria-hidden="true"/> Download All PDFs</button>
                <button className="btn btn-primary" onClick={sendEmailReport} disabled={employees.length===0}><i className="ti ti-mail" aria-hidden="true"/>{settings.email?`Send to ${settings.email}`:'Send Email Report'}</button>
              </div>
              {!settings.email&&<p style={{textAlign:'center',fontSize:12,color:'var(--muted)',marginTop:8}}>Set a report email in Settings</p>}
            </div>
          </>
        )}

        {/* ── SETTINGS ── */}
        {view==='settings' && (
          <>
            <div className="page-header"><div><div className="app-title">TimeTrack</div><div className="page-heading">Settings</div></div></div>
            <div style={{padding:16}}>
              <div style={{display:'flex',alignItems:'center',gap:10,padding:'12px 14px',background:'#fff',borderRadius:14,border:'0.5px solid var(--border)',marginBottom:20}}>
                <div className="avatar" style={{background:isAdmin?'#111':myEmp?.color||'#999',width:40,height:40,fontSize:13}}>{isAdmin?'A':initials(currentUser?.username||'?')}</div>
                <div><div style={{fontWeight:600,fontSize:15}}>{currentUser?.username}</div><div style={{fontSize:12,color:'var(--muted)'}}>{isAdmin?'Administrator':'Employee'}</div></div>
              </div>

              {canUseBiometric()&&(
                <div style={{marginBottom:24}}>
                  <div className="label">Biometric Login</div>
                  {hasBiometric(currentUser?.userId) ? (
                    <div style={{fontSize:13,color:'#27AE60',padding:'10px 0'}}>✓ Face ID / fingerprint enabled on this device</div>
                  ) : (
                    <button className="btn" onClick={async()=>{const ok=await registerBiometric(currentUser.userId,currentUser.username);showToast(ok?'Face ID enabled!':'Could not enable Face ID')}}>
                      <span style={{fontSize:16}}>🔐</span> Enable Face ID / Fingerprint
                    </button>
                  )}
                </div>
              )}

              {isAdmin&&(
                <>
                  <div className="label">Report email address</div>
                  <input className="text-input" type="email" value={settEmail} onChange={e=>setSettEmail(e.target.value)} placeholder="reports@yourcompany.com" style={{marginBottom:10}}/>
                  <button className="btn btn-primary" onClick={()=>{saveSettings({...settings,email:settEmail});showToast('Email saved!')}} style={{marginBottom:24}}>
                    <i className="ti ti-check" aria-hidden="true"/> Save Email
                  </button>
                  <div className="label">Data management</div>
                  <button className="btn btn-danger" onClick={()=>{if(confirm('Clear all time records?')){saveRecords([]);showToast('Records cleared')}}} style={{marginBottom:16}}>
                    <i className="ti ti-trash" aria-hidden="true"/> Clear All Time Records
                  </button>
                </>
              )}

              <div className="label">Account</div>
              <button className="btn" onClick={logout}><i className="ti ti-logout" aria-hidden="true"/> Sign Out</button>
              <p style={{fontSize:11,color:'var(--muted)',marginTop:24,textAlign:'center'}}>TimeTrack v2.0</p>
            </div>
          </>
        )}

      </main>

      {view!=='employee'&&(
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
