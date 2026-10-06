// ================================================================
// firebase-boot.js
// Drop-in Firebase sync layer for the existing localStorage app.
// - On page load: downloads all data from Firestore into localStorage
// - On every localStorage write: pushes to Firestore (background)
// - Existing code NEVER changes — it just sees localStorage
// ================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  getDocs,
  setDoc,
  deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// ================================================================
// 1. Firebase config
// ================================================================
const firebaseConfig = {
  apiKey: "AIzaSyCbLaMMyURD7j6l84qnbDi9Eaol9oABiVE",
  authDomain: "student-permissions-web.firebaseapp.com",
  projectId: "student-permissions-web",
  storageBucket: "student-permissions-web.firebasestorage.app",
  messagingSenderId: "717967595505",
  appId: "1:717967595505:web:2c3cc66527b23a6b5c1650"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// ================================================================
// 2. localStorage keys we sync
// ================================================================
const SYNCED_KEYS = [
  'cps_students',
  'cps_teachers',
  'cps_hods',
  'cps_security',
  'cps_permissions',
  'cps_gateLog',
  'cps_auditLog'
];

// Map localStorage key -> Firestore collection name (same name)
function keyToCollection(key) {
  return key.replace('cps_', '');
}

// ================================================================
// 3. Bootstrap: pull from Firestore into localStorage
// ================================================================
async function bootstrapFromFirestore() {
  console.log('%c🔥 Firebase boot: loading data...', 'color:#f59e0b;font-weight:bold;');

  for (const key of SYNCED_KEYS) {
    try {
      const colName = keyToCollection(key);
      const snap = await getDocs(collection(db, colName));
      const rows = snap.docs.map(d => {
        // Keep local shape: store the whole doc as-is, but include `id`
        return { id: d.id, ...d.data() };
      });
      // Only overwrite localStorage if Firestore actually has data
      // (prevents wiping fresh local data on first ever run)
      if (rows.length > 0) {
        localStorage.setItem(key, JSON.stringify(rows));
      } else if (!localStorage.getItem(key)) {
        localStorage.setItem(key, '[]');
      }
      console.log(`  ✓ ${key}: ${rows.length} records`);
    } catch (err) {
      console.warn(`  ⚠️ ${key} load failed:`, err.message);
    }
  }

  // Signal to the page that boot finished
  window.CPS_BOOT_DONE = true;
  window.dispatchEvent(new Event('cps-boot-ready'));
  console.log('%c✅ Firebase boot: ready', 'color:#10b981;font-weight:bold;');
}

// ================================================================
// 4. Push to Firestore (background, non-blocking)
// ================================================================
async function pushToFirestore(key, value) {
  try {
    const colName = keyToCollection(key);
    const rows = JSON.parse(value || '[]');

    // Snapshot current Firestore docs to know what to delete
    const snap = await getDocs(collection(db, colName));
    const existingIds = snap.docs.map(d => d.id);
    const newIds = new Set();

    // Upsert each row
    for (const row of rows) {
      let docId = row.id;
      if (!docId) {
        // Generate a stable ID from a unique field
        docId = makeDocId(row);
        row.id = docId;
      }
      newIds.add(docId);

      // Strip our local `id` field before saving (Firestore uses its own)
      const { id, ...dataToSave } = row;
      await setDoc(doc(db, colName, docId), dataToSave, { merge: true });
    }

    // Delete docs that no longer exist locally
    for (const id of existingIds) {
      if (!newIds.has(id)) {
        await deleteDoc(doc(db, colName, id));
      }
    }
  } catch (err) {
    console.warn('Firestore push failed for', key, err.message);
  }
}

// Generate a deterministic doc ID from a row's unique fields
function makeDocId(row) {
  // Prefer unique business IDs
  if (row.permissionId) return row.permissionId;
  if (row.regNo) return row.regNo;
  if (row.teacherId) return row.teacherId;
  if (row.hodId) return row.hodId;
  if (row.securityId) return row.securityId;
  // Fallback: hash of relevant fields
  return 'doc_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ================================================================
// 5. Hook localStorage.setItem so writes auto-push to Firestore
// ================================================================
const originalSetItem = localStorage.setItem.bind(localStorage);

localStorage.setItem = function(key, value) {
  originalSetItem(key, value);
  if (SYNCED_KEYS.includes(key)) {
    // Fire and forget — do NOT await (would block UI)
    pushToFirestore(key, value).catch(() => {});
  }
};

// Also handle removeItem
const originalRemoveItem = localStorage.removeItem.bind(localStorage);
localStorage.removeItem = function(key) {
  originalRemoveItem(key);
  if (SYNCED_KEYS.includes(key)) {
    // Clear the Firestore collection too
    pushToFirestore(key, '[]').catch(() => {});
  }
};

// ================================================================
// 6. Boot sequence
// ================================================================
onAuthStateChanged(auth, async (user) => {
  if (user) {
    await bootstrapFromFirestore();
  }
});

signInAnonymously(auth).catch(err => {
  console.error('Anonymous auth failed:', err);
  // Still mark boot as done so the app can run offline
  window.CPS_BOOT_DONE = true;
  window.dispatchEvent(new Event('cps-boot-ready'));
});

// Expose for debugging
window.CPS_FIREBASE = { db, auth };