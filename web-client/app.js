

// ============ MESSAGE TYPES ============
const MSG_TWIST = 0x01;
const MSG_ACK = 0x02;
const MSG_SYNC_REQ = 0x03;
const MSG_SYNC_RESP = 0x04;

// ============ CONFIG ============
const CONFIG = {
    wsUrl: `ws://${location.hostname || 'localhost'}:8080/ws/data?type=web`,
    sendHz: 20,
    chartWindowSec: 20,
    syncIntervalMs: 10000,
    maxSpeed: 1.0,
    keyRepeatMs: 50,
};

// ============ STATE ============
let ws = null;
let connected = false;
let msgId = 0;
let history = [];
let linY = 0, angZ = 0;
let sendTimer = null;

// Keyboard state
let keysPressed = new Set();
let keyTimer = null;

// Clock sync
let clockOffset = 0, clockRtt = 0, clockSynced = false;
let offsets = [];

// Stats
let ackCount = 0;
let lastAckTime = 0;

// ============ BINARY ENCODING ============

/**
 * Encode Twist message (65 bytes)
 * 
 * Layout:
 *   [0]     uint8   type (0x01)
 *   [1-8]   uint64  message_id
 *   [9-16]  uint64  t1_browser_send
 *   [17-64] float64 × 6 velocities
 */
function encodeTwist(id, t1, lx, ly, lz, ax, ay, az) {
    const buf = new ArrayBuffer(65);
    const v = new DataView(buf);
    let o = 0;
    
    v.setUint8(o, MSG_TWIST); o += 1;              // type
    v.setBigUint64(o, BigInt(id), true); o += 8;   // message_id
    v.setBigUint64(o, BigInt(t1), true); o += 8;   // timestamp
    v.setFloat64(o, lx, true); o += 8;             // linear.x
    v.setFloat64(o, ly, true); o += 8;             // linear.y
    v.setFloat64(o, lz, true); o += 8;             // linear.z
    v.setFloat64(o, ax, true); o += 8;             // angular.x
    v.setFloat64(o, ay, true); o += 8;             // angular.y
    v.setFloat64(o, az, true);                     // angular.z
    
    return buf;
}

/**
 * Decode Twist Ack (77 bytes)
 * 
 * Layout:
 *   [0]     uint8   type (0x02)
 *   [1-8]   uint64  message_id
 *   [9-16]  uint64  t1_browser_send
 *   [17-24] uint64  t2_relay_rx
 *   [25-32] uint64  t3_relay_tx
 *   [33-40] uint64  t3_python_rx
 *   [41-48] uint64  t4_python_ack
 *   [49-52] uint32  python_decode_us
 *   [53-56] uint32  python_process_us
 *   [57-60] uint32  python_encode_us
 *   [61-68] uint64  t4_relay_ack_rx
 *   [69-76] uint64  t5_relay_ack_tx
 */
function decodeAck(buf) {
    const v = new DataView(buf);
    return {
        msgId:           Number(v.getBigUint64(1, true)),
        t1_browser:      Number(v.getBigUint64(9, true)),
        t2_relay_rx:     Number(v.getBigUint64(17, true)),
        t3_relay_tx:     Number(v.getBigUint64(25, true)),
        t3_python_rx:    Number(v.getBigUint64(33, true)),
        t4_python_ack:   Number(v.getBigUint64(41, true)),
        decode_us:       v.getUint32(49, true),
        process_us:      v.getUint32(53, true),
        encode_us:       v.getUint32(57, true),
        t4_relay_ack_rx: Number(v.getBigUint64(61, true)),
        t5_relay_ack_tx: Number(v.getBigUint64(69, true)),
    };
}

/**
 * Encode Clock Sync Request (9 bytes)
 */
function encodeSyncReq(t1) {
    const buf = new ArrayBuffer(9);
    const v = new DataView(buf);
    v.setUint8(0, MSG_SYNC_REQ);
    v.setBigUint64(1, BigInt(t1), true);
    return buf;
}

/**
 * Decode Clock Sync Response (25 bytes)
 */
function decodeSyncResp(buf) {
    const v = new DataView(buf);
    return {
        t1: Number(v.getBigUint64(1, true)),
        t2: Number(v.getBigUint64(9, true)),
        t3: Number(v.getBigUint64(17, true)),
    };
}

// ============ CHART ============

let chart = null;

function initChart() {
    const ctx = document.getElementById('chart').getContext('2d');
    chart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                { label: 'RTT', data: [], borderColor: '#00f5d4', backgroundColor: 'rgba(0,245,212,0.1)', fill: true, tension: 0.3, pointRadius: 0 },
                { label: 'Browser→Relay', data: [], borderColor: '#f72585', tension: 0.3, pointRadius: 0 },
                { label: 'Relay→Python', data: [], borderColor: '#fee440', tension: 0.3, pointRadius: 0 },
                { label: 'Python', data: [], borderColor: '#4361ee', tension: 0.3, pointRadius: 0 },
                { label: 'Return', data: [], borderColor: '#ff6b35', tension: 0.3, pointRadius: 0 },
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            scales: {
                x: { grid: { color: 'rgba(42,42,58,0.5)' }, ticks: { color: '#8a8a9a', maxTicksLimit: 8 } },
                y: { grid: { color: 'rgba(42,42,58,0.5)' }, ticks: { color: '#8a8a9a' }, min: 0 }
            },
            plugins: { legend: { labels: { color: '#8a8a9a', usePointStyle: true, padding: 12 } } }
        }
    });
}

// ============ WEBSOCKET ============

function connect() {
    if (ws) ws.close();
    
    console.log('Connecting to', CONFIG.wsUrl);
    ws = new WebSocket(CONFIG.wsUrl);
    ws.binaryType = 'arraybuffer';
    
    ws.onopen = () => {
        console.log('Connected');
        setConnected(true);
        sendSyncReq();
        setInterval(sendSyncReq, CONFIG.syncIntervalMs);
        startSending();
    };
    
    ws.onclose = () => {
        console.log('Disconnected');
        setConnected(false);
        stopSending();
    };
    
    ws.onerror = (e) => console.error('WebSocket error:', e);
    
    ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
            const type = new Uint8Array(e.data)[0];
            if (type === MSG_ACK) handleAck(e.data);
            else if (type === MSG_SYNC_RESP) handleSyncResp(e.data);
        }
    };
}

function disconnect() {
    if (ws) { ws.close(); ws = null; }
    stopSending();
}

function handleAck(buf) {
    const now = Date.now();
    const ack = decodeAck(buf);
    
    ackCount++;
    lastAckTime = now;
    
    const lat = {
        browserToRelay: ack.t2_relay_rx - ack.t1_browser,
        relayProc: ack.t3_relay_tx - ack.t2_relay_rx,
        relayToPython: ack.t3_python_rx - ack.t3_relay_tx,
        decode_us: ack.decode_us,
        process_us: ack.process_us,
        encode_us: ack.encode_us,
        pythonMs: (ack.decode_us + ack.process_us + ack.encode_us) / 1000,
        pythonToRelay: ack.t4_relay_ack_rx - ack.t4_python_ack,
        relayAckProc: ack.t5_relay_ack_tx - ack.t4_relay_ack_rx,
        relayToBrowser: now - ack.t5_relay_ack_tx,
        returnPath: now - ack.t4_python_ack,
        rtt: now - ack.t1_browser,
        // Raw timestamps for display
        t1: ack.t1_browser,
        t2: ack.t2_relay_rx,
        t3: ack.t3_relay_tx,
        t3py: ack.t3_python_rx,
        t4py: ack.t4_python_ack,
        t4rel: ack.t4_relay_ack_rx,
        t5rel: ack.t5_relay_ack_tx,
        t6: now,
    };
    
    updateMetrics(lat);
    updateChart(lat, now);
    updateBreakdown(lat);
    updateTimestamps(lat);
}

function handleSyncResp(buf) {
    const t4 = Date.now();
    const r = decodeSyncResp(buf);
    
    const rtt = (t4 - r.t1) - (r.t3 - r.t2);
    const offset = ((r.t2 - r.t1) + (r.t3 - t4)) / 2;
    
    offsets.push(offset);
    if (offsets.length > 5) offsets.shift();
    
    const sorted = [...offsets].sort((a,b) => a-b);
    clockOffset = sorted[Math.floor(sorted.length/2)];
    clockRtt = rtt;
    clockSynced = offsets.length >= 3;
    
    document.getElementById('syncOffset').textContent = clockOffset.toFixed(1) + ' ms';
    document.getElementById('syncRtt').textContent = clockRtt.toFixed(1) + ' ms';
    document.getElementById('syncStatus').textContent = clockSynced ? 'Synced ✓' : 'Syncing...';
}

// ============ SENDING ============

function startSending() {
    if (sendTimer) clearInterval(sendTimer);
    sendTimer = setInterval(sendTwist, 1000 / CONFIG.sendHz);
}

function stopSending() {
    if (sendTimer) { clearInterval(sendTimer); sendTimer = null; }
}

function sendTwist() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    msgId++;
    const buf = encodeTwist(msgId, Date.now(), 0, linY, 0, 0, 0, angZ);
    ws.send(buf);
}

function sendSyncReq() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(encodeSyncReq(Date.now()));
}

function sendStop() {
    linY = 0; angZ = 0;
    updateControlDisplay();
    sendTwist();
}

// ============ KEYBOARD CONTROLS ============

function setupKeyboard() {
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT') return;
        
        const key = e.key.toLowerCase();
        if (['w', 's', 'a', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(key)) {
            e.preventDefault();
            keysPressed.add(key);
            updateFromKeys();
        }
    });
    
    document.addEventListener('keyup', (e) => {
        const key = e.key.toLowerCase();
        keysPressed.delete(key);
        updateFromKeys();
    });
    
    // Continuous update while keys held
    keyTimer = setInterval(() => {
        if (keysPressed.size > 0) {
            updateFromKeys();
        }
    }, CONFIG.keyRepeatMs);
}

function updateFromKeys() {
    let newLinY = 0;
    let newAngZ = 0;
    
    // Forward/backward (W/S or Up/Down)
    if (keysPressed.has('w') || keysPressed.has('arrowup')) {
        newLinY = CONFIG.maxSpeed;
    } else if (keysPressed.has('s') || keysPressed.has('arrowdown')) {
        newLinY = -CONFIG.maxSpeed;
    }
    
    // Left/right rotation (A/D or Left/Right)
    if (keysPressed.has('a') || keysPressed.has('arrowleft')) {
        newAngZ = CONFIG.maxSpeed;
    } else if (keysPressed.has('d') || keysPressed.has('arrowright')) {
        newAngZ = -CONFIG.maxSpeed;
    }
    
    // Space = stop
    if (keysPressed.has(' ')) {
        newLinY = 0;
        newAngZ = 0;
    }
    
    linY = newLinY;
    angZ = newAngZ;
    updateControlDisplay();
}

// ============ JOYSTICK (optional) ============

function setupJoystick() {
    const container = document.getElementById('joystick');
    const knob = document.getElementById('knob');
    if (!container || !knob) return;
    
    let dragging = false;
    
    const update = (x, y) => {
        const rect = container.getBoundingClientRect();
        const cx = rect.width / 2, cy = rect.height / 2;
        const maxR = (rect.width - knob.offsetWidth) / 2;
        
        let dx = x - cx, dy = y - cy;
        const dist = Math.hypot(dx, dy);
        if (dist > maxR) { dx = dx/dist*maxR; dy = dy/dist*maxR; }
        
        knob.style.left = `${cx + dx}px`;
        knob.style.top = `${cy + dy}px`;
        
        linY = -dy / maxR * CONFIG.maxSpeed;
        angZ = -dx / maxR * CONFIG.maxSpeed;
        updateControlDisplay();
    };
    
    const onMove = (e) => {
        if (!dragging) return;
        e.preventDefault();
        const rect = container.getBoundingClientRect();
        const clientX = e.clientX ?? (e.touches && e.touches[0] ? e.touches[0].clientX : rect.width/2);
        const clientY = e.clientY ?? (e.touches && e.touches[0] ? e.touches[0].clientY : rect.height/2);
        update(clientX - rect.left, clientY - rect.top);
    };
    
    const onEnd = () => {
        dragging = false;
        knob.style.left = '50%';
        knob.style.top = '50%';
        linY = 0; angZ = 0;
        updateControlDisplay();
    };
    
    knob.addEventListener('mousedown', () => dragging = true);
    knob.addEventListener('touchstart', () => dragging = true);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchend', onEnd);
}

// ============ UI UPDATES ============

function setConnected(v) {
    connected = v;
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    const btn = document.getElementById('connectBtn');
    
    if (dot) dot.classList.toggle('on', v);
    if (text) text.textContent = v ? 'Connected' : 'Disconnected';
    if (btn) btn.textContent = v ? 'Disconnect' : 'Connect';
}

function updateControlDisplay() {
    const linEl = document.getElementById('linY');
    const angEl = document.getElementById('angZ');
    if (linEl) linEl.textContent = linY.toFixed(2);
    if (angEl) angEl.textContent = angZ.toFixed(2);
    
    // Update key indicators
    updateKeyIndicators();
}

function updateKeyIndicators() {
    const keys = ['w', 'a', 's', 'd'];
    keys.forEach(k => {
        const el = document.getElementById(`key-${k}`);
        if (el) {
            const altKey = k === 'w' ? 'arrowup' : k === 's' ? 'arrowdown' : k === 'a' ? 'arrowleft' : 'arrowright';
            el.classList.toggle('active', keysPressed.has(k) || keysPressed.has(altKey));
        }
    });
}

function updateMetrics(lat) {
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (el && val !== undefined && val !== null && !isNaN(val)) {
            el.innerHTML = val.toFixed(1) + '<span class="metric-unit">ms</span>';
        }
    };
    set('mRtt', lat.rtt);
    set('mBR', lat.browserToRelay);
    set('mRP', lat.relayToPython);
    set('mPy', lat.pythonMs);
    set('mPR', lat.pythonToRelay);
    set('mRB', lat.relayToBrowser);
}

function updateChart(lat, now) {
    if (!chart) return;
    
    const cutoff = now - CONFIG.chartWindowSec * 1000;
    history.push({ time: now, ...lat });
    history = history.filter(d => d.time > cutoff);
    
    chart.data.labels = history.map(d => `-${((now - d.time)/1000).toFixed(1)}s`);
    chart.data.datasets[0].data = history.map(d => d.rtt);
    chart.data.datasets[1].data = history.map(d => d.browserToRelay);
    chart.data.datasets[2].data = history.map(d => d.relayToPython);
    chart.data.datasets[3].data = history.map(d => d.pythonMs);
    chart.data.datasets[4].data = history.map(d => d.returnPath);
    chart.update('none');
}

function updateBreakdown(lat) {
    const el = document.getElementById('breakdown');
    if (!el) return;
    
    const items = [
        { label: 'Browser → Relay', color: '#f72585', val: lat.browserToRelay, unit: 'ms' },
        { label: 'Relay Forward', color: '#9b5de5', val: lat.relayProc, unit: 'ms' },
        { label: 'Relay → Python', color: '#fee440', val: lat.relayToPython, unit: 'ms' },
        { label: 'Python Decode', color: '#4361ee', val: lat.decode_us, unit: 'μs' },
        { label: 'Python Process', color: '#4361ee', val: lat.process_us, unit: 'μs' },
        { label: 'Python Encode', color: '#4361ee', val: lat.encode_us, unit: 'μs' },
        { label: 'Python → Relay', color: '#ff6b35', val: lat.pythonToRelay, unit: 'ms' },
        { label: 'Relay Ack Fwd', color: '#9b5de5', val: lat.relayAckProc, unit: 'ms' },
        { label: 'Relay → Browser', color: '#ff6b35', val: lat.relayToBrowser, unit: 'ms' },
        { label: 'Total RTT', color: '#00f5d4', val: lat.rtt, unit: 'ms' },
    ];
    
    el.innerHTML = items.map(i => `
        <div class="breakdown-item">
            <div class="breakdown-label">
                <div class="breakdown-dot" style="background:${i.color}"></div>
                ${i.label}
            </div>
            <div class="breakdown-val" style="color:${i.color}">
                ${(i.val !== undefined && i.val !== null && !isNaN(i.val)) ? i.val.toFixed(i.unit === 'μs' ? 0 : 2) : '--'} ${i.unit}
            </div>
        </div>
    `).join('');
}

function updateTimestamps(lat) {
    const el = document.getElementById('timestamps');
    if (!el) return;
    
    const formatTs = (ts) => {
        if (!ts) return '--';
        const d = new Date(ts);
        return d.toISOString().substr(11, 12); // HH:MM:SS.mmm
    };
    
    el.innerHTML = `
        <div class="ts-row"><span class="ts-label">t1 Browser Send</span><span class="ts-val">${formatTs(lat.t1)}</span></div>
        <div class="ts-row"><span class="ts-label">t2 Relay Rx</span><span class="ts-val">${formatTs(lat.t2)}</span></div>
        <div class="ts-row"><span class="ts-label">t3 Relay Tx</span><span class="ts-val">${formatTs(lat.t3)}</span></div>
        <div class="ts-row"><span class="ts-label">t3 Python Rx</span><span class="ts-val">${formatTs(lat.t3py)}</span></div>
        <div class="ts-row"><span class="ts-label">t4 Python Ack</span><span class="ts-val">${formatTs(lat.t4py)}</span></div>
        <div class="ts-row"><span class="ts-label">t4 Relay Ack Rx</span><span class="ts-val">${formatTs(lat.t4rel)}</span></div>
        <div class="ts-row"><span class="ts-label">t5 Relay Ack Tx</span><span class="ts-val">${formatTs(lat.t5rel)}</span></div>
        <div class="ts-row"><span class="ts-label">t6 Browser Rx</span><span class="ts-val">${formatTs(lat.t6)}</span></div>
    `;
}

// ============ INIT ============

function init() {
    initChart();
    setupKeyboard();
    setupJoystick();
    
    // Button handlers
    const connectBtn = document.getElementById('connectBtn');
    const stopBtn = document.getElementById('stopBtn');
    const syncBtn = document.getElementById('syncBtn');
    
    if (connectBtn) connectBtn.onclick = () => connected ? disconnect() : connect();
    if (stopBtn) stopBtn.onclick = sendStop;
    if (syncBtn) syncBtn.onclick = sendSyncReq;
    
    // Initialize breakdown with empty state
    updateBreakdown({});
    
    console.log('Teleop Dashboard initialized');
    console.log('Controls: WASD or Arrow Keys, Space to stop');
}

// Start when DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}