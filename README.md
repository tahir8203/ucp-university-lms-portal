# University LMS (Vanilla JS + Firebase Spark)

Fully working LMS using:
- HTML
- CSS
- Vanilla JavaScript (ES modules)
- Firebase Authentication (Admin/Teacher)
- Firestore
- Firebase Storage

No backend server and no frameworks.

## Project Structure

```text
.
|-- index.html
|-- admin.html
|-- teacher.html
|-- student.html
|-- certificate.html
|-- file.html
|-- css/
|   `-- styles.css
|-- js/
|   |-- firebase.js
|   |-- auth.js
|   |-- constants.js
|   |-- utils.js
|   |-- index.js
|   |-- admin.js
|   |-- teacher.js
|   |-- student.js
|   |-- certificate.js
|   |-- fileStore.js
|   `-- file-viewer.js
|-- firestore.rules
|-- storage.rules
`-- README.md
```

## Firebase Setup

1. Create Firebase project resources (Auth, Firestore, Storage, Hosting).
2. Enable Authentication method: `Email/Password`.
3. Deploy rules:
   - Firestore: use `firestore.rules`
   - Storage: use `storage.rules`
4. Host the app (Firebase Hosting recommended).  
   Do not run from `file://`; use hosting URL.

## Seed Data (Required)

Create admin/teacher auth users in Firebase Authentication first.

Then create corresponding Firestore documents:

Collection: `users/{uid}`

```json
{
  "role": "admin",
  "name": "Main Admin",
  "email": "admin@university.edu"
}
```

```json
{
  "role": "teacher",
  "name": "Teacher One",
  "email": "teacher@university.edu"
}
```

Students are created by CSV upload in teacher dashboard.

## CSV Enrollment Format

Header must include roll and name fields. Example:

```csv
rollNo,name
FA24-001,Ali Khan
FA24-002,Sara Ahmed
```

Supported roll header names: `rollNo`, `roll_no`, `roll`, `roll number`.

## Authentication and Role Flow

- Admin/Teacher:
  - Login on `index.html` using Firebase Email/Password
  - Role loaded from `users/{uid}`
  - New teachers can submit request from login screen; admin approves from admin panel
  - Redirect:
    - `admin` -> `admin.html`
    - `teacher` -> `teacher.html`
- Student:
  - Login with `Roll No + Name` (no Firebase Auth)
  - Matched in `students` collection
  - Session stored in `sessionStorage`
  - Redirect to `student.html`

## Firestore Schema

### `users/{uid}`
- role: `"admin" | "teacher"`
- name, email

### `students/{studentId}`
- rollNo, name, nameLower

### `classes/{classId}`
- teacherId, teacherName, name, semester, createdAt

### `enrollments/{classId_studentId}`
- classId, teacherId, studentId, rollNo, studentName, createdAt

### `lectures/{lectureId}`
- teacherId, classId, title, date, videoLink
- files: array of `{name, url?, path?, fileId?, type, size}`

### `quizzes/{quizId}`
- teacherId, classId, quizNumber (1-4), title, durationMin
- status: `draft | published`
- questions: `[{text, options[4], correctIndex}]` (`correctIndex` uses 1-4)

### `quizAttempts/{quizId_studentKey}`
- quizId, classId, teacherId
- studentKey, studentName, studentRollNo
- answers[], score, total, submittedAt

### `quizAnalytics/{quizId}`
- quizId, classId, teacherId
- attempts, totalScore, totalQuestions
- questionStats: `[{correct, total}]`

### `assignments/{assignmentId}`
- teacherId, classId, assignmentNumber (1-4), title, deadline, createdAt

### `assignmentSubmissions/{assignmentId_studentKey}`
- assignmentId, classId, teacherId
- studentKey, studentName, studentRollNo
- fileName, fileUrl?, filePath?, fileId?
- status, submittedAt
- optional review fields: grade, feedback, reviewedAt

### `filePayloads/{fileId}`
- fileId, name, type, size, chunkCount, context, createdAt
- subcollection `chunks/{chunkId}`: `{idx, data}` (Data URL chunks)

### `discussionThreads/{threadId}`
- classId, title, body
- createdByRole, createdByName
- optional teacherId/studentKey
- isAnnouncement, createdAt

### `discussionReplies/{replyId}`
- threadId, classId, body
- createdByRole, createdByName
- optional studentKey
- createdAt

### `evaluations/{classId_studentKey}`
- classId, teacherId
- anonymous
- studentKey/studentName (null when anonymous)
- questionScores map
- submittedAt

### `evaluationStats/{classId}`
- classId, teacherId
- count
- questionTotals map
- updatedAt

### `studentProgress/{classId_studentKey}`
- classId, studentKey, studentName
- points, quizCount, assignmentCount
- badges[]
- updatedAt

### `certificates/{classId_studentKey}`
- classId, className
- studentKey, studentName, studentRollNo
- issuedAt

## Module Coverage

- Admin panel:
  - View teachers, classes, lectures, summaries, evaluation data (read-only)
- Teacher:
  - Create classes and semester
  - CSV enrollment
  - Lectures CRUD + file uploads + video link
  - Quizzes draft autosave/resume, publish, archive, manual start/stop, attempt limits
  - Quiz questions support MCQ + theory, per-question image compression, formatting/code/LaTeX tags, CSV bulk import
  - Assignments 1-4 + review submissions
  - Evaluation aggregated view
  - Forum announcements
- Student:
  - Login roll+name
  - View lectures
  - Attempt published quizzes with timer + forward/back + auto-grade + result view
  - Upload assignments (<=10MB)
  - Forum thread/reply with pagination (20 per page)
  - Teacher evaluation (anonymous or named, once per class)
  - Certificate generation/check
  - Gamification points and badges

## Spark Plan Notes

- No Cloud Functions.
- No realtime listeners (`onSnapshot`) are used.
- Data is fetched using one-time `getDocs/getDoc`.
- Quiz analytics are precomputed at submission time and saved directly.
- If Storage upload is blocked (for example rules not deployed), uploads automatically fall back to chunked Firestore file storage and are downloaded via `file.html`.
