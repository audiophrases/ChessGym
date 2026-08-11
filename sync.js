/* ============================================================
   Cloud sync — Google sign-in and one Firestore doc per user.

   app.js owns the spaced-repetition record (window.GymCloud); this file
   signs you in, hands the cloud copy over for merging, and sends up
   whatever the app wants written. It shares the Sparring Coach's project
   and the same users/{uid} document as the puzzles app, under a `gym`
   field of its own — the three are the same person on the same devices,
   and one sign-in for all of them is one less thing to do.

   The merge rules live in app.js, and they are what makes this safe to
   run on two devices at once: the newer practice wins the schedule, and
   the lifetime tallies only ever climb. Offline, the SDK queues the
   write itself.
   ============================================================ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, doc, getDoc, setDoc, onSnapshot }
  from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";

/* Public identifiers, not secrets: they say which project to talk to, and the
   Firestore rules are what keep each user inside their own document. */
const firebaseConfig = {
  apiKey: "AIzaSyABDOJOFRzDDUHSqHEaUMrwPKEnhTeP7QI",
  authDomain: "sparringcoachchessapp.firebaseapp.com",
  projectId: "sparringcoachchessapp",
  storageBucket: "sparringcoachchessapp.firebasestorage.app",
  messagingSenderId: "324354749466",
  appId: "1:324354749466:web:01f87e6620862b32cf4da3"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, { localCache: persistentLocalCache() });

const $ = id => document.getElementById(id);
/* if the app's own script never ran there is nothing to sync, but the page
   should still not throw on the way past */
const cloud = window.GymCloud || { merge() {}, setPusher() {} };

let ref = null, unsub = null;

/* merge, so this write leaves every field it does not mention alone — which
   is how a second device's practice survives it */
function push(payload) {
  if (!ref) return;
  setDoc(ref, { gym: payload }, { merge: true })
    .catch(e => console.warn("[sync] write refused: " + e.message));
}

/* This app briefly wrote its `gym` field into the shared users/{uid}
   document. It has its own document now, so that every app gets its own
   1 MiB rather than sharing one — and so that a write here stops waking
   the other apps' listeners for a change that is none of their business.

   Nothing is copied by hand. The old field is read once and handed to the
   very same merge the live listener uses, and the app's own next push
   carries it into the new home. The old document is left exactly as it is,
   which makes this reversible: it is still a complete backup. */
async function liftLegacy(uid) {
  try {
    const snap = await getDoc(doc(db, "users", uid));
    const data = snap.exists() ? snap.data() : null;
    if (data && data.gym) cloud.merge(data.gym);
  } catch (e) {
    console.warn("[sync] legacy read skipped: " + e.message);
  }
}

function paint(user) {
  const who = $("who"), btn = $("signin");
  if (who) {
    who.classList.toggle("hidden", !user);
    who.textContent = user ? (user.email || "signed in") : "";
  }
  if (btn) {
    btn.textContent = user ? "Sign out" : "Sign in";
    btn.disabled = false;
  }
}

onAuthStateChanged(auth, async user => {
  if (unsub) { unsub(); unsub = null; }
  paint(user);
  if (!user) { ref = null; cloud.setPusher(null); return; }
  ref = doc(db, "users", user.uid, "apps", "gym");
  /* before the pusher, so the one write that signing in triggers already
     carries anything lifted out of the old shared document */
  await liftLegacy(user.uid);
  cloud.setPusher(push);
  unsub = onSnapshot(ref,
    snap => { const d = snap.data(); if (d && d.gym) cloud.merge(d.gym); },
    e => console.warn("[sync] read refused: " + e.message));
});

$("signin").onclick = () => {
  if (auth.currentUser) {
    if (confirm("Sign out? Your practice record stays in the cloud and comes back when you sign in again."))
      signOut(auth);
    return;
  }
  signInWithPopup(auth, new GoogleAuthProvider()).catch(e => {
    if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request")
      alert("Sign-in failed: " + e.message);
  });
};
$("signin").disabled = false;
