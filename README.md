# Oreos — Proctored IDE for Education

A monitored coding environment where lecturers control the environment and can replay every student's coding session keystroke by keystroke.

## What makes it different from HackerRank

- **Live monitoring** — lecturers see every student's code update in real-time
- **Session replay** — scrub through a student's full coding process, not just the final result
- **Granular flags** — paste attempts, tab switches, window blur, idle time, devtools attempts
- **Lecturer controls** — start/end sessions, toggle paste/tab constraints live mid-session
- **Self-hosted** — your institution owns all the data

## Running locally

### Prerequisites
- Node.js 18+
- npm

### Start the server
```bash
cd server && npm install && node src/index.js
```

### Start the client
```bash
cd client && npm install && npm run dev
```

Then open http://localhost:5173

## How it works

1. **Lecturer** registers, creates a session, shares the 6-char join code
2. **Students** register and join using the code
3. Lecturer starts the session — students can now code in the locked-down IDE
4. Every keystroke, cursor move, paste, tab switch is logged and streamed live
5. Lecturer watches live code per student, sees flags in real-time
6. After the session, lecturer can replay any student's session frame by frame

## Architecture

```
client/          React + TypeScript + Vite
  pages/
    lecturer/    LecturerHome, LecturerSession (live dashboard), LecturerReplay
    student/     StudentLobby (join), StudentIDE (proctored editor)

server/
  src/
    db/          SQLite via better-sqlite3
    routes/      REST: auth + sessions
    sockets/     Socket.io: real-time events, flags, live code streaming
```

## Monitoring features (Student IDE)

| Feature | What it does |
|---|---|
| Keystroke logging | Every editor change logged with timestamp |
| Cursor tracking | Line/column position logged |
| Paste detection | Blocked or flagged per session constraints |
| Tab switch detection | `visibilitychange` event — flags + warns student |
| Window blur | `blur` event flagged |
| Idle tracking | Flags after 30s of no activity |
| Right-click blocked | `contextmenu` prevented |
| DevTools shortcut blocked | F12, Ctrl+Shift+I/J/C intercepted |
| Heartbeat | Every 15s keeps connection alive + reports idle time |
