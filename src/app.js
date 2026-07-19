import {
    WatermarkEngine,
    detectWatermarkConfig,
    calculateWatermarkPosition
} from './core/watermarkEngine.js';
import { WatermarkWorkerClient, canUseWatermarkWorker } from './core/workerClient.js';
import {
    isConfirmedWatermarkDecision,
    resolveDisplayWatermarkInfo
} from './core/watermarkDisplay.js';
import { canvasToBlob } from './core/canvasBlob.js';
import {
    loadImage,
    setStatusMessage,
    showLoading,
    hideLoading
} from './utils.js';
import {
    consumeDebugFileHandoff,
    getDebugFileKind,
    saveDebugFileHandoff
} from './shared/debugFileHandoff.js';
import {
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
} from './firebase.js';

// Text translations and indicators
const TEXT = {
    loading: 'Memuat modul AI...',
    size: 'Ukuran',
    watermark: 'Watermark',
    position: 'Posisi',
    status: 'Status',
    removed: 'Watermark Dihapus',
    skipped: 'Tidak ada watermark terdeteksi, gambar asli dipertahankan',
    unsupported: 'Browser tidak mendukung salin gambar langsung',
    copied: 'Berhasil Disalin!',
    copy: 'Salin Gambar',
    copyFailed: 'Gagal menyalin',
    unsupportedFile: 'Pilih file gambar yang valid (JPG, PNG, WebP) atau video MP4.',
    fileTooLarge: 'Aplikasi tidak mendukung pemrosesan gambar di atas 20MB.',
    skippedLargeImages: 'Gambar besar di atas 20MB telah dilewati.',
    handoffVideo: 'Masuk ke pengerjaan video...',
    progress: 'Proses Gambar',
    pending: 'Menunggu antrean',
    loadingImage: 'Membuka gambar...',
    processing: 'Sedang membersihkan...',
    processFailed: 'Pembersihan gagal'
};

// Application State
let enginePromise = null;
let workerClient = null;
let currentItem = null;
let imageQueue = [];
let processedCount = 0;
let activeBatchId = 0;

// Current Logged-in User State
let currentUser = null;
let userDocData = null;

// Views Mapping and Management
const views = {
  dashboard: document.getElementById('view-dashboard'),
  video: document.getElementById('view-video-cleaner'),
  image: document.getElementById('view-image-cleaner'),
  profile: document.getElementById('view-profile'),
  auth: document.getElementById('view-auth')
};

const menuButtons = {
  dashboard: document.getElementById('menu-btn-dashboard'),
  video: document.getElementById('menu-btn-video'),
  image: document.getElementById('menu-btn-image'),
  profile: document.getElementById('menu-btn-profile'),
  auth: document.getElementById('menu-btn-auth')
};

// Helper to switch view
function switchView(viewName) {
  Object.keys(views).forEach(key => {
    if (views[key]) {
      if (key === viewName) {
        views[key].classList.remove('hidden');
      } else {
        views[key].classList.add('hidden');
      }
    }
  });

  Object.keys(menuButtons).forEach(key => {
    if (menuButtons[key]) {
      if (key === viewName) {
        menuButtons[key].classList.add('bg-slate-900', 'text-brand-500');
        menuButtons[key].classList.remove('text-slate-400');
      } else {
        menuButtons[key].classList.remove('bg-slate-900', 'text-brand-500');
        menuButtons[key].classList.add('text-slate-400');
      }
    }
  });

  // Update Topbar View Title
  const viewTitle = document.getElementById('viewTitle');
  if (viewTitle) {
    const titles = {
      dashboard: 'Dashboard git44',
      video: 'Pembersih Watermark Video',
      image: 'Pembersih Watermark Gambar',
      profile: 'Profil & Lisensi Premium',
      auth: 'Autentikasi Pengguna'
    };
    viewTitle.textContent = titles[viewName] || 'git44';
  }

  // Auto-close sidebar on mobile after clicking
  const sidebar = document.getElementById('sidebar');
  if (sidebar && window.innerWidth < 768) {
    sidebar.classList.add('-translate-x-full');
  }
}

// Attach switch event to global window so HTML buttons can use it
window.switchView = switchView;

// Auth Forms tabs
const authTabLogin = document.getElementById('auth-tab-login');
const authTabRegister = document.getElementById('auth-tab-register');
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');

if (authTabLogin && authTabRegister) {
  authTabLogin.addEventListener('click', () => {
    authTabLogin.classList.add('text-brand-500', 'border-brand-500');
    authTabLogin.classList.remove('text-slate-500', 'border-transparent');
    authTabRegister.classList.remove('text-brand-500', 'border-brand-500');
    authTabRegister.classList.add('text-slate-500', 'border-transparent');
    loginForm.classList.remove('hidden');
    registerForm.classList.add('hidden');
  });

  authTabRegister.addEventListener('click', () => {
    authTabRegister.classList.add('text-brand-500', 'border-brand-500');
    authTabRegister.classList.remove('text-slate-500', 'border-transparent');
    authTabLogin.classList.remove('text-brand-500', 'border-brand-500');
    authTabLogin.classList.add('text-slate-500', 'border-transparent');
    registerForm.classList.remove('hidden');
    loginForm.classList.add('hidden');
  });
}

// Sidebar open/close handlers
const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');
const closeSidebarBtn = document.getElementById('closeSidebarBtn');
const sidebar = document.getElementById('sidebar');

if (toggleSidebarBtn && sidebar) {
  toggleSidebarBtn.addEventListener('click', () => {
    sidebar.classList.toggle('-translate-x-full');
  });
}
if (closeSidebarBtn && sidebar) {
  closeSidebarBtn.addEventListener('click', () => {
    sidebar.classList.add('-translate-x-full');
  });
}

// Original Image Watermark Remover Helpers
async function getEngine() {
    if (!enginePromise) {
        enginePromise = WatermarkEngine.create().catch((error) => {
            enginePromise = null;
            throw error;
        });
    }
    return enginePromise;
}

function getEstimatedWatermarkInfo(item) {
    if (!item?.originalImg) return null;
    const { width, height } = item.originalImg;
    const config = detectWatermarkConfig(width, height);
    const position = calculateWatermarkPosition(width, height, config);
    return {
        size: config.logoSize,
        position,
        config
    };
}

function disableWorkerClient(reason) {
    if (!workerClient) return;
    console.warn('disable worker path, fallback to main thread:', reason);
    workerClient.dispose();
    workerClient = null;
}

function cleanupCurrentItem() {
    if (!currentItem) return;
    if (currentItem.originalUrl) URL.revokeObjectURL(currentItem.originalUrl);
    if (currentItem.processedUrl) URL.revokeObjectURL(currentItem.processedUrl);
    currentItem = null;
}

function cleanupBatchItems() {
    activeBatchId++;
    imageQueue.forEach((item) => {
        if (item.originalUrl) URL.revokeObjectURL(item.originalUrl);
        if (item.processedUrl) URL.revokeObjectURL(item.processedUrl);
    });
    imageQueue = [];
    processedCount = 0;
}

// Sync UI with Firestore user details
function syncUserUI() {
  const avatarChar = document.getElementById('userAvatarChar');
  const userEmailText = document.getElementById('userEmailText');
  const userPlanBadge = document.getElementById('userPlanBadge');
  const topPlanBadge = document.getElementById('topPlanBadge');
  const authMenuLabel = document.getElementById('authMenuLabel');
  const quickLogoutBtn = document.getElementById('quickLogoutBtn');

  // Dashboard Stats
  const statUserPlan = document.getElementById('stat-user-plan');
  const statVideoCount = document.getElementById('stat-video-count');
  const statLicenseStatus = document.getElementById('stat-license-status');

  // Profile View
  const profileEmailText = document.getElementById('profileEmailText');
  const profilePlanText = document.getElementById('profilePlanText');
  const profilePlanBadge = document.getElementById('profilePlanBadge');
  const profileUidText = document.getElementById('profileUidText');
  const profileVideosProcessedText = document.getElementById('profileVideosProcessedText');

  const sidebarEl = document.getElementById('sidebar');
  const topbarEl = document.getElementById('topbar');

  if (currentUser && userDocData) {
    if (sidebarEl) sidebarEl.classList.remove('hidden');
    if (topbarEl) topbarEl.classList.remove('hidden');

    const email = currentUser.email || 'user@git44.com';
    const plan = userDocData.plan || 'free';
    const videosProcessed = userDocData.videosProcessed || 0;

    // Sidebar Info
    if (avatarChar) avatarChar.textContent = email.charAt(0).toUpperCase();
    if (userEmailText) userEmailText.textContent = email;
    if (userPlanBadge) {
      userPlanBadge.textContent = plan === 'pro' ? 'PRO VIP MEMBER' : 'FREE TRIAL';
      userPlanBadge.className = `text-[9px] font-bold tracking-wider uppercase ${plan === 'pro' ? 'text-brand-500' : 'text-slate-400'}`;
    }
    if (authMenuLabel) authMenuLabel.textContent = 'Keluar Akun';
    if (quickLogoutBtn) quickLogoutBtn.classList.remove('hidden');

    // Header Badge
    if (topPlanBadge) {
      topPlanBadge.textContent = plan === 'pro' ? 'PRO VIP' : 'FREE TRIAL';
      topPlanBadge.className = `px-2.5 py-1 text-xs font-bold tracking-wide rounded-full ${plan === 'pro' ? 'bg-brand-500/10 border border-brand-500/20 text-brand-500 animate-pulse' : 'bg-slate-800 border border-slate-700 text-slate-300'}`;
    }

    // Dashboard View Stats
    if (statUserPlan) {
      statUserPlan.textContent = plan === 'pro' ? 'PRO VIP MEMBER' : 'FREE MEMBER';
      statUserPlan.className = `text-2xl font-extrabold font-display ${plan === 'pro' ? 'text-brand-400' : 'text-slate-100'}`;
    }
    if (statVideoCount) {
      statVideoCount.textContent = plan === 'pro' ? `${videosProcessed} / Unlimited` : `${videosProcessed} / 1`;
    }
    if (statLicenseStatus) {
      statLicenseStatus.textContent = plan === 'pro' ? 'AKTIF (VIP)' : 'TIDAK AKTIF';
      statLicenseStatus.className = `text-2xl font-extrabold font-display ${plan === 'pro' ? 'text-brand-400' : 'text-red-400'}`;
    }

    // Profile View Details
    if (profileEmailText) profileEmailText.textContent = email;
    if (profilePlanText) profilePlanText.textContent = plan === 'pro' ? 'PRO VIP MEMBER (UNLIMITED)' : 'FREE MEMBER (TRIAL)';
    if (profilePlanBadge) {
      profilePlanBadge.textContent = plan === 'pro' ? 'PRO' : 'FREE';
      profilePlanBadge.className = `px-2 py-0.5 text-[10px] font-bold uppercase rounded ${plan === 'pro' ? 'bg-brand-500/10 border border-brand-500/20 text-brand-500' : 'bg-slate-800 border border-slate-700 text-slate-400'}`;
    }
    if (profileUidText) profileUidText.textContent = currentUser.uid;
    if (profileVideosProcessedText) {
      profileVideosProcessedText.textContent = plan === 'pro' ? `${videosProcessed} kali (Sangat Lancar)` : `${videosProcessed} / 1 kali`;
    }

  } else {
    if (sidebarEl) sidebarEl.classList.add('hidden');
    if (topbarEl) topbarEl.classList.add('hidden');

    // Guest User Defaults
    if (avatarChar) avatarChar.textContent = '?';
    if (userEmailText) userEmailText.textContent = 'Guest User';
    if (userPlanBadge) {
      userPlanBadge.textContent = 'Belum Masuk';
      userPlanBadge.className = 'text-[9px] font-bold tracking-wider uppercase text-slate-500';
    }
    if (authMenuLabel) authMenuLabel.textContent = 'Daftar / Masuk';
    if (quickLogoutBtn) quickLogoutBtn.classList.add('hidden');

    if (topPlanBadge) {
      topPlanBadge.textContent = 'BELUM MASUK';
      topPlanBadge.className = 'px-2.5 py-1 text-xs font-bold tracking-wide rounded-full bg-slate-800 border border-slate-700 text-slate-400';
    }

    if (statUserPlan) statUserPlan.textContent = 'GUEST ACCESS';
    if (statVideoCount) statVideoCount.textContent = '0 / 0';
    if (statLicenseStatus) {
      statLicenseStatus.textContent = 'NON-AKTIF';
      statLicenseStatus.className = 'text-2xl font-extrabold font-display text-slate-500';
    }

    if (profileEmailText) profileEmailText.textContent = 'Silakan masuk terlebih dahulu';
    if (profilePlanText) profilePlanText.textContent = 'Tidak Ada';
    if (profilePlanBadge) {
      profilePlanBadge.textContent = 'GUEST';
      profilePlanBadge.className = 'px-2 py-0.5 text-[10px] font-bold uppercase rounded bg-slate-800 text-slate-500';
    }
    if (profileUidText) profileUidText.textContent = 'Belum terautentikasi';
    if (profileVideosProcessedText) profileVideosProcessedText.textContent = '0 / 0';
  }
}

// Listen to auth changes
onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    // Get user document
    const userDocRef = doc(db, 'users', user.uid);
    let docSnap = await getDoc(userDocRef);

    if (!docSnap.exists()) {
      // Create new default free document
      const defaultData = {
        email: user.email,
        plan: 'free',
        videosProcessed: 0,
        createdAt: new Date().toISOString()
      };
      await setDoc(userDocRef, defaultData);
      userDocData = defaultData;
    } else {
      userDocData = docSnap.data();
    }
    
    syncUserUI();
    // Default redirect to dashboard
    switchView('dashboard');
  } else {
    currentUser = null;
    userDocData = null;
    syncUserUI();
    switchView('auth');
  }
});

// Setup event listeners for Auth Actions
const authErrorMsg = document.getElementById('authErrorMsg');

if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (authErrorMsg) authErrorMsg.classList.add('hidden');
    const email = document.getElementById('loginEmailInput').value.trim();
    const pass = document.getElementById('loginPasswordInput').value;

    try {
      showLoading('Masuk ke akun...');
      await signInWithEmailAndPassword(auth, email, pass);
      hideLoading();
    } catch (err) {
      hideLoading();
      if (authErrorMsg) {
        authErrorMsg.textContent = `Login gagal: ${err.message}`;
        authErrorMsg.classList.remove('hidden');
      }
    }
  });
}

if (registerForm) {
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (authErrorMsg) authErrorMsg.classList.add('hidden');
    const email = document.getElementById('regEmailInput').value.trim();
    const pass = document.getElementById('regPasswordInput').value;
    const passConfirm = document.getElementById('regPasswordConfirmInput').value;

    if (pass.length < 6) {
      if (authErrorMsg) {
        authErrorMsg.textContent = 'Sandi minimal 6 karakter.';
        authErrorMsg.classList.remove('hidden');
      }
      return;
    }

    if (pass !== passConfirm) {
      if (authErrorMsg) {
        authErrorMsg.textContent = 'Kedua sandi tidak cocok.';
        authErrorMsg.classList.remove('hidden');
      }
      return;
    }

    try {
      showLoading('Mendaftarkan akun...');
      await createUserWithEmailAndPassword(auth, email, pass);
      hideLoading();
    } catch (err) {
      hideLoading();
      if (authErrorMsg) {
        authErrorMsg.textContent = `Registrasi gagal: ${err.message}`;
        authErrorMsg.classList.remove('hidden');
      }
    }
  });
}

// Google Sign-In Button Listener
const googleSignInBtn = document.getElementById('googleSignInBtn');
if (googleSignInBtn) {
  googleSignInBtn.addEventListener('click', async () => {
    if (authErrorMsg) authErrorMsg.classList.add('hidden');
    try {
      showLoading('Masuk dengan Google...');
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
      hideLoading();
    } catch (err) {
      hideLoading();
      if (authErrorMsg) {
        authErrorMsg.textContent = `Gagal masuk dengan Google: ${err.message}`;
        authErrorMsg.classList.remove('hidden');
      }
    }
  });
}

// Log out handlers
const quickLogoutBtn = document.getElementById('quickLogoutBtn');
const handleSignOut = async () => {
  try {
    showLoading('Sedang keluar...');
    await signOut(auth);
    hideLoading();
  } catch (err) {
    hideLoading();
    console.error(err);
  }
};

if (quickLogoutBtn) {
  quickLogoutBtn.addEventListener('click', handleSignOut);
}

// Sidebar Menu Click Handlers
Object.keys(menuButtons).forEach(key => {
  if (menuButtons[key]) {
    menuButtons[key].addEventListener('click', () => {
      if (key === 'auth' && currentUser) {
        // Sign out if clicking auth tab when logged in
        handleSignOut();
      } else {
        switchView(key);
      }
    });
  }
});


// PRO KEY LICENSE REDEMPTION
const licenseForm = document.getElementById('licenseActivationForm');
const licenseErrorFeedback = document.getElementById('licenseErrorFeedback');
const licenseSuccessFeedback = document.getElementById('licenseSuccessFeedback');

if (licenseForm) {
  licenseForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (licenseErrorFeedback) licenseErrorFeedback.classList.add('hidden');
    if (licenseSuccessFeedback) licenseSuccessFeedback.classList.add('hidden');

    if (!currentUser) {
      if (licenseErrorFeedback) {
        licenseErrorFeedback.textContent = 'Silakan masuk akun terlebih dahulu.';
        licenseErrorFeedback.classList.remove('hidden');
      }
      return;
    }

    const keyInput = document.getElementById('licenseCodeInput').value.trim().toUpperCase();
    const validKeys = ['GIT44PRO', 'ADMIN123', 'SUPERGIT44', 'PROV2026', 'VIP44'];

    if (validKeys.includes(keyInput)) {
      try {
        showLoading('Mengaktivasi lisensi PRO...');
        
        // Update user plan to pro
        const userDocRef = doc(db, 'users', currentUser.uid);
        await updateDoc(userDocRef, {
          plan: 'pro'
        });

        // Re-read user doc
        const updatedDoc = await getDoc(userDocRef);
        userDocData = updatedDoc.data();
        syncUserUI();

        hideLoading();
        if (licenseSuccessFeedback) licenseSuccessFeedback.classList.remove('hidden');
        document.getElementById('licenseCodeInput').value = '';
      } catch (err) {
        hideLoading();
        if (licenseErrorFeedback) {
          licenseErrorFeedback.textContent = `Aktivasi gagal: ${err.message}`;
          licenseErrorFeedback.classList.remove('hidden');
        }
      }
    } else {
      if (licenseErrorFeedback) {
        licenseErrorFeedback.textContent = 'Kode lisensi tidak valid atau telah kedaluwarsa.';
        licenseErrorFeedback.classList.remove('hidden');
      }
    }
  });
}


// ==================== VIDEO WATERMARK REMOVER ====================
const videoUrlInput = document.getElementById('videoUrlInput');
const clearInputBtn = document.getElementById('clearInputBtn');
const processVideoBtn = document.getElementById('processVideoBtn');

const progressStepper = document.getElementById('progressStepper');
const progressBar = document.getElementById('progressBar');
const stepperPercent = document.getElementById('stepperPercent');
const step1 = document.getElementById('step1');
const step2 = document.getElementById('step2');
const step3 = document.getElementById('step3');
const step4 = document.getElementById('step4');

const statusError = document.getElementById('statusError');
const statusErrorText = document.getElementById('statusErrorText');
const resultContainer = document.getElementById('resultContainer');
const previewPlayer = document.getElementById('previewPlayer');
const downloadVideoBtn = document.getElementById('downloadVideoBtn');
const copyUrlBtn = document.getElementById('copyUrlBtn');
const openTabBtn = document.getElementById('openTabBtn');
const copiedToast = document.getElementById('copiedToast');

let currentProcessedUrl = "";

// Clear Input UI Utility
if (videoUrlInput) {
  videoUrlInput.addEventListener('input', () => {
    if (clearInputBtn) {
      clearInputBtn.style.display = videoUrlInput.value.trim() ? 'flex' : 'none';
    }
  });
}

if (clearInputBtn && videoUrlInput) {
  clearInputBtn.addEventListener('click', () => {
    videoUrlInput.value = '';
    clearInputBtn.style.display = 'none';
    videoUrlInput.focus();
  });
}

// Preset examples trigger
document.querySelectorAll('.example-tag').forEach(tag => {
  tag.addEventListener('click', () => {
    if (videoUrlInput) {
      videoUrlInput.value = tag.getAttribute('data-url');
      if (clearInputBtn) clearInputBtn.style.display = 'flex';
      setTimeout(() => {
        if (processVideoBtn) processVideoBtn.click();
      }, 150);
    }
  });
});

// Copy output URL action
if (copyUrlBtn) {
  copyUrlBtn.addEventListener('click', async () => {
    if (!currentProcessedUrl) return;
    
    const fullUrl = window.location.origin + currentProcessedUrl;
    try {
      await navigator.clipboard.writeText(fullUrl);
      if (copiedToast) {
        copiedToast.classList.remove('opacity-0', 'translate-y-12', 'pointer-events-none');
        copiedToast.classList.add('opacity-100', 'translate-y-0');
        setTimeout(() => {
          copiedToast.classList.add('opacity-0', 'translate-y-12', 'pointer-events-none');
          copiedToast.classList.remove('opacity-100', 'translate-y-0');
        }, 3000);
      }
    } catch (err) {
      console.error('Gagal menyalin:', err);
    }
  });
}

// Helper to set stepper steps without full reconstruction
function updateProgressOnly(percent, activeStepId, completedSteps = []) {
  if (progressBar) progressBar.style.width = percent + '%';
  if (stepperPercent) stepperPercent.textContent = percent + '%';

  completedSteps.forEach(sId => {
    const item = document.getElementById(sId);
    if (item) {
      item.className = 'flex gap-3 text-xs opacity-100 text-brand-400 font-semibold';
      const indicator = item.querySelector('.step-indicator');
      if (indicator) {
        indicator.className = 'step-indicator flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-full bg-brand-500/20 border border-brand-500 text-brand-500 font-bold';
        indicator.innerHTML = `
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>`;
      }
    }
  });

  if (activeStepId) {
    const activeItem = document.getElementById(activeStepId);
    if (activeItem) {
      activeItem.className = 'flex gap-3 text-xs opacity-100 text-slate-100 font-semibold scale-105 transition-all';
      const indicator = activeItem.querySelector('.step-indicator');
      if (indicator) {
        indicator.className = 'step-indicator flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-full bg-slate-900 border-2 border-brand-500 text-brand-400 font-bold animate-pulse';
        indicator.innerHTML = `<span class="w-2 h-2 rounded-full bg-brand-500"></span>`;
      }
    }
  }
}

// Stop Interactive Stepper Loading
function stopStepper(success = true) {
  if (progressStepper) {
    setTimeout(() => {
      progressStepper.classList.add('hidden');
    }, success ? 1000 : 0);
  }
}

// PostMessage callbacks for Video processor
let iframePromiseResolve = null;
let iframePromiseReject = null;

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'GWR_VIDEO_PROGRESS') {
    const { progress, pct, label, status } = data;
    
    if (progress < 0.12) {
      // Watermark detection phase
      const detectPct = Math.round(50 + (progress / 0.12) * 20);
      updateProgressOnly(detectPct, 'step3', ['step1', 'step2']);
    } else {
      // Watermark removal phase
      const removalPct = Math.round(70 + ((progress - 0.12) / 0.88) * 30);
      updateProgressOnly(removalPct, 'step4', ['step1', 'step2', 'step3']);
    }
  } else if (data.type === 'GWR_VIDEO_SUCCESS') {
    if (iframePromiseResolve) {
      iframePromiseResolve({
        blob: data.blob,
        processedUrl: data.processedUrl,
        fileName: data.fileName
      });
    }
  } else if (data.type === 'GWR_VIDEO_ERROR') {
    if (iframePromiseReject) {
      iframePromiseReject(new Error(data.error || 'Gagal memproses file di video-worker.'));
    }
  }
});

// Video Cleaner Button Click Event
if (processVideoBtn) {
  processVideoBtn.addEventListener('click', async () => {
    if (!videoUrlInput) return;
    const url = videoUrlInput.value.trim();

    // Check Login State
    if (!currentUser) {
      switchView('auth');
      if (authErrorMsg) {
        authErrorMsg.textContent = 'Harap mendaftar atau masuk akun terlebih dahulu untuk menggunakan alat!';
        authErrorMsg.classList.remove('hidden');
      }
      return;
    }

    // Check Usage Limit (Free tier can only do exactly 1 video total)
    if (userDocData) {
      const plan = userDocData.plan || 'free';
      const processed = userDocData.videosProcessed || 0;

      if (plan === 'free' && processed >= 1) {
        // Limit reached, block and open profile view
        switchView('profile');
        if (licenseErrorFeedback) {
          licenseErrorFeedback.textContent = 'Akses Gratis Habis (1 Video). Upgrade ke PRO VIP menggunakan kode lisensi untuk pengerjaan tanpa batas!';
          licenseErrorFeedback.classList.remove('hidden');
        }
        return;
      }
    }

    if (!url) {
      if (statusError && statusErrorText) {
        statusError.classList.remove('hidden');
        statusErrorText.textContent = "Silakan masukkan URL video terlebih dahulu.";
      }
      if (resultContainer) resultContainer.classList.add('hidden');
      return;
    }

    // Reset view states
    if (statusError) statusError.classList.add('hidden');
    if (resultContainer) resultContainer.classList.add('hidden');
    processVideoBtn.disabled = true;

    // Start loading steps
    if (progressStepper) progressStepper.classList.remove('hidden');
    if (progressBar) progressBar.style.width = '0%';
    if (stepperPercent) stepperPercent.textContent = '0%';
    
    // Reset individual step visuals
    ['step1', 'step2', 'step3', 'step4'].forEach(sId => {
      const item = document.getElementById(sId);
      if (item) {
        item.className = 'flex gap-3 text-xs opacity-40';
        const indicator = item.querySelector('.step-indicator');
        if (indicator) {
          indicator.className = 'step-indicator flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-full bg-slate-800 text-slate-400 font-bold';
          indicator.innerHTML = sId.replace('step', '');
        }
      }
    });

    try {
      // Step 1: URL Extraction
      updateProgressOnly(10, 'step1');

      const response = await fetch('/api/process-video', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url, clientSide: true }),
        credentials: 'include'
      });

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || "Gagal mengurai tautan video. Coba periksa kembali URL Anda.");
      }

      const videoDirectUrl = data.videoDirectUrl;

      // Step 2: Download Media Source
      updateProgressOnly(25, 'step2', ['step1']);

      const proxyUrl = `/api/proxy-video?url=${encodeURIComponent(videoDirectUrl)}`;
      const videoResponse = await fetch(proxyUrl, {
        credentials: 'include'
      });
      if (!videoResponse.ok) {
        let errorDetail = "";
        try {
          const errData = await videoResponse.json();
          if (errData && errData.error) {
            errorDetail = ` (${errData.error})`;
          }
        } catch (e) {
          errorDetail = ` (${videoResponse.status} ${videoResponse.statusText})`;
        }
        throw new Error(`Gagal mengunduh file video dari server sumber${errorDetail}.`);
      }

      const reader = videoResponse.body.getReader();
      const contentLength = +videoResponse.headers.get('Content-Length') || 0;
      let receivedLength = 0;
      let chunks = [];
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        receivedLength += value.length;
        
        if (contentLength) {
          const dlPercent = Math.round((receivedLength / contentLength) * 100);
          const step2Progress = Math.round(25 + (dlPercent * 0.25)); // Maps 0-100% to 25-50%
          if (progressBar) progressBar.style.width = step2Progress + '%';
          if (stepperPercent) stepperPercent.textContent = step2Progress + '%';
        }
      }

      const videoBlob = new Blob(chunks, { type: 'video/mp4' });

      // Step 3: Send file to iframe and wait for processing success
      updateProgressOnly(50, 'step3', ['step1', 'step2']);

      const iframe = document.getElementById('videoProcessorIframe');
      const filename = url.split('/').pop().split('?')[0] || 'video.mp4';
      
      // Setup promise to wait for iframe response
      const processingPromise = new Promise((resolve, reject) => {
        iframePromiseResolve = resolve;
        iframePromiseReject = reject;
      });

      iframe.contentWindow.postMessage({
        type: 'PROCESS_VIDEO_BLOB',
        blob: videoBlob,
        filename: filename
      }, '*');

      // Wait for iframe processing
      const result = await processingPromise;

      // Increment videoProcessed count securely in Firestore!
      if (currentUser) {
        const userDocRef = doc(db, 'users', currentUser.uid);
        await updateDoc(userDocRef, {
          videosProcessed: increment(1)
        });

        // Re-get doc
        const updatedDoc = await getDoc(userDocRef);
        userDocData = updatedDoc.data();
        syncUserUI();
      }

      // Step 4: Finished
      updateProgressOnly(100, null, ['step1', 'step2', 'step3', 'step4']);
      stopStepper(true);
      
      // Generate processed local blob URL
      if (currentProcessedUrl && currentProcessedUrl.startsWith('blob:')) {
        URL.revokeObjectURL(currentProcessedUrl);
      }
      currentProcessedUrl = URL.createObjectURL(result.blob);

      setTimeout(() => {
        if (resultContainer) resultContainer.classList.remove('hidden');
        if (previewPlayer) previewPlayer.src = currentProcessedUrl;
        if (downloadVideoBtn) downloadVideoBtn.href = currentProcessedUrl;
        if (openTabBtn) openTabBtn.href = currentProcessedUrl;
        
        const originalName = url.split('/').pop().split('?')[0] || 'video';
        if (downloadVideoBtn) {
          downloadVideoBtn.download = originalName.endsWith('.mp4') ? originalName : `git44_${originalName}.mp4`;
        }
        
        if (resultContainer) resultContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 850);

    } catch (err) {
      stopStepper(false);
      if (statusError && statusErrorText) {
        statusError.classList.remove('hidden');
        statusErrorText.textContent = err.message || "Koneksi ke server terputus atau terjadi kesalahan sistem.";
      }
      console.error(err);
    } finally {
      processVideoBtn.disabled = false;
      iframePromiseResolve = null;
      iframePromiseReject = null;
    }
  });
}


// ==================== IMAGE WATERMARK REMOVER ====================
const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const singlePreview = document.getElementById('singlePreview');
const multiPreview = document.getElementById('multiPreview');
const imageList = document.getElementById('imageList');
const progressText = document.getElementById('progressText');
const originalImage = document.getElementById('originalImage');
const processedImage = document.getElementById('processedImage');
const originalInfo = document.getElementById('originalInfo');
const processedInfo = document.getElementById('processedInfo');
const downloadBtn = document.getElementById('downloadBtn');
const copyBtn = document.getElementById('copyBtn');
const resetBtn = document.getElementById('resetBtn');
const batchResetBtn = document.getElementById('batchResetBtn');
const processedOverlay = document.getElementById('processedOverlay');
const sliderHandle = document.getElementById('sliderHandle');
const imageStatusMsg = document.getElementById('imageStatusMsg');

function setImageStatus(msg, type = 'info') {
  if (!imageStatusMsg) return;
  if (!msg) {
    imageStatusMsg.classList.add('hidden');
    return;
  }
  imageStatusMsg.classList.remove('hidden', 'bg-slate-900', 'text-slate-400', 'bg-red-500/10', 'text-red-400', 'bg-brand-500/10', 'text-brand-500');
  
  if (type === 'error') {
    imageStatusMsg.classList.add('bg-red-500/10', 'text-red-400');
  } else if (type === 'success') {
    imageStatusMsg.classList.add('bg-brand-500/10', 'text-brand-500');
  } else {
    imageStatusMsg.classList.add('bg-slate-900', 'text-slate-400');
  }
  imageStatusMsg.textContent = msg;
}

async function init() {
    try {
        showLoading(TEXT.loading);

        // Check if running inside iframe and show cookie block warning
        try {
            const isIframe = window.self !== window.top;
            if (isIframe) {
                const warnBox = document.getElementById('iframeWarningBox');
                const openBtn = document.getElementById('openInNewTabBtn');
                if (warnBox) warnBox.classList.remove('hidden');
                if (openBtn) {
                    openBtn.href = window.location.href;
                }
            }
        } catch (e) {
            console.warn('Iframe check warning:', e);
        }

        if (canUseWatermarkWorker()) {
            try {
                workerClient = new WatermarkWorkerClient({
                    workerUrl: './workers/watermark-worker.js'
                });
            } catch (workerError) {
                console.warn('worker unavailable, fallback to main thread:', workerError);
                workerClient = null;
            }
        }

        if (!workerClient) {
            getEngine().catch((error) => {
                console.warn('main thread engine warmup failed:', error);
            });
        }

        hideLoading();
        setupImageEventListeners();
        setupImageSlider();
        await consumePendingImageHandoff();
    } catch (error) {
        hideLoading();
        console.error('initialize error:', error);
    }
}

function setupImageEventListeners() {
    if (uploadArea) uploadArea.addEventListener('click', () => fileInput.click());
    if (fileInput) fileInput.addEventListener('change', handleFileSelect);

    document.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (uploadArea) uploadArea.classList.add('border-brand-500', 'bg-brand-500/5');
    });

    document.addEventListener('dragleave', (e) => {
        if (e.clientX === 0 && e.clientY === 0) {
            if (uploadArea) uploadArea.classList.remove('border-brand-500', 'bg-brand-500/5');
        }
    });

    document.addEventListener('drop', (e) => {
        e.preventDefault();
        if (uploadArea) uploadArea.classList.remove('border-brand-500', 'bg-brand-500/5');
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            handleImageFiles(Array.from(e.dataTransfer.files));
        }
    });

    document.addEventListener('paste', (e) => {
        const items = e.clipboardData.items;
        const files = [];
        for (let i = 0; i < items.length; i++) {
            if (items[i].kind === 'file') {
                files.push(items[i].getAsFile());
            }
        }
        if (files.length > 0) handleImageFiles(files);
    });

    if (resetBtn) resetBtn.addEventListener('click', resetImages);
    if (batchResetBtn) batchResetBtn.addEventListener('click', resetImages);
    
    window.addEventListener('beforeunload', () => {
        cleanupBatchItems();
        disableWorkerClient('beforeunload');
    });
}

function resetImages() {
    cleanupCurrentItem();
    cleanupBatchItems();
    if (singlePreview) singlePreview.classList.add('hidden');
    if (multiPreview) multiPreview.classList.add('hidden');
    if (fileInput) fileInput.value = '';
    if (imageList) imageList.innerHTML = '';
    updateImageProgress();
    if (originalImage) originalImage.src = '';
    if (processedImage) processedImage.src = '';
    if (originalInfo) originalInfo.innerHTML = '';
    if (processedInfo) processedInfo.innerHTML = '';
    if (processedOverlay) processedOverlay.style.display = 'none';
    if (sliderHandle) sliderHandle.style.display = 'none';
    setImageStatus('');
}

function handleFileSelect(e) {
    handleImageFiles(Array.from(e.target.files));
}

async function handleImageFiles(files) {
    setImageStatus('');

    // Check login state
    if (!currentUser) {
      switchView('auth');
      if (authErrorMsg) {
        authErrorMsg.textContent = 'Harap masuk atau daftar terlebih dahulu untuk memproses gambar!';
        authErrorMsg.classList.remove('hidden');
      }
      return;
    }

    const list = Array.from(files || []).filter(Boolean);
    const videoFile = list.find((file) => getDebugFileKind(file) === 'video');
    if (videoFile) {
        await routeVideoFile(videoFile);
        return;
    }

    const imageFiles = list.filter((file) => getDebugFileKind(file) === 'image');
    if (imageFiles.length === 0) {
        setImageStatus(TEXT.unsupportedFile, 'error');
        return;
    }

    const validImageFiles = imageFiles.filter((file) => file.size <= 20 * 1024 * 1024);
    if (validImageFiles.length === 0) {
        setImageStatus(TEXT.fileTooLarge, 'error');
        return;
    }

    if (validImageFiles.length < imageFiles.length) {
        setImageStatus(TEXT.skippedLargeImages, 'error');
    }

    if (validImageFiles.length > 1) {
        processBatchImages(validImageFiles);
        return;
    }

    const validFile = validImageFiles[0];
    cleanupCurrentItem();
    cleanupBatchItems();
    if (multiPreview) multiPreview.classList.add('hidden');
    if (imageList) imageList.innerHTML = '';
    currentItem = {
        id: Date.now(),
        file: validFile,
        name: validFile.name,
        originalImg: null,
        processedMeta: null,
        processedBlob: null,
        originalUrl: null,
        processedUrl: null
    };

    if (singlePreview) singlePreview.classList.remove('hidden');
    processSingleImage(currentItem);
}

function createDebugImageItem(file, index) {
    return {
        id: `${Date.now()}-${index}`,
        file,
        name: file.name,
        status: 'pending',
        originalImg: null,
        processedMeta: null,
        processedBlob: null,
        originalUrl: null,
        processedUrl: null
    };
}

function processBatchImages(files) {
    cleanupCurrentItem();
    cleanupBatchItems();

    imageQueue = files.map(createDebugImageItem);
    if (singlePreview) singlePreview.classList.add('hidden');
    if (multiPreview) multiPreview.classList.remove('hidden');
    if (imageList) imageList.innerHTML = '';
    updateImageProgress();
    imageQueue.forEach((item) => createImageCard(item));
    if (multiPreview) multiPreview.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const batchId = activeBatchId;
    processImageQueue(batchId);
}

async function routeVideoFile(file) {
    try {
        switchView('video');
        if (videoUrlInput) {
          videoUrlInput.value = 'File Unggahan Langsung';
          if (clearInputBtn) clearInputBtn.style.display = 'flex';
        }
        showLoading(TEXT.handoffVideo);
        await saveDebugFileHandoff(file, 'video');
        
        // Setup direct iframe file processor routing
        const iframe = document.getElementById('videoProcessorIframe');
        iframe.contentWindow.postMessage({
          type: 'PROCESS_VIDEO_BLOB',
          blob: file,
          filename: file.name
        }, '*');
        
        hideLoading();
    } catch (error) {
        hideLoading();
        console.error(error);
        setImageStatus(error.message || 'Gagal beralih ke video.', 'error');
    }
}

async function consumePendingImageHandoff() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('fileHandoff') !== '1') return;

    try {
        const record = await consumeDebugFileHandoff('image');
        if (!record?.file) return;
        await handleImageFiles([record.file]);
        window.history.replaceState(null, '', window.location.pathname);
    } catch (error) {
        console.warn('image handoff unavailable:', error);
        setImageStatus(error.message || 'Membuka gambar gagal.', 'error');
    }
}

function renderSingleImageMeta(item) {
    if (!item?.originalImg) return;

    const watermarkInfo = resolveDisplayWatermarkInfo(
        item,
        getEstimatedWatermarkInfo(item)
    );
    if (!watermarkInfo) return;

    if (originalInfo) {
      originalInfo.innerHTML = `
          <p class="font-bold">Original Info</p>
          <p>${TEXT.size}: ${item.originalImg.width}x${item.originalImg.height}</p>
          <p>${TEXT.watermark}: ${watermarkInfo.size}x${watermarkInfo.size}</p>
          <p>${TEXT.position}: (${watermarkInfo.position.x},${watermarkInfo.position.y})</p>
      `;
    }
}

function getProcessedStatusLabel(item) {
    return !isConfirmedWatermarkDecision(item)
        ? TEXT.skipped
        : TEXT.removed;
}

function renderSingleProcessedMeta(item) {
    if (!item?.originalImg) return;

    const watermarkInfo = resolveDisplayWatermarkInfo(
        item,
        getEstimatedWatermarkInfo(item)
    );
    const showWatermarkInfo = watermarkInfo && isConfirmedWatermarkDecision(item);

    if (processedInfo) {
      processedInfo.innerHTML = `
          <p class="font-bold text-brand-400">Hasil Pembersihan</p>
          <p>${TEXT.size}: ${item.originalImg.width}x${item.originalImg.height}</p>
          ${showWatermarkInfo ? `<p>${TEXT.watermark}: ${watermarkInfo.size}x${watermarkInfo.size}</p>` : ''}
          ${showWatermarkInfo ? `<p>${TEXT.position}: (${watermarkInfo.position.x},${watermarkInfo.position.y})</p>` : ''}
          <p class="font-semibold text-brand-500">${TEXT.status}: ${getProcessedStatusLabel(item)}</p>
      `;
    }
}

async function processSingleImage(item) {
    try {
        setImageStatus('Membuka file gambar...', 'info');
        const img = await loadImage(item.file);
        item.originalImg = img;
        item.originalUrl = img.src;

        if (originalImage) originalImage.src = img.src;
        renderSingleImageMeta(item);

        setImageStatus('Menghapus watermark AI...', 'info');
        const processed = await processImageWithBestPath(item.file, img);
        item.processedMeta = processed.meta;
        item.processedBlob = processed.blob;
        item.processedUrl = URL.createObjectURL(processed.blob);

        if (processedImage) processedImage.src = item.processedUrl;
        if (processedOverlay) processedOverlay.style.display = 'block';
        if (sliderHandle) sliderHandle.style.display = 'flex';

        if (copyBtn) {
          copyBtn.onclick = () => copyImage(item);
        }

        if (downloadBtn) {
          downloadBtn.onclick = () => downloadImage(item);
        }

        renderSingleProcessedMeta(item);
        setImageStatus('Gambar berhasil dide-watermark!', 'success');
        
        if (comparisonContainer) {
          comparisonContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    } catch (error) {
        setImageStatus('Terjadi kesalahan pemrosesan gambar.', 'error');
        console.error(error);
    }
}

function createImageCard(item) {
    const card = document.createElement('div');
    card.id = `card-${item.id}`;
    card.className = 'p-4 rounded-xl bg-slate-900 border border-slate-800 space-y-3 flex flex-col justify-between';
    card.innerHTML = `
        <div class="aspect-video w-full rounded-lg bg-slate-950 border border-slate-800 overflow-hidden relative">
            <img id="processed-${item.id}" class="w-full h-full object-contain pointer-events-none" draggable="false" src="" />
        </div>
        <div class="space-y-1">
            <h4 class="text-xs font-bold text-slate-200 truncate" id="card-title-${item.id}"></h4>
            <div class="text-[11px] font-semibold text-slate-500" id="status-${item.id}">Menunggu...</div>
        </div>
        <div class="flex gap-2 pt-1.5 border-t border-slate-800">
            <button id="copy-${item.id}" class="flex-1 py-1.5 rounded-lg bg-brand-500/10 hover:bg-brand-500 text-brand-500 hover:text-slate-950 text-[11px] font-bold transition-all" style="display: none;">Salin</button>
            <button id="download-${item.id}" class="flex-1 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-semibold transition-all" style="display: none;">Unduh</button>
        </div>
    `;
    if (imageList) imageList.appendChild(card);

    const titleEl = document.getElementById(`card-title-${item.id}`);
    if (titleEl) {
      titleEl.textContent = typeof item.name === 'string' ? item.name : '';
    }
    renderImageCardStatus(item);
}

function renderImageCardStatus(item) {
    const statusEl = document.getElementById(`status-${item.id}`);
    if (!statusEl) return;

    if (item.status === 'completed') {
        statusEl.textContent = getProcessedStatusLabel(item);
        statusEl.className = 'text-[11px] font-bold text-brand-400';
        return;
    }
    statusEl.className = 'text-[11px] font-semibold text-slate-500';

    const labels = {
        pending: TEXT.pending,
        loading: TEXT.loadingImage,
        processing: TEXT.processing,
        error: TEXT.processFailed
    };
    statusEl.textContent = labels[item.status] || TEXT.pending;
}

function updateImageProgress() {
    if (progressText && imageQueue.length) {
      progressText.textContent = `${TEXT.progress}: ${processedCount}/${imageQueue.length}`;
    }
}

async function processImageQueue(batchId) {
    const concurrency = 3;
    for (let i = 0; i < imageQueue.length; i += concurrency) {
        if (batchId !== activeBatchId) return;

        await Promise.all(imageQueue.slice(i, i + concurrency).map(async (item) => {
            if (batchId !== activeBatchId || item.status !== 'pending') return;

            item.status = 'loading';
            renderImageCardStatus(item);

            try {
                const img = await loadImage(item.file);
                if (batchId !== activeBatchId) return;

                item.originalImg = img;
                item.originalUrl = img.src;

                item.status = 'processing';
                renderImageCardStatus(item);

                const processed = await processImageWithBestPath(item.file, img);
                if (batchId !== activeBatchId) return;

                item.processedMeta = processed.meta;
                item.processedBlob = processed.blob;
                item.processedUrl = URL.createObjectURL(processed.blob);

                const processedPreview = document.getElementById(`processed-${item.id}`);
                if (processedPreview) processedPreview.src = item.processedUrl;

                item.status = 'completed';
                processedCount++;
                renderImageCardStatus(item);
                updateImageProgress();

                const itemCopyBtn = document.getElementById(`copy-${item.id}`);
                if (itemCopyBtn) {
                    itemCopyBtn.style.display = 'inline-flex';
                    itemCopyBtn.onclick = () => copyImage(item, itemCopyBtn);
                }

                const itemDownloadBtn = document.getElementById(`download-${item.id}`);
                if (itemDownloadBtn) {
                    itemDownloadBtn.style.display = 'inline-flex';
                    itemDownloadBtn.onclick = () => downloadImage(item);
                }
            } catch (error) {
                if (batchId !== activeBatchId) return;
                item.status = 'error';
                renderImageCardStatus(item);
                console.error(error);
            }
        }));
    }
}

async function processImageWithBestPath(file, fallbackImage, options = {}) {
    if (workerClient) {
        try {
            return await workerClient.processBlob(file, options);
        } catch (error) {
            console.warn('worker process failed, fallback to main thread:', error);
            disableWorkerClient(error);
        }
    }

    const engine = await getEngine();
    const canvas = await engine.removeWatermarkFromImage(fallbackImage, options);
    const blob = await canvasToBlob(canvas);
    return {
        blob,
        meta: canvas.__watermarkMeta || null
    };
}

async function copyImage(item, targetBtn = copyBtn) {
    if (!navigator.clipboard || !window.ClipboardItem) {
        setImageStatus(TEXT.unsupported, 'error');
        return;
    }

    try {
        if (!item.processedBlob) return;
        const data = [new ClipboardItem({ [item.processedBlob.type]: item.processedBlob })];
        await navigator.clipboard.write(data);

        const span = targetBtn.querySelector('span') || targetBtn;
        const originalText = span.textContent;
        span.textContent = 'Berhasil Disalin!';
        setTimeout(() => {
            span.textContent = originalText;
        }, 2000);
    } catch (err) {
        console.error('Failed to copy image: ', err);
        setImageStatus(TEXT.copyFailed, 'error');
    }
}

function downloadImage(item) {
    const a = document.createElement('a');
    a.href = item.processedUrl;
    a.download = `git44_unwatermarked_${item.name.replace(/\.[^.]+$/, '')}.png`;
    a.click();
}

function setupImageSlider() {
    const container = document.getElementById('comparisonContainer');
    if (!container) return;
    let isDown = false;

    function move(e) {
        if (!isDown) return;
        const rect = container.getBoundingClientRect();
        const clientX = e.clientX || (e.touches && e.touches[0].clientX);
        if (!clientX) return;

        const x = clientX - rect.left;
        const percent = Math.min(Math.max(x / rect.width, 0), 1) * 100;

        if (processedOverlay) processedOverlay.style.width = `${percent}%`;
        if (sliderHandle) sliderHandle.style.left = `${percent}%`;
    }

    container.addEventListener('mousedown', (e) => {
        isDown = true;
        move(e);
    });
    window.addEventListener('mouseup', () => { isDown = false; });
    window.addEventListener('mousemove', move);

    container.addEventListener('touchstart', (e) => {
        isDown = true;
        move(e);
    });
    window.addEventListener('touchend', () => { isDown = false; });
    window.addEventListener('touchmove', move);
}

// Warmup the image cleaner system on window load
init();
