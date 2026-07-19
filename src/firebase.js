import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup
} from 'firebase/auth';
import { 
  getFirestore, 
  doc, 
  getDoc, 
  setDoc, 
  updateDoc, 
  increment 
} from 'firebase/firestore';

// Configuration from firebase-applet-config.json
const firebaseConfig = {
  apiKey: "AIzaSyBH1GPoKnhiieswWYH0366T6dlOui8UbcQ",
  authDomain: "gen-lang-client-0184674493.firebaseapp.com",
  projectId: "gen-lang-client-0184674493",
  storageBucket: "gen-lang-client-0184674493.firebasestorage.app",
  messagingSenderId: "578773961787",
  appId: "1:578773961787:web:7630bf002886f83136601e"
};

// Initialize Firebase App
const app = initializeApp(firebaseConfig);

// Initialize Firebase Auth
const auth = getAuth(app);

// Initialize Firestore with custom database ID from config
const db = getFirestore(app, "ai-studio-geminiwatermarkr-4ac5f535-8155-4d32-9fd9-3449bbcd051c");

export {
  app,
  auth,
  db,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  increment,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup
};
