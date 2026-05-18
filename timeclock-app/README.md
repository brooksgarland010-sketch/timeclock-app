# TimeTrack ⏱

Employee clock-in / clock-out app with lunch break tracking and weekly PDF reports.

## Features

- Clock in & out for each employee
- Lunch break tracking
- Live "this week" totals per employee
- Download individual PDFs at end of week
- Email weekly summary to any address

---

## Deploy in 5 minutes (GitHub + Vercel)

### Step 1 — Put this on GitHub

1. Go to [github.com](https://github.com) → **New repository**
2. Name it `timeclock-app`, keep it **Public** (or Private — Vercel works with both)
3. Don't add a README (you already have one)
4. Click **Create repository**
5. Follow GitHub's instructions to push this folder:

```bash
# Inside this folder:
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/timeclock-app.git
git push -u origin main
```

---

### Step 2 — Deploy on Vercel

1. Go to [vercel.com](https://vercel.com) → **Sign up / Log in** (use GitHub)
2. Click **Add New → Project**
3. Find and **Import** your `timeclock-app` repo
4. Vercel auto-detects Vite — just click **Deploy**
5. Done! You'll get a URL like `https://timeclock-app-yourname.vercel.app`

Every time you push to GitHub, Vercel auto-redeploys.

---

### Step 3 — Share with employees

Send everyone your Vercel URL. On their phone:

- **iPhone**: Open in Safari → Share → **Add to Home Screen**
- **Android**: Open in Chrome → menu → **Add to Home Screen**

It installs like an app icon, works offline, and keeps data on their own device.

---

## Local development

```bash
npm install
npm run dev
```

Open http://localhost:5173

## Build for production

```bash
npm run build
```

---

## Notes

- Data is stored in each device's browser (localStorage)
- Employees use it on their own phones — each person's times stay on their device
- The admin device should be used for Reports + sending the weekly email
- "Send Email" opens your mail app pre-filled with everyone's hours
- "Download PDFs" saves one PDF per employee to attach to that email
