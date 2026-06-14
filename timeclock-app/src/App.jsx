import { useState, useEffect, useRef } from 'react'
import jsPDF from 'jspdf'

const DB = import.meta.env.VITE_FIREBASE_URL
const fbGet = async (path) => { try { const r = await fetch(`${DB}/${path}.json`); return await r.json() } catch { return null } }
const fbSet = async (path, data) => { try { await fetch(`${DB}/${path}.json`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) }) } catch {} }

const hashPassword = async (pw) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw))
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('')
}
const canUseBiometric = () => window.PublicKeyCredential !== undefined && navigator.credentials !== undefined
const registerBiometric = async (userId, username) => {
  try {
    const challenge = crypto.getRandomValues(new Uint8Array(32))
    const cred = await navigator.credentials.create({ publicKey: { challenge, rp:{ name:'TimeTrack', id:window.location.hostname }, user:{ id:new TextEncoder().encode(userId), name:username, displayName:username }, pubKeyCredParams:[{alg:-7,type:'public-key'},{alg:-257,type:'public-key'}], authenticatorSelection:{authenticatorAttachment:'platform',userVerification:'required'}, timeout:60000, attestation:'none' } })
    localStorage.setItem(`tc_bio_${userId}`, btoa(String.fromCharCode(...new Uint8Array(cred.rawId))))
    return true
  } catch { return false }
}
const verifyBiometric = async (userId) => {
  try {
    const str = localStorage.getItem(`tc_bio_${userId}`)
    if (!str) return false
    const credId = Uint8Array.from(atob(str), c=>c.charCodeAt(0))
    const challenge = crypto.getRandomValues(new Uint8Array(32))
    await navigator.credentials.get({ publicKey:{ challenge, rpId:window.location.hostname, allowCredentials:[{type:'public-key',id:credId}], userVerification:'required', timeout:60000 } })
    return true
  } catch { return false }
}
const hasBiometric = (userId) => !!localStorage.getItem(`tc_bio_${userId}`)

const COLORS = ['#C0392B','#2980B9','#27AE60','#D4850A','#7D3C98','#148F77','#BA4A00','#1A5276']
const STATUS_CONFIG = {
  out:   { label:'Not started', bg:'#F5F5F5', color:'#666' },
  in:    { label:'Clocked in',  bg:'#E8F5E9', color:'#1B5E20' },
  lunch: { label:'On lunch',    bg:'#FFF3E0', color:'#E65100' },
  done:  { label:'Clocked out', bg:'#F5F5F5', color:'#666' },
}

const fmt      = ts => ts ? new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : '--:--'
const fmtDate  = d  => new Date(d+'T12:00:00').toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'})
const msToHM   = ms => { if(!ms||ms<=0) return '0h 00m'; return `${Math.floor(ms/3600000)}h ${String(Math.floor((ms%3600000)/60000)).padStart(2,'0')}m` }
const initials = n  => n.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2)
const dateStr   = d  => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
const getToday  = () => dateStr(new Date())

const getWeekDatesForOffset = (offset=0) => {
  const now=new Date(), day=now.getDay(), back=(day+2)%7
  const fri=new Date(now); fri.setDate(now.getDate()-back-(offset*7))
  return [0,3,4,5,6].map(o=>{ const d=new Date(fri); d.setDate(fri.getDate()+o); return dateStr(d) })
}
const getWeekDates = () => getWeekDatesForOffset(0)

const calcLunch = r => {
  if (!r?.lunches?.length) return 0
  return r.lunches.reduce((s,lb)=>s+Math.max(0,(lb.end??Date.now())-lb.start),0)
}
const calcWorked = r => {
  if (!r?.clockIn) return 0
  return Math.max(0,(r.clockOut??Date.now())-r.clockIn-calcLunch(r))
}
const onLunch = r => r?.lunches?.length>0 && !r.lunches[r.lunches.length-1].end

const tsToTimeStr = ts => { if(!ts) return ''; const d=new Date(ts); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}` }
const timeStrToTs = (s,dateStr) => { if(!s) return null; const [h,m]=s.split(':').map(Number),d=new Date(dateStr+'T00:00:00'); d.setHours(h,m,0,0); return d.getTime() }

export default function App() {
  const [currentUser, setCurrentUser] = useState(null)
  const [users,       setUsers]       = useState({})
  const [employees,   setEmployees]   = useState([])
  const [records,     setRecords]     = useState([])
  const [settings,    setSettings]    = useState({email:''})
  const [view,        setView]        = useState('loading')
  const [selEmpId,    setSelEmpId]    = useState(null)
  const [toast,       setToast]       = useState('')
  const [,            setTick]        = useState(0)
  const [loginError,  setLoginError]  = useState('')
  const [loginLoad,   setLoginLoad]   = useState(false)
  const [offerBio,    setOfferBio]    = useState(false)
  const [pendingBio,  setPendingBio]  = useState(null)
  const [settEmail,   setSettEmail]   = useState('')
  const [historyOffset, setHistoryOffset] = useState(0)
  const [editDate,    setEditDate]    = useState(null)
  const [editEmpId,   setEditEmpId]   = useState(null)
  const [editIn,      setEditIn]      = useState('')
  const [editOut,     setEditOut]     = useState('')
  const [editLunches, setEditLunches] = useState([])

  const loginUserRef=useRef(''); const loginUserInput=useRef(null)
  const loginPassRef=useRef(''); const loginPassInput=useRef(null)
  const setupUserRef=useRef(''); const setupUserInput=useRef(null)
  const setupPassRef=useRef(''); const setupPassInput=useRef(null)
  const newNameRef=useRef('');   const newNameInput=useRef(null)
  const newUserRef=useRef('');   const newUserInput=useRef(null)
  const newPassRef=useRef('');   const newPassInput=useRef(null)

  const loadAll = async () => {
    const [usrs,emps,recs,sett] = await Promise.all([fbGet('users'),fbGet('employees'),fbGet('records'),fbGet('settings')])
    if(usrs&&typeof usrs==='object') setUsers(usrs)
    if(Array.isArray(emps)) setEmployees(emps)
    if(Array.isArray(recs)) setRecords(recs)
    if(sett?.email!==undefined){ setSettings(sett); setSettEmail(sett.email||'') }
  }

  useEffect(()=>{
    const init=async()=>{
      const saved=localStorage.getItem('tc_session')
      if(saved){ const u=JSON.parse(saved); setCurrentUser(u); await loadAll(); setView('home') }
      else { const usrs=await fbGet('users'); if(usrs&&typeof usrs==='object'&&Object.keys(usrs).length>0){setUsers(usrs);setView('login')} else setView('setup') }
    }
    init()
    const onVis=()=>{ if(document.visibilityState==='visible') loadAll() }
    document.addEventListener('visibilitychange',onVis)
    const t=setInterval(()=>setTick(x=>x+1),30000)
    return()=>{ document.removeEventListener('visibilitychange',onVis); clearInterval(t) }
  },[])

  const showToast = msg => { setToast(msg); setTimeout(()=>setToast(''),3000) }
  const saveEmployees = async e => { setEmployees(e); await fbSet('employees',e) }
  const saveRecords   = async r => { setRecords(r);   await fbSet('records',r) }
  const saveSettings  = async s => { setSettings(s);  await fbSet('settings',s) }
  const saveUsers     = async u => { setUsers(u);     await fbSet('users',u) }

  const doLogin = async () => {
    const username=loginUserRef.current.trim(), password=loginPassRef.current
    if(!username||!password){ setLoginError('Please enter username and password'); return }
    setLoginLoad(true); setLoginError('')
    try {
      const hash=await hashPassword(password)
      const match=Object.entries(users).find(([,u])=>u.username.toLowerCase()===username.toLowerCase()&&u.passwordHash===hash)
      if(!match){ setLoginError('Invalid username or password'); setLoginLoad(false); return }
      const [userId,userData]=match
      const session={userId,username:userData.username,role:userData.role,empId:userData.empId??null}
      localStorage.setItem('tc_session',JSON.stringify(session)); setCurrentUser(session)
      await loadAll()
      if(canUseBiometric()&&!hasBiometric(userId)){ setPendingBio({userId,username:userData.username}); setOfferBio(true) } else setView('home')
    } catch { setLoginError('Login failed') }
    setLoginLoad(false)
  }

  const doBioLogin = async (userId) => {
    setLoginLoad(true); setLoginError('')
    if(await verifyBiometric(userId)){
      const ud=users[userId]
      const session={userId,username:ud.username,role:ud.role,empId:ud.empId??null}
      localStorage.setItem('tc_session',JSON.stringify(session)); setCurrentUser(session)
      await loadAll(); setView('home')
    } else setLoginError('Biometric failed')
    setLoginLoad(false)
  }

  const doSetupAdmin = async () => {
    const username=setupUserRef.current.trim(), password=setupPassRef.current.trim()
    if(!username||!password) return
    const hash=await hashPassword(password), userId=`user_${Date.now()}`
    const nu={[userId]:{username,passwordHash:hash,role:'admin',empId:null}}
    await saveUsers(nu)
    const session={userId,username,role:'admin',empId:null}
    localStorage.setItem('tc_session',JSON.stringify(session)); setCurrentUser(session); setView('home')
  }

  const logout = () => {
    setCurrentUser(null); localStorage.removeItem('tc_session'); setLoginError('')
    if(loginUserInput.current) loginUserInput.current.value=''
    if(loginPassInput.current) loginPassInput.current.value=''
    setView(Object.keys(users).length>0?'login':'setup')
  }

  const enableBiometric = async () => {
    if(!pendingBio) return
    const ok=await registerBiometric(pendingBio.userId,pendingBio.username)
    setOfferBio(false); setPendingBio(null); showToast(ok?'Face ID enabled!':'Could not enable Face ID'); setView('home')
  }

  const getTodayRec = empId => records.find(r=>r.empId===empId&&r.date===getToday())
  const getStatus   = empId => { const r=getTodayRec(empId); if(!r?.clockIn) return 'out'; if(r.clockOut) return 'done'; if(onLunch(r)) return 'lunch'; return 'in' }

  const doClockIn    = async empId => { if(getTodayRec(empId)) return; await saveRecords([...records,{id:`${empId}-${Date.now()}`,empId,date:getToday(),clockIn:Date.now(),clockOut:null,lunches:[]}]) }
  const doClockOut   = async empId => { await saveRecords(records.map(r=>{ if(r.empId!==empId||r.date!==getToday()) return r; const lunches=onLunch(r)?r.lunches.map((lb,i)=>i===r.lunches.length-1&&!lb.end?{...lb,end:Date.now()}:lb):(r.lunches||[]); return {...r,clockOut:Date.now(),lunches} })) }
  const doLunchStart = async empId => { await saveRecords(records.map(r=>r.empId===empId&&r.date===getToday()?{...r,lunches:[...(r.lunches||[]),{start:Date.now(),end:null}]}:r)) }
  const doLunchEnd   = async empId => { await saveRecords(records.map(r=>{ if(r.empId!==empId||r.date!==getToday()) return r; const lunches=(r.lunches||[]).map((lb,i)=>i===r.lunches.length-1&&!lb.end?{...lb,end:Date.now()}:lb); return {...r,lunches} })) }

  const openEdit = (empId, date) => {
    const rec=records.find(r=>r.empId===empId&&r.date===date)
    setEditEmpId(empId); setEditDate(date)
    setEditIn(rec?tsToTimeStr(rec.clockIn):'')
    setEditOut(rec?tsToTimeStr(rec.clockOut):'')
    setEditLunches(rec?.lunches?.map(lb=>({start:tsToTimeStr(lb.start),end:tsToTimeStr(lb.end??null)}))||[])
    setView('edit')
  }

  const saveEdit = async () => {
    const clockInTs=timeStrToTs(editIn,editDate), clockOutTs=timeStrToTs(editOut,editDate)
    if(!clockInTs){ showToast('Clock in time is required'); return }
    const lunches=editLunches.filter(lb=>lb.start).map(lb=>({start:timeStrToTs(lb.start,editDate),end:lb.end?timeStrToTs(lb.end,editDate):null}))
    const existing=records.find(r=>r.empId===editEmpId&&r.date===editDate)
    const updated=existing
      ? records.map(r=>r.empId===editEmpId&&r.date===editDate?{...r,clockIn:clockInTs,clockOut:clockOutTs,lunches}:r)
      : [...records,{id:`${editEmpId}-manual-${Date.now()}`,empId:editEmpId,date:editDate,clockIn:clockInTs,clockOut:clockOutTs,lunches}]
    await saveRecords(updated); showToast('Times saved!')
    setView(isAdmin?'employee':'home')
  }

  const clearMyWeek = async () => {
    if(!confirm('Clear all your time records for this week?')) return
    const wd=getWeekDates()
    await saveRecords(records.filter(r=>!(r.empId===currentUser?.empId&&wd.includes(r.date))))
    showToast('Your week records cleared')
  }

  const addEmployee = async () => {
    const name=newNameRef.current.trim(), username=newUserRef.current.trim(), password=newPassRef.current.trim()
    if(!name||!username||!password){ showToast('Please fill in all fields'); return }
    if(Object.values(users).some(u=>u.username.toLowerCase()===username.toLowerCase())){ showToast('Username already taken'); return }
    const hash=await hashPassword(password), empId=Date.now(), userId=`user_${Date.now()+1}`
    await saveEmployees([...employees,{id:empId,name,color:COLORS[employees.length%COLORS.length]}])
    await saveUsers({...users,[userId]:{username,passwordHash:hash,role:'employee',empId}})
    newNameRef.current=''; newUserRef.current=''; newPassRef.current=''
    if(newNameInput.current) newNameInput.current.value=''
    if(newUserInput.current) newUserInput.current.value=''
    if(newPassInput.current) newPassInput.current.value=''
    showToast(`${name} added!`)
  }

  const removeEmployee = async id => {
    if(!confirm('Remove this employee and their login?')) return
    await saveEmployees(employees.filter(e=>e.id!==id))
    const updated={...users}; Object.entries(updated).forEach(([uid,u])=>{ if(u.empId===id) delete updated[uid] }); await saveUsers(updated)
  }

  const generatePDF = (emp, weekOffset=0) => {
    const wd=getWeekDatesForOffset(weekOffset)
    const recs=records.filter(r=>r.empId===emp.id&&wd.includes(r.date))
    const doc=new jsPDF({unit:'mm',format:'letter'})
    const PW=215.9,PH=279.4,M=14
    doc.setFillColor(245,238,220); doc.rect(0,0,PW,PH,'F')
    doc.setDrawColor(120,75,55); doc.setLineWidth(1.2); doc.rect(7,7,PW-14,PH-14)
    doc.setLineWidth(0.4); doc.rect(10,10,PW-20,PH-20)
    doc.setTextColor(80,35,20); doc.setFontSize(12); doc.setFont(undefined,'normal'); doc.text('Name:',M+2,26)
    doc.setFont(undefined,'bold'); doc.setFontSize(11); doc.text(emp.name,M+18,26)
    doc.setLineWidth(0.4); doc.line(M+18,27.5,M+18+doc.getTextWidth(emp.name),27.5)
    doc.setFontSize(22); doc.setFont(undefined,'bold'); doc.text('TIME SHEET',PW-M-2,26,{align:'right'})
    doc.setLineWidth(0.6); doc.line(PW-M-2-doc.getTextWidth('TIME SHEET'),27.8,PW-M-2,27.8)
    const weekEndStr=new Date(wd[4]+'T12:00:00').toLocaleDateString([],{month:'long',day:'numeric',year:'numeric'})
    doc.setFontSize(10); doc.setFont(undefined,'normal'); doc.text('Week Ending:',M+2,38)
    doc.setFont(undefined,'bold'); doc.text(weekEndStr,M+28,38)
    const TT=54,RH=12,TL=M+2,TR=PW-M-2,TW=TR-TL
    const C={day:TL,date:TL+38,start:TL+65,end:TL+100,lunch:TL+135,total:TL+162}
    doc.setFont(undefined,'bold'); doc.setFontSize(8.5); doc.setTextColor(80,35,20)
    doc.text('DATE',C.day+1,TT-9); doc.text('DATE',C.date+1,TT-9)
    doc.text('START TIME',C.start+1,TT-9); doc.text('END TIME',C.end+1,TT-9)
    doc.text('LUNCH',C.lunch+1,TT-13); doc.text('BREAK',C.lunch+1,TT-7); doc.text('TOTAL HOURS',C.total+1,TT-9)
    doc.setDrawColor(120,75,55); doc.setLineWidth(0.45)
    doc.line(TL,TT-15,TR,TT-15); doc.line(TL,TT,TR,TT)
    for(let i=1;i<=6;i++) doc.line(TL,TT+i*RH,TR,TT+i*RH)
    ;[C.day,C.date,C.start,C.end,C.lunch,C.total,TR].forEach(x=>doc.line(x,TT-15,x,TT+6*RH))
    const DAY_NAMES=['Friday','Monday','Tuesday','Wednesday','Thursday']
    let totalWorked=0,totalLunch=0
    wd.forEach((date,i)=>{
      const r=recs.find(x=>x.date===date),worked=calcWorked(r),lunch=calcLunch(r)
      totalWorked+=worked; totalLunch+=lunch
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
    const totY=TT+5*RH
    doc.setFont(undefined,'bold'); doc.setFontSize(9); doc.setTextColor(80,35,20)
    doc.text('WEEKLY TOTALS',C.day+1,totY+RH-3.5); doc.text('--',C.date+1,totY+RH-3.5); doc.text('--',C.start+1,totY+RH-3.5); doc.text('--',C.end+1,totY+RH-3.5)
    doc.setFontSize(10); doc.setFont(undefined,'bold'); doc.setTextColor(30,20,15)
    if(totalLunch>0)  doc.text(msToHM(totalLunch), C.lunch+1,totY+RH-3.5)
    if(totalWorked>0) doc.text(msToHM(totalWorked),C.total+1,totY+RH-3.5)
    const sigTop=TT+6*RH+14,sigH=22
    doc.setDrawColor(120,75,55); doc.setLineWidth(0.4)
    doc.rect(TL,sigTop,TW,sigH); doc.setFont(undefined,'italic'); doc.setFontSize(10); doc.setTextColor(80,35,20)
    doc.text('Employee signature:',TL+3,sigTop+7)
    doc.setLineWidth(0.3); doc.line(TL+45,sigTop+16,TL+TW-4,sigTop+16)
    doc.setFontSize(15); doc.setFont(undefined,'italic'); doc.setTextColor(30,30,120); doc.text(emp.name,TL+48,sigTop+15)
    doc.rect(TL,sigTop+sigH+5,TW,sigH); doc.setFontSize(10); doc.setFont(undefined,'italic'); doc.setTextColor(80,35,20)
    doc.text('Supervisor signature:',TL+3,sigTop+sigH+12)
    doc.line(TL+47,sigTop+sigH+21,TL+TW-4,sigTop+sigH+21)
    return doc
  }

  const downloadAllPDFs = (weekOffset=0) => {
    const wd=getWeekDatesForOffset(weekOffset)
    const list=isAdmin?employees:employees.filter(e=>e.id===currentUser?.empId)
    list.forEach(emp=>generatePDF(emp,weekOffset).save(`${emp.name.replace(/\s+/g,'-')}-timesheet-${wd[4]}.pdf`))
    showToast(`Downloaded ${list.length} PDF${list.length!==1?'s':''}`)
  }

  const sendEmailReport = async () => {
    if(!settings.email){ showToast('Set a report email in Settings first'); return }
    const wd=getWeekDates()
    const list=isAdmin?employees:employees.filter(e=>e.id===currentUser?.empId)
    const files=list.map(emp=>{ const blob=new Blob([generatePDF(emp).output('arraybuffer')],{type:'application/pdf'}); return new File([blob],`${emp.name.replace(/\s+/g,'-')}-timesheet-${wd[4]}.pdf`,{type:'application/pdf'}) })
    if(navigator.canShare&&navigator.canShare({files})){ try{ await navigator.share({files,title:`Weekly Time Sheets — week ending ${fmtDate(wd[4])}`}); return }catch(e){ if(e.name!=='AbortError') console.error(e); return } }
    downloadAllPDFs(); showToast('PDFs downloaded — attach to email!')
  }

  const selEmp=employees.find(e=>e.id===selEmpId)??null
  const myEmp =employees.find(e=>e.id===currentUser?.empId)??null
  const wd    =getWeekDates()
  const isAdmin=currentUser?.role==='admin'

  const inputStyle={padding:'12px 14px',borderRadius:10,border:'1px solid var(--border-mid)',background:'var(--card)',color:'var(--text)',fontSize:15,width:'100%',fontFamily:'inherit',boxSizing:'border-box',outline:'none',boxShadow:'var(--shadow-sm)'}

  if(!DB) return <div style={{padding:24}}><h2>Firebase not configured</h2></div>
  if(view==='loading') return (
    <div style={{display:'flex',alignItems:'center',justifyContent:'center',minHeight:'100dvh',color:'var(--muted)'}}>
      <div style={{textAlign:'center'}}>
        <i className="ti ti-clock" style={{fontSize:32,display:'block',marginBottom:10,color:'var(--muted-light)'}} aria-hidden="true"/>
        <span style={{fontSize:14,fontWeight:500}}>Loading…</span>
      </div>
    </div>
  )

  if(offerBio) return (
    <div style={{minHeight:'100dvh',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',background:'var(--bg)',padding:32}}>
      <div style={{width:64,height:64,borderRadius:20,background:'var(--surface)',border:'1px solid var(--border)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:28,marginBottom:20}}>🔐</div>
      <div style={{fontSize:21,fontWeight:700,letterSpacing:'-0.02em',marginBottom:8}}>Enable Face ID?</div>
      <div style={{fontSize:14,color:'var(--muted)',textAlign:'center',marginBottom:36,lineHeight:1.6,maxWidth:300}}>Log in faster next time using Face ID or fingerprint instead of your password.</div>
      <div style={{width:'100%',maxWidth:320,display:'flex',flexDirection:'column',gap:10}}>
        <button onClick={enableBiometric} className="btn btn-primary">Enable Face ID</button>
        <button onClick={()=>{setOfferBio(false);setPendingBio(null);setView('home')}} className="btn" style={{border:'none',background:'transparent',boxShadow:'none',color:'var(--muted)'}}>Not now</button>
      </div>
    </div>
  )

  if(view==='setup') return (
    <div style={{minHeight:'100dvh',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',background:'var(--bg)',padding:32}}>
      <div style={{width:56,height:56,borderRadius:16,background:'var(--text)',display:'flex',alignItems:'center',justifyContent:'center',marginBottom:20}}>
        <i className="ti ti-clock" style={{color:'#fff',fontSize:26}} aria-hidden="true"/>
      </div>
      <div style={{fontSize:24,fontWeight:800,letterSpacing:'-0.03em',marginBottom:6}}>TimeTrack</div>
      <div style={{fontSize:14,color:'var(--muted)',marginBottom:36,textAlign:'center'}}>Create your admin account to get started</div>
      <div style={{width:'100%',maxWidth:320,display:'flex',flexDirection:'column',gap:10}}>
        <input ref={setupUserInput} placeholder="Admin username" autoComplete="username" autoCapitalize="none" onChange={e=>setupUserRef.current=e.target.value} style={inputStyle}/>
        <input ref={setupPassInput} placeholder="Password" type="password" autoComplete="new-password" onChange={e=>setupPassRef.current=e.target.value} onKeyDown={e=>e.key==='Enter'&&doSetupAdmin()} style={inputStyle}/>
        <button onClick={doSetupAdmin} className="btn btn-primary" style={{marginTop:4}}>Create Admin Account</button>
      </div>
    </div>
  )

  if(view==='login') {
    const bioUserId=Object.keys(users).find(uid=>hasBiometric(uid))
    const bioUser=bioUserId?users[bioUserId]:null
    return (
      <div style={{minHeight:'100dvh',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',background:'var(--bg)',padding:32}}>
        <div style={{width:56,height:56,borderRadius:16,background:'var(--text)',display:'flex',alignItems:'center',justifyContent:'center',marginBottom:20}}>
          <i className="ti ti-clock" style={{color:'#fff',fontSize:26}} aria-hidden="true"/>
        </div>
        <div style={{fontSize:24,fontWeight:800,letterSpacing:'-0.03em',marginBottom:6}}>TimeTrack</div>
        <div style={{fontSize:14,color:'var(--muted)',marginBottom:36}}>Sign in to continue</div>
        <div style={{width:'100%',maxWidth:320,display:'flex',flexDirection:'column',gap:10}}>
          <input ref={loginUserInput} placeholder="Username" autoComplete="username" autoCapitalize="none" onChange={e=>loginUserRef.current=e.target.value} onKeyDown={e=>e.key==='Enter'&&loginPassInput.current?.focus()} style={inputStyle}/>
          <input ref={loginPassInput} placeholder="Password" type="password" autoComplete="current-password" onChange={e=>loginPassRef.current=e.target.value} onKeyDown={e=>e.key==='Enter'&&doLogin()} style={inputStyle}/>
          {loginError&&<div style={{fontSize:13,color:'var(--red)',textAlign:'center',fontWeight:500}}>{loginError}</div>}
          <button onClick={doLogin} disabled={loginLoad} className="btn btn-primary" style={{marginTop:4}}>{loginLoad?'Signing in…':'Sign In'}</button>
          {bioUser&&<button onClick={()=>doBioLogin(bioUserId)} disabled={loginLoad} className="btn" style={{gap:10}}><span style={{fontSize:18}}>🔐</span>Face ID as {bioUser.username}</button>}
        </div>
      </div>
    )
  }

  const NAV_ADMIN   =[{id:'home',icon:'ti-home',label:'Home'},{id:'reports',icon:'ti-chart-bar',label:'Reports'},{id:'history',icon:'ti-clock-record',label:'History'},{id:'employees',icon:'ti-users',label:'Employees'},{id:'settings',icon:'ti-settings',label:'Settings'}]
  const NAV_EMPLOYEE=[{id:'home',icon:'ti-clock',label:'My Time'},{id:'settings',icon:'ti-settings',label:'Settings'}]
  const NAV_ITEMS   =isAdmin?NAV_ADMIN:NAV_EMPLOYEE

  const WeekRow = ({date, empId}) => {
    const r=records.find(x=>x.empId===empId&&x.date===date)
    const dw=calcWorked(r), isToday=date===getToday()
    return (
      <div className={`week-row ${isToday?'today':dw>0?'worked':''}`} style={{display:'flex',alignItems:'center'}}>
        <span className="wday" style={{flex:1}}>{fmtDate(date)}</span>
        <span className="whrs" style={{marginRight:8}}>{dw>0?msToHM(dw):'—'}</span>
        <button onClick={()=>openEdit(empId,date)} style={{background:'none',border:'none',cursor:'pointer',color:'var(--muted-light)',fontSize:15,padding:'2px 4px',lineHeight:1}}>
          <i className="ti ti-pencil" aria-hidden="true"/>
        </button>
      </div>
    )
  }

  return (
    <div style={{minHeight:'100dvh',display:'flex',flexDirection:'column',background:'var(--bg)'}}>
      {toast&&<div className="toast-wrap"><div className="toast">{toast}</div></div>}
      <main className="page">

        {/* HOME - ADMIN */}
        {view==='home'&&isAdmin&&(
          <>
            <div className="page-header">
              <div>
                <div className="app-title">TimeTrack</div>
                <div className="page-heading">{new Date().toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'})}</div>
              </div>
              <div className="clock-time">{new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div>
            </div>
            <div style={{padding:'14px 18px',display:'flex',flexDirection:'column',gap:10}}>
              {employees.length===0
                ? <div className="empty"><i className="ti ti-users" aria-hidden="true"/>No employees yet.<br/>Add them in the Employees tab.</div>
                : employees.map(emp=>{
                  const st=getStatus(emp.id),rec=getTodayRec(emp.id),w=calcWorked(rec),sc=STATUS_CONFIG[st]
                  return(
                    <div key={emp.id} className="card emp-row" onClick={()=>{setSelEmpId(emp.id);setView('employee')}}>
                      <div className="avatar" style={{background:emp.color}}>{initials(emp.name)}</div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontWeight:700,fontSize:15,letterSpacing:'-0.01em',marginBottom:4}}>{emp.name}</div>
                        <div style={{display:'flex',alignItems:'center',gap:6}}>
                          <span className="pill" style={{background:sc.bg,color:sc.color}}>{sc.label}</span>
                          {w>0&&<span style={{fontSize:12,color:'var(--muted)',fontVariantNumeric:'tabular-nums'}}>{msToHM(w)}</span>}
                        </div>
                      </div>
                      <div style={{textAlign:'right',fontSize:11,color:'var(--muted)',lineHeight:1.8,fontVariantNumeric:'tabular-nums'}}>
                        {rec?.clockIn&&<div>In {fmt(rec.clockIn)}</div>}
                        {rec?.clockOut&&<div>Out {fmt(rec.clockOut)}</div>}
                      </div>
                      <i className="ti ti-chevron-right" style={{color:'var(--muted-light)',fontSize:16}} aria-hidden="true"/>
                    </div>
                  )
                })
              }
            </div>
          </>
        )}

        {/* HOME - EMPLOYEE */}
        {view==='home'&&!isAdmin&&myEmp&&(()=>{
          const st=getStatus(myEmp.id),rec=getTodayRec(myEmp.id),w=calcWorked(rec),ln=calcLunch(rec),sc=STATUS_CONFIG[st]
          const wRecs=records.filter(r=>r.empId===myEmp.id&&wd.includes(r.date)),wTotal=wRecs.reduce((s,r)=>s+calcWorked(r),0)
          return(
            <>
              <div className="page-header">
                <div>
                  <div className="app-title">TimeTrack</div>
                  <div className="page-heading">{new Date().toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'})}</div>
                </div>
                <div className="avatar" style={{background:myEmp.color,width:34,height:34,fontSize:11}}>{initials(myEmp.name)}</div>
              </div>

              {/* Status hero */}
              <div className="status-hero">
                <div className="status-hero-name">{myEmp.name}</div>
                <span className="pill" style={{background:sc.bg,color:sc.color,marginBottom:16,display:'inline-flex'}}>{sc.label}</span>
                <div className="metrics" style={{marginTop:12}}>
                  <div className="metric"><div className="metric-label">Today</div><div className="metric-value">{msToHM(w)}</div></div>
                  <div className="metric"><div className="metric-label">This week</div><div className="metric-value">{msToHM(wTotal)}</div></div>
                </div>
              </div>

              <div style={{padding:'18px 18px 0'}}>
                {/* Action buttons */}
                <div className="action-area">
                  {st==='out'   && <button className="btn btn-green" onClick={()=>doClockIn(myEmp.id)}><i className="ti ti-clock" aria-hidden="true"/> Clock In</button>}
                  {st==='in'    && <>
                    <button className="btn btn-amber" onClick={()=>doLunchStart(myEmp.id)}><i className="ti ti-soup" aria-hidden="true"/> Start Lunch</button>
                    <button className="btn" onClick={()=>doClockOut(myEmp.id)}><i className="ti ti-clock-off" aria-hidden="true"/> Clock Out</button>
                  </>}
                  {st==='lunch' && <>
                    <button className="btn btn-amber" onClick={()=>doLunchEnd(myEmp.id)}><i className="ti ti-soup" aria-hidden="true"/> End Lunch</button>
                    <button className="btn" onClick={()=>doClockOut(myEmp.id)}><i className="ti ti-clock-off" aria-hidden="true"/> Clock Out</button>
                  </>}
                  {st==='done'  && (
                    <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:10,padding:'16px 0',color:'var(--green)',fontSize:14,fontWeight:600}}>
                      <i className="ti ti-circle-check" style={{fontSize:22}} aria-hidden="true"/>
                      Done for today · out at {fmt(rec?.clockOut)}
                    </div>
                  )}
                </div>

                {/* Today's record card */}
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
                  {wd.map(date=><WeekRow key={date} date={date} empId={myEmp.id}/>)}
                </div>
              </div>
            </>
          )
        })()}

        {/* EMPLOYEE DETAIL - ADMIN */}
        {view==='employee'&&isAdmin&&selEmp&&(()=>{
          const emp=selEmp,st=getStatus(emp.id),rec=getTodayRec(emp.id),w=calcWorked(rec),ln=calcLunch(rec),sc=STATUS_CONFIG[st]
          const wRecs=records.filter(r=>r.empId===emp.id&&wd.includes(r.date)),wTotal=wRecs.reduce((s,r)=>s+calcWorked(r),0)
          return(
            <>
              <div className="page-header">
                <div>
                  <button className="back-btn" onClick={()=>setView('home')}><i className="ti ti-arrow-left" aria-hidden="true"/> Back</button>
                  <div className="page-heading">{emp.name}</div>
                </div>
                <span className="pill" style={{background:sc.bg,color:sc.color}}>{sc.label}</span>
              </div>
              <div style={{padding:'18px 18px 0'}}>
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
                  {wd.map(date=><WeekRow key={date} date={date} empId={emp.id}/>)}
                </div>
              </div>
            </>
          )
        })()}

        {/* EDIT DAY */}
        {view==='edit'&&editDate&&(()=>{
          const emp=employees.find(e=>e.id===editEmpId)
          const dateLabel=new Date(editDate+'T12:00:00').toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'})
          return(
            <>
              <div className="page-header">
                <div>
                  <button className="back-btn" onClick={()=>setView(isAdmin?'employee':'home')}><i className="ti ti-arrow-left" aria-hidden="true"/> Back</button>
                  <div className="page-heading">Edit Times</div>
                </div>
              </div>
              <div style={{padding:'18px 18px 0'}}>
                <div style={{fontSize:13.5,color:'var(--muted)',marginBottom:20,fontWeight:500}}>{emp?.name} · {dateLabel}</div>
                <div className="label">Clock In</div>
                <input type="time" value={editIn} onChange={e=>setEditIn(e.target.value)} style={{...inputStyle,marginBottom:18}}/>
                <div className="label">Clock Out</div>
                <input type="time" value={editOut} onChange={e=>setEditOut(e.target.value)} style={{...inputStyle,marginBottom:18}}/>
                <div className="label">Lunch Breaks</div>
                {editLunches.map((lb,i)=>(
                  <div key={i} className="card" style={{marginBottom:10}}>
                    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
                      <span style={{fontSize:13,fontWeight:700}}>Lunch {editLunches.length>1?i+1:''}</span>
                      <button onClick={()=>setEditLunches(editLunches.filter((_,j)=>j!==i))} style={{background:'none',border:'none',cursor:'pointer',color:'var(--muted)',fontSize:18,padding:0}}><i className="ti ti-trash" aria-hidden="true"/></button>
                    </div>
                    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                      <div><div style={{fontSize:10,color:'var(--muted)',marginBottom:5,fontWeight:700,letterSpacing:'.08em',textTransform:'uppercase'}}>START</div><input type="time" value={lb.start||''} onChange={e=>{const l=[...editLunches];l[i]={...l[i],start:e.target.value};setEditLunches(l)}} style={inputStyle}/></div>
                      <div><div style={{fontSize:10,color:'var(--muted)',marginBottom:5,fontWeight:700,letterSpacing:'.08em',textTransform:'uppercase'}}>END</div><input type="time" value={lb.end||''} onChange={e=>{const l=[...editLunches];l[i]={...l[i],end:e.target.value};setEditLunches(l)}} style={inputStyle}/></div>
                    </div>
                  </div>
                ))}
                <button className="btn" onClick={()=>setEditLunches([...editLunches,{start:'',end:''}])} style={{marginBottom:26}}><i className="ti ti-plus" aria-hidden="true"/> Add Lunch Break</button>
                <button className="btn btn-primary" onClick={saveEdit} style={{marginBottom:10}}><i className="ti ti-check" aria-hidden="true"/> Save Changes</button>
                <button className="btn btn-danger" onClick={async()=>{ if(!confirm('Clear times for this day?')) return; await saveRecords(records.filter(r=>!(r.empId===editEmpId&&r.date===editDate))); showToast('Day cleared'); setView(isAdmin?'employee':'home') }}><i className="ti ti-trash" aria-hidden="true"/> Clear This Day</button>
              </div>
            </>
          )
        })()}

        {/* REPORTS - ADMIN */}
        {view==='reports'&&isAdmin&&(
          <>
            <div className="page-header">
              <div><div className="app-title">TimeTrack</div><div className="page-heading">Weekly Report</div></div>
              <div className="clock-time" style={{fontSize:11}}>{fmtDate(wd[0])} – {fmtDate(wd[4])}</div>
            </div>
            <div style={{padding:'14px 18px 0'}}>
              {employees.length===0
                ? <div className="empty"><i className="ti ti-chart-bar" aria-hidden="true"/>No employees yet.</div>
                : (
                  <div style={{display:'flex',flexDirection:'column',gap:10,marginBottom:24}}>
                    {employees.map(emp=>{
                      const recs=records.filter(r=>r.empId===emp.id&&wd.includes(r.date))
                      const total=recs.reduce((s,r)=>s+calcWorked(r),0),days=recs.filter(r=>r.clockIn).length
                      return(
                        <div key={emp.id} className="card report-card">
                          <div className="report-header">
                            <div className="avatar" style={{background:emp.color,width:36,height:36,fontSize:12}}>{initials(emp.name)}</div>
                            <div style={{flex:1}}>
                              <div className="report-name">{emp.name}</div>
                              <div className="report-sub">{days} day{days!==1?'s':''} this week</div>
                            </div>
                            <div className="report-total">{msToHM(total)}</div>
                          </div>
                          <div className="week-bars">
                            {wd.map(date=>{ const r=recs.find(x=>x.date===date),w=calcWorked(r); return(<div key={date} className="week-bar-col"><div className="week-bar-day">{new Date(date+'T12:00:00').toLocaleDateString([],{weekday:'narrow'})}</div><div className="week-bar-track" style={{background:w>0?emp.color:'var(--border-mid)'}}/></div>) })}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
              }
              <div style={{display:'flex',flexDirection:'column',gap:10,paddingBottom:24}}>
                <button className="btn" onClick={()=>downloadAllPDFs(0)} disabled={employees.length===0}><i className="ti ti-file-download" aria-hidden="true"/> Download All PDFs</button>
                <button className="btn btn-primary" onClick={sendEmailReport} disabled={employees.length===0}><i className="ti ti-mail" aria-hidden="true"/>{settings.email?`Send to ${settings.email}`:'Send Email Report'}</button>
                {!settings.email&&<p style={{textAlign:'center',fontSize:12,color:'var(--muted)',marginTop:2}}>Set a report email in Settings</p>}
              </div>
            </div>
          </>
        )}

        {/* HISTORY - ADMIN */}
        {view==='history'&&isAdmin&&(()=>{
          const hwd=getWeekDatesForOffset(historyOffset)
          const hRecs=records.filter(r=>hwd.includes(r.date))
          const weekLabel=offset=>{ const d=getWeekDatesForOffset(offset); if(offset===0) return 'This week'; if(offset===1) return 'Last week'; return `${new Date(d[0]+'T12:00:00').toLocaleDateString([],{month:'short',day:'numeric'})} – ${new Date(d[4]+'T12:00:00').toLocaleDateString([],{month:'short',day:'numeric'})}` }
          return(
            <>
              <div className="page-header"><div><div className="app-title">TimeTrack</div><div className="page-heading">Time History</div></div></div>
              <div style={{overflowX:'auto',display:'flex',gap:8,padding:'12px 18px',borderBottom:'1px solid var(--border)'}}>
                {Array.from({length:12},(_,i)=>(
                  <button key={i} onClick={()=>setHistoryOffset(i)} className={`week-chip${historyOffset===i?' active':''}`}>
                    {weekLabel(i)}
                  </button>
                ))}
              </div>
              <div style={{padding:'10px 18px 2px',fontSize:12,color:'var(--muted)',fontWeight:500}}>
                Week ending {new Date(hwd[4]+'T12:00:00').toLocaleDateString([],{weekday:'long',month:'long',day:'numeric',year:'numeric'})}
              </div>
              <div style={{padding:'10px 18px',display:'flex',flexDirection:'column',gap:10}}>
                {employees.length===0
                  ? <div className="empty"><i className="ti ti-clock-record" aria-hidden="true"/>No employees yet.</div>
                  : employees.map(emp=>{
                    const empRecs=hRecs.filter(r=>r.empId===emp.id)
                    const total=empRecs.reduce((s,r)=>s+calcWorked(r),0),days=empRecs.filter(r=>r.clockIn).length
                    return(
                      <div key={emp.id} className="card" style={{padding:'14px 16px'}}>
                        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
                          <div className="avatar" style={{background:emp.color,width:38,height:38,fontSize:12}}>{initials(emp.name)}</div>
                          <div style={{flex:1}}>
                            <div style={{fontWeight:700,fontSize:14,letterSpacing:'-0.01em'}}>{emp.name}</div>
                            <div style={{fontSize:12,color:'var(--muted)',marginTop:1}}>{days} day{days!==1?'s':''} worked</div>
                          </div>
                          <div style={{fontSize:19,fontWeight:700,letterSpacing:'-0.02em'}}>{msToHM(total)}</div>
                        </div>
                        <div style={{display:'flex',flexDirection:'column',gap:1}}>
                          {hwd.map(date=>{
                            const r=empRecs.find(x=>x.date===date),w=calcWorked(r),ln=calcLunch(r)
                            return(
                              <div key={date} style={{display:'flex',alignItems:'center',fontSize:12,padding:'5px 0',borderBottom:'1px solid var(--border)'}}>
                                <span style={{color:'var(--muted)',width:84,flexShrink:0,fontWeight:500}}>{fmtDate(date)}</span>
                                {r?.clockIn?(
                                  <>
                                    <span style={{flex:1,color:'var(--text)',fontVariantNumeric:'tabular-nums'}}>{fmt(r.clockIn)} – {r.clockOut?fmt(r.clockOut):'ongoing'}</span>
                                    {ln>0&&<span style={{color:'var(--muted)',marginRight:8}}>lunch {msToHM(ln)}</span>}
                                    <span style={{fontWeight:700,minWidth:52,textAlign:'right',fontVariantNumeric:'tabular-nums'}}>{msToHM(w)}</span>
                                    <button onClick={()=>openEdit(emp.id,date)} style={{background:'none',border:'none',cursor:'pointer',color:'var(--muted-light)',fontSize:14,padding:'0 0 0 8px',lineHeight:1}}><i className="ti ti-pencil" aria-hidden="true"/></button>
                                  </>
                                ):<span style={{color:'var(--muted-light)',flex:1}}>No record</span>}
                              </div>
                            )
                          })}
                        </div>
                        {total>0&&(
                          <button onClick={()=>generatePDF(emp,historyOffset).save(`${emp.name.replace(/\s+/g,'-')}-timesheet-${hwd[4]}.pdf`)} className="btn" style={{marginTop:12,fontSize:12,padding:'8px 14px',width:'auto'}}>
                            <i className="ti ti-file-download" aria-hidden="true"/> Download PDF
                          </button>
                        )}
                      </div>
                    )
                  })
                }
                {hRecs.length>0&&<button className="btn btn-primary" onClick={()=>downloadAllPDFs(historyOffset)}><i className="ti ti-file-download" aria-hidden="true"/> Download All PDFs for This Week</button>}
              </div>
            </>
          )
        })()}

        {/* EMPLOYEES - ADMIN */}
        {view==='employees'&&isAdmin&&(
          <>
            <div className="page-header"><div><div className="app-title">TimeTrack</div><div className="page-heading">Employees</div></div></div>
            <div style={{padding:'18px 18px 0'}}>
              <div className="label">Add employee</div>
              <div style={{display:'flex',flexDirection:'column',gap:10,marginBottom:28}}>
                <input ref={newNameInput} placeholder="Full name" autoComplete="off" onChange={e=>newNameRef.current=e.target.value} style={inputStyle}/>
                <input ref={newUserInput} placeholder="Username (for login)" autoComplete="off" autoCapitalize="none" onChange={e=>newUserRef.current=e.target.value} style={inputStyle}/>
                <input ref={newPassInput} placeholder="Temporary password" type="password" onChange={e=>newPassRef.current=e.target.value} style={inputStyle}/>
                <button onClick={addEmployee} className="btn btn-primary">Add Employee</button>
              </div>
              <div className="label">Team ({employees.length})</div>
              {employees.length===0
                ? <div className="empty" style={{padding:'24px 0'}}><i className="ti ti-users" aria-hidden="true"/>No employees yet.</div>
                : (
                  <div style={{display:'flex',flexDirection:'column',gap:10}}>
                    {employees.map(emp=>{
                      const sc=STATUS_CONFIG[getStatus(emp.id)],empUser=Object.values(users).find(u=>u.empId===emp.id)
                      return(
                        <div key={emp.id} className="card" style={{display:'flex',alignItems:'center',gap:12}}>
                          <div className="avatar" style={{background:emp.color,width:38,height:38,fontSize:12}}>{initials(emp.name)}</div>
                          <div style={{flex:1}}>
                            <div style={{fontWeight:700,fontSize:14,letterSpacing:'-0.01em',marginBottom:2}}>{emp.name}</div>
                            <div style={{fontSize:11,color:'var(--muted)',marginBottom:4}}>@{empUser?.username||'—'}</div>
                            <span className="pill" style={{background:sc.bg,color:sc.color}}>{sc.label}</span>
                          </div>
                          <button onClick={()=>removeEmployee(emp.id)} style={{background:'none',border:'none',cursor:'pointer',color:'var(--muted-light)',fontSize:20,lineHeight:1,padding:6}}><i className="ti ti-trash" aria-hidden="true"/></button>
                        </div>
                      )
                    })}
                  </div>
                )
              }
            </div>
          </>
        )}

        {/* SETTINGS */}
        {view==='settings'&&(
          <>
            <div className="page-header"><div><div className="app-title">TimeTrack</div><div className="page-heading">Settings</div></div></div>
            <div style={{padding:'18px 18px 0'}}>
              {/* User profile card */}
              <div className="card" style={{display:'flex',alignItems:'center',gap:12,marginBottom:24}}>
                <div className="avatar" style={{background:isAdmin?'var(--text)':myEmp?.color||'#9CA3AF',width:44,height:44,fontSize:14}}>
                  {isAdmin?'A':initials(currentUser?.username||'?')}
                </div>
                <div>
                  <div style={{fontWeight:700,fontSize:15,letterSpacing:'-0.01em'}}>{currentUser?.username}</div>
                  <div style={{fontSize:12,color:'var(--muted)',marginTop:2}}>{isAdmin?'Administrator':'Employee'}</div>
                </div>
              </div>

              {canUseBiometric()&&(
                <div style={{marginBottom:24}}>
                  <div className="label">Biometric login</div>
                  {hasBiometric(currentUser?.userId)
                    ? <div style={{fontSize:13,color:'var(--green)',fontWeight:600,padding:'10px 0',display:'flex',alignItems:'center',gap:6}}><i className="ti ti-circle-check" aria-hidden="true"/>Face ID / fingerprint enabled</div>
                    : <button className="btn" onClick={async()=>{ const ok=await registerBiometric(currentUser.userId,currentUser.username); showToast(ok?'Face ID enabled!':'Could not enable Face ID') }}><span style={{fontSize:16}}>🔐</span>Enable Face ID / Fingerprint</button>
                  }
                </div>
              )}

              {isAdmin&&(
                <>
                  <div className="label">Report email address</div>
                  <input className="text-input" type="email" value={settEmail} onChange={e=>setSettEmail(e.target.value)} placeholder="reports@yourcompany.com" style={{marginBottom:10}}/>
                  <button className="btn btn-primary" onClick={()=>{saveSettings({...settings,email:settEmail});showToast('Email saved!')}} style={{marginBottom:26}}><i className="ti ti-check" aria-hidden="true"/> Save Email</button>
                  <div className="label">Data management</div>
                  <button className="btn btn-danger" onClick={()=>{if(confirm('Clear ALL time records?')){saveRecords([]);showToast('Records cleared')}}} style={{marginBottom:20}}><i className="ti ti-trash" aria-hidden="true"/> Clear All Time Records</button>
                </>
              )}
              {!isAdmin&&(
                <>
                  <div className="label">My Records</div>
                  <button className="btn btn-danger" onClick={clearMyWeek} style={{marginBottom:20}}><i className="ti ti-calendar-x" aria-hidden="true"/> Clear My Week Records</button>
                </>
              )}
              <div className="label">Account</div>
              <button className="btn" onClick={logout}><i className="ti ti-logout" aria-hidden="true"/> Sign Out</button>
              <p style={{fontSize:11,color:'var(--muted-light)',marginTop:28,textAlign:'center',letterSpacing:'0.02em'}}>TimeTrack v2.0</p>
            </div>
          </>
        )}

      </main>

      {view!=='employee'&&view!=='edit'&&(
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
