/* Main App Logic */
console.log("App.js loading...");

// Export functions to window immediately so HTML onclicks work
window.toggleMenu = () => alert('Menu implementation coming soon!');
window.toggleProfile = () => {
    if(confirm('Log out?')) {
        sessionStorage.clear();
        location.reload();
    }
};
window.setMode = setMode;
window.postNewRide = postNewRide;
window.closePostModal = closePostModal;
window.submitNewRide = submitNewRide;
window.handleLogin = handleLogin;
window.handleAccept = handleAccept;
window.handleDecline = handleDecline;
window.initApp = initApp;

// Global State
let userEmail = sessionStorage.getItem('asu_email') || null;
let currentMode = 'rider'; // 'rider' or 'driver'
let map = null;
let socket = null;
let userMarker = null;
let rideMarkers = [];

// DOM Elements placeholders
let modeRiderBtn, modeDriverBtn, riderSheet, driverSheet, driverHud, loginModal, loginEmailInput;

// Map Styles (Dark Theme from Snazzy Maps)


// --- Initialization ---

// Initialize DOM elements safely
function initDOM() {
    modeRiderBtn = document.getElementById('mode-rider');
    modeDriverBtn = document.getElementById('mode-driver');
    riderSheet = document.getElementById('rider-sheet');
    driverSheet = document.getElementById('driver-sheet');
    driverHud = document.getElementById('driver-hud');
    loginModal = document.getElementById('login-modal');
    loginEmailInput = document.getElementById('login-email');
}

// Run initDOM immediately to verify elements
initDOM();

function initApp() {
  console.log('Initializing App Logic (Leaflet)...');
  initDOM(); // Ensure DOM is ready

  // 1. Basic Auth Check
  if (!userEmail) {
    if(loginModal) loginModal.style.display = 'flex';
  } else {
    if(loginModal) loginModal.style.display = 'none';
    startSocket();
  }

  // 2. Map Init (Leaflet)
  const mapEl = document.getElementById('map-background');
  if (typeof L !== 'undefined' && mapEl) {
    // Default to ASU Tempe
    const defaultCoords = [33.4255, -111.9400];
    
    map = L.map('map-background', {
        zoomControl: false,
        attributionControl: false
    }).setView(defaultCoords, 14);

    // Dark Theme Tile Layer (CartoDB Dark Matter)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20
    }).addTo(map);

    // Try to locate user
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const userPos = [pos.coords.latitude, pos.coords.longitude];
          if(map) {
              map.setView(userPos, 15);
              // User Marker (Blue circle)
              userMarker = L.circleMarker(userPos, {
                  radius: 8,
                  fillColor: "#4285F4",
                  color: "#fff",
                  weight: 2,
                  opacity: 1,
                  fillOpacity: 1
              }).addTo(map).bindPopup("You are here");
          }
        },
        () => console.warn("Location permission denied")
      );
    }
  } else {
      console.warn("Leaflet not loaded or map element missing");
  }

  // 3. Initial Data Load
  setMode('rider'); // Default
}

function startSocket() {
  if(typeof io === 'undefined') return;
  socket = io();
  
  // Driver: refresh requests when new one comes in
  socket.on('newRequest', (req) => {
      if (currentMode === 'driver' && req.rideDriverEmail === userEmail) {
          fetchRequests();
          showToast('New Ride Request!', 'success');
      }
  });

  // Rider: refresh or notify when request accepted
  socket.on('requestAccepted', (data) => {
      if (currentMode === 'rider' && data.request.email === userEmail) {
           showToast(`Your ride with ${data.ride.name} was accepted!`, 'success');
           fetchRides(); // Refresh to see seat changes etc
      }
  });
}

// --- Auth & Mode ---

function handleLogin() {
  if(!loginEmailInput) initDOM();
  const email = loginEmailInput ? loginEmailInput.value.trim() : prompt("Enter ASU Email:");
  const asuEmailRegex = /[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\.)?asu\.edu$/i;
  
  if (!email || !asuEmailRegex.test(email)) {
    alert('Please enter a valid ASU email (@asu.edu).');
    return;
  }
  
  userEmail = email;
  sessionStorage.setItem('asu_email', email);
  if(loginModal) loginModal.style.display = 'none';
  startSocket();
  
  // Refresh data based on current mode
  if (currentMode === 'rider') fetchRides();
  else fetchRequests();
}

function setMode(mode) {
  currentMode = mode;
  if(!modeRiderBtn) initDOM();
  
  // Toggle UI Buttons
  if (mode === 'rider') {
    if(modeRiderBtn) modeRiderBtn.classList.add('active');
    if(modeDriverBtn) modeDriverBtn.classList.remove('active');
    
    // Toggle Sheets
    if(riderSheet) riderSheet.classList.remove('hidden');
    if(driverSheet) driverSheet.classList.add('hidden');
    if(driverHud) driverHud.classList.add('hidden');
    
    fetchRides();
  } else {
    if(modeDriverBtn) modeDriverBtn.classList.add('active');
    if(modeRiderBtn) modeRiderBtn.classList.remove('active');
    
    // Toggle Sheets
    if(driverSheet) driverSheet.classList.remove('hidden');
    if(riderSheet) riderSheet.classList.add('hidden');
    if(driverHud) driverHud.classList.remove('hidden');
    
    fetchRequests();
  }
}

// --- Rider Logic ---

async function fetchRides() {
  const list = document.getElementById('rides-list');
  if(!list) return;
  list.innerHTML = '<div style="text-align:center; padding:20px; color:#888">Finding nearby rides...</div>';
  
  try {
    const res = await fetch('/api/rides');
    const rides = await res.json();
    
    // Clear Map Markers
    rideMarkers.forEach(m => m.remove());
    rideMarkers = [];
    
    list.innerHTML = '';
    
    if (rides.length === 0) {
      list.innerHTML = '<div style="text-align:center; padding:20px; color:#888">No rides available right now.</div>';
      return;
    }
    
    rides.forEach(ride => {
      // Create Marker (Leaflet)
      if (ride.originLat && ride.originLng && map) {
        // Simple car icon using emoji or custom divIcon
        const carIcon = L.divIcon({
            className: 'car-marker',
            html: '<div style="font-size:24px; text-shadow:0 2px 5px rgba(0,0,0,0.3)">🚗</div>',
            iconSize: [30, 30],
            iconAnchor: [15, 15]
        });

        const marker = L.marker([ride.originLat, ride.originLng], { icon: carIcon })
            .addTo(map)
            .bindPopup(`<b>To: ${ride.destination}</b><br>Driver: ${ride.name}`);
            
        rideMarkers.push(marker);
        
        marker.on('click', () => {
             list.scrollIntoView({ behavior: 'smooth' });
        });
      }
      
      // Render Card
      const avail = parseInt(ride.seats) > 0;
      const card = document.createElement('div');
      card.className = 'ride-card';
      // simple car image placeholder or icon
      card.innerHTML = `
        <div class="ride-info">
           <div style="background:#eee; padding:10px; border-radius:50%">
             <span style="font-size:24px">🚗</span>
           </div>
           <div class="ride-details">
             <h3>${ride.destination}</h3>
             <p>From: ${ride.origin}</p>
             <p style="font-size:0.85em; color:#888">Driver: ${ride.name} • ${ride.seats} seats</p>
           </div>
        </div>
        <div style="text-align:right">
           <div class="ride-price">$5.00</div>
           <small style="color:#aaa">Est.</small>
        </div>
      `;
      
      card.onclick = () => {
         // Select logic
         document.querySelectorAll('.ride-card').forEach(c => c.classList.remove('selected'));
         card.classList.add('selected');
         promptRequestRide(ride);
      };
      
      list.appendChild(card);
    });
    
  } catch (err) {
    console.error(err);
    list.innerHTML = 'Error loading rides.';
  }
}

async function promptRequestRide(ride) {
  if (confirm(`Request a seat to ${ride.destination} with ${ride.name}?`)) {
     if (!userEmail) { alert('Please login first'); handleLogin(); return; }
     
     // Simple prompt for message
     const msg = prompt("Message for driver (optional):", "Hi, I'd like to join!");
     
     const res = await fetch('/api/request', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({
         rideId: ride.id,
         name: userEmail.split('@')[0], // simple name from email
         email: userEmail,
         message: msg || ""
       })
     });
     
     const j = await res.json();
     if (j.ok) {
       showToast('Request sent!', 'success');
     } else {
       alert(j.error || 'Failed to send request');
     }
  }
}

// --- Driver Logic ---

async function fetchRequests() {
  const list = document.getElementById('requests-list');
  if(!list) return;
  if (!userEmail) {
    list.innerHTML = '<div style="text-align:center; padding:20px">Please login first.</div>';
    return;
  }
  
  list.innerHTML = 'Loading...';
  
  try {
     const res = await fetch(`/api/requests?driverEmail=${encodeURIComponent(userEmail)}`);
     if(!res.ok) throw new Error('Failed');
     const reqs = await res.json();
     list.innerHTML = '';
     
     if (reqs.length === 0) {
       list.innerHTML = '<div style="text-align:center; padding:20px; color:#aaa">No pending requests.</div>';
       return;
     }
     
     reqs.forEach(r => {
        if (r.status !== 'pending') return; // Only show pending
        
        const card = document.createElement('div');
        card.className = 'request-card';
        card.innerHTML = `
          <div class="request-header">
            <strong>${r.name}</strong> 
            <span class="user-badge">Rider</span>
          </div>
          <p style="margin-bottom:12px; color:#555">"${r.message || 'Can I join?'}"</p>
          <div class="request-actions">
             <button class="btn-decline" onclick="handleDecline('${r.id}')">Decline</button>
             <button class="btn-accept" onclick="handleAccept('${r.id}')">Accept</button>
          </div>
        `;
        list.appendChild(card);
     });
     
  } catch (err) {
    list.innerHTML = 'Error loading requests.';
  }
}

async function handleAccept(reqId) {
  try {
    const res = await fetch(`/api/requests/${reqId}/accept`, { method: 'POST' });
    const j = await res.json();
    if (j.ok) {
      showToast('Ride request accepted!', 'success');
      fetchRequests();
    } else {
      alert(j.error);
    }
  } catch (e) { alert(e.message); }
}

async function handleDecline(reqId) {
  if(!confirm('Decline this request?')) return;
  try {
    const res = await fetch(`/api/requests/${reqId}/cancel`, { method: 'POST' });
    const j = await res.json();
    if(j.ok) {
       fetchRequests();
    }
  } catch(e) { alert(e.message); }
}

// --- Driver: Post New Ride ---

function postNewRide() {
  const modal = document.getElementById('post-ride-modal');
  if(modal) {
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
  }
  // Pre-fill name if known
  const nameInput = document.getElementById('driver-name-input');
  if (userEmail && nameInput && !nameInput.value) {
     nameInput.value = userEmail.split('@')[0];
  }
}

function closePostModal() {
  const modal = document.getElementById('post-ride-modal');
  if(modal) {
    modal.classList.add('hidden');
    modal.style.display = 'none';
  }
}

async function submitNewRide(e) {
  e.preventDefault();
  console.log("submitNewRide called");
  if(!userEmail) return alert('Please login first');
  
  const form = e.target;
  const submitBtn = form.querySelector('button[type="submit"]');
  const originalBtnText = submitBtn.innerText;
  
  // UI Loading State
  submitBtn.disabled = true;
  submitBtn.innerText = "Posting...";

  const data = {
    origin: form.origin.value,
    destination: form.destination.value,
    seats: form.seats.value,
    time: form.time.value,
    name: form.name.value,
    email: userEmail
  };
  
  console.log("Submitting ride data:", data);

  try {
    const res = await fetch('/api/driver', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(data)
    });
    console.log("Response status:", res.status);
    const j = await res.json();
    console.log("Response JSON:", j);
    
    if (j.ok) {
      showToast('Ride Posted Successfully!', 'success');
      closePostModal();
      form.reset();
      fetchRides();
    } else {
      alert("Error: " + j.error);
    }
  } catch(err) {
    console.error("Submission error:", err);
    alert('Network error details: ' + err.message);
  } finally {
    // Reset UI State
    if(submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerText = originalBtnText;
    }
  }
}

// --- Utilities ---

function showToast(msg, type='info') {
  // Create simple toast element if not exists
  let toast = document.getElementById('app-toast');
  if(!toast) {
    toast = document.createElement('div');
    toast.id = 'app-toast';
    toast.style.cssText = `
      position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%);
      background: #333; color: white; padding: 12px 24px; border-radius: 30px;
      z-index: 3000; font-weight: 600; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      transition: all 0.3s; opacity: 0; pointer-events: none;
    `;
    document.body.appendChild(toast);
  }
  
  toast.innerText = msg;
  toast.style.background = type === 'success' ? '#4ade80' : '#333';
  toast.style.color = type === 'success' ? '#064e3b' : 'white';
  toast.style.opacity = '1';
  toast.style.bottom = '40px';
  
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.bottom = '30px';
  }, 3000);
}
