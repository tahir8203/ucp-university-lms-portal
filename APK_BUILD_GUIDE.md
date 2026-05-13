# Build University LMS APK

This project is now prepared for an Android APK using Capacitor.

## Requirements

- Node.js LTS
- Android Studio
- Android SDK installed through Android Studio
- Java JDK, usually included with Android Studio

## First-Time Setup

Open a terminal in this folder:

```bash
npm install
npm run cap:add:android
npm run cap:sync
npm run cap:open
```

Android Studio will open the Android project.

## Build Debug APK

In Android Studio:

1. Wait for Gradle sync to finish.
2. Click **Build**.
3. Click **Build Bundle(s) / APK(s)**.
4. Click **Build APK(s)**.

The debug APK will be generated inside:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

## Install on Phone

1. Copy `app-debug.apk` to your Android phone.
2. Open it on the phone.
3. Allow install from unknown sources if Android asks.
4. Install and open **University LMS**.

## Firebase Notes

This APK uses the same Firebase web app config from `js/firebase.js`.

If Firebase Auth shows an unauthorized domain error inside the APK, add these to Firebase Authentication authorized domains:

```text
localhost
quiz-lms-d8f96.firebaseapp.com
quiz-lms-d8f96.web.app
```

For a release APK, use Android Studio's **Generate Signed Bundle / APK** option and create a signing key.
