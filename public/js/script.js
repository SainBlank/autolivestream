console.log('StreamFire V7 Loaded');

const socket = io();

socket.on('connect', () => console.log('Socket Connected'));
socket.on('connect_error', (err) => console.log('Socket Err:', err.message));

const logContainer = document.getElementById('activity-log');

function addLogEntry(log) {
    if (logContainer.children.length === 1 && logContainer.children[0].classList.contains('text-center')) {
        logContainer.innerHTML = '';
    }

    const div = document.createElement('div');
    div.className = `border-l-2 pl-2 py-0.5 ${log.type === 'error' ? 'border-red-500 text-red-400' : (log.type === 'success' ? 'border-green-500 text-green-400' : 'border-blue-500 text-blue-300')}`;
    div.innerHTML = `<span class="text-gray-500">[${log.time}]</span> ${log.message}`;

    logContainer.insertBefore(div, logContainer.firstChild);
}

socket.on('newLog', (log) => addLogEntry(log));

async function updateStats() {
    try {
        const res = await fetch('/api/system/stats');
        const data = await res.json();

        const ramText = document.getElementById('ram-text');
        const ramBar = document.getElementById('ram-bar');
        const cpuText = document.getElementById('cpu-text');
        const cpuBar = document.getElementById('cpu-bar');
        const diskText = document.getElementById('disk-text');
        const diskBar = document.getElementById('disk-bar');

        if (ramText) ramText.innerText = `${data.ram.percent}% (${data.ram.usedMB} MB)`;
        if (ramBar) {
            ramBar.style.width = `${data.ram.percent}%`;
            ramBar.className = `h-4 border-2 border-black transition-all duration-500 ${data.ram.percent > 85 ? 'bg-red-500' : 'bg-yellow-400'}`;
        }

        if (cpuText) cpuText.innerText = `${data.cpu.percent}%`;
        if (cpuBar) {
            cpuBar.style.width = `${data.cpu.percent}%`;
            cpuBar.className = `h-4 border-2 border-black transition-all duration-500 ${data.cpu.percent > 85 ? 'bg-red-500' : 'bg-cyan-400'}`;
        }

        if (data.disk && diskText && diskBar) {
            diskText.innerText = `${data.disk.percent}% (${data.disk.used})`;
            diskBar.style.width = `${data.disk.percent}%`;
            diskBar.className = `h-4 border-2 border-black transition-all duration-500 ${data.disk.percent > 90 ? 'bg-red-500' : 'bg-green-400'}`;
        }

    } catch (e) {

    }
}
setInterval(updateStats, 3000);
updateStats();



const modal = document.getElementById('uploadModal');
const btnUpload = document.getElementById('add-video-btn');
const btnClose = document.getElementById('closeModal');
if (btnUpload) btnUpload.onclick = () => modal.classList.remove('hidden');
if (btnClose) btnClose.onclick = () => modal.classList.add('hidden');

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('videoInput');
const fileName = document.getElementById('fileName');

if (dropZone) {
    dropZone.onclick = () => fileInput.click();
    fileInput.onchange = () => {
        if (fileInput.files.length > 0) {
            fileName.innerText = fileInput.files[0].name;
            fileName.classList.add('text-orange-400');
        }
    };
}

const form = document.getElementById('uploadForm');
if (form) {
    form.onsubmit = async (e) => {
        e.preventDefault();
        modal.classList.add('hidden');
        Swal.fire({ title: 'Uploading...', text: 'Processing video...', allowOutsideClick: false, background: '#1f2937', color: '#fff', didOpen: () => Swal.showLoading() });
        try {
            const res = await fetch('/api/upload/local', { method: 'POST', body: new FormData(form) });
            if (res.ok) {
                window.location.reload();
            } else throw new Error('Upload Failed');
        } catch (err) { Swal.fire({ icon: 'error', title: 'Error', text: err.message, background: '#1f2937', color: '#fff' }); }
    };
}

const RTMP_PRESETS = {
    custom: { prefix: '', placeholder: 'RTMP URL (e.g. rtmp://site.com/live/key)' },
    youtube: { prefix: 'rtmp://a.rtmp.youtube.com/live2/', placeholder: 'Paste Stream Key' },
    facebook: { prefix: 'rtmps://live-api-s.facebook.com:443/rtmp/', placeholder: 'Paste Stream Key' },
    twitch: { prefix: 'rtmp://live.twitch.tv/app/', placeholder: 'Paste Stream Key' }
};

window.updatePlaceholder = (select) => {
    const key = select.value;
    const row = select.closest('.destination-row');
    const input = row.querySelector('input');
    const prefixEl = row.querySelector('.prefix-display');

    if (input && RTMP_PRESETS[key]) {
        input.placeholder = RTMP_PRESETS[key].placeholder;
        if (prefixEl) {
            prefixEl.innerText = key === 'custom' ? '' : `Server: ${RTMP_PRESETS[key].prefix}`;
            prefixEl.style.display = key === 'custom' ? 'none' : 'block';
        }
    }
};
window.addDestination = (id) => {
    const container = document.getElementById(`destinations-container-${id}`);
    const div = document.createElement('div');
    div.className = 'flex flex-col gap-1 destination-row mb-2 border-b-2 border-black/10 pb-2';
    div.innerHTML = `
      <div class="flex items-stretch gap-1">
        <select class="bg-gray-50 border-2 border-black px-2 py-2 text-[10px] font-bold outline-none focus:bg-yellow-100 uppercase platform-select font-mono w-24" onchange="updatePlaceholder(this)">
            <option value="custom">Custom</option>
            <option value="youtube">YouTube</option>
            <option value="facebook">Facebook</option>
            <option value="twitch">Twitch</option>
        </select>
        <div class="relative group/input flex-1">
            <div class="absolute left-3 top-2.5 text-black z-20"><i class="fas fa-key text-xs"></i></div>
            <input type="password" value=""
            class="w-full h-full bg-gray-50 border-2 border-black px-3 pl-9 py-2 text-xs text-black focus:bg-yellow-100 outline-none transition-all placeholder-gray-500 font-mono destination-input relative z-10"
            placeholder="RTMP URL (e.g. rtmp://site.com/live/key)">
            <button type="button" onclick="const i = this.previousElementSibling; i.type = i.type === 'password' ? 'text' : 'password'; this.innerHTML = i.type === 'password' ? '<i class=\'fas fa-eye\'></i>' : '<i class=\'fas fa-eye-slash\'></i>';" class="absolute right-2 top-2 z-30 text-gray-500 hover:text-black">
                <i class="fas fa-eye"></i>
            </button>
        </div>
        <button type="button" onclick="this.closest('.destination-row').remove()" class="bg-red-500 text-white border-2 border-black w-8 flex items-center justify-center hover:bg-red-600 transition-colors shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:shadow-none active:translate-x-[1px] active:translate-y-[1px]">
            <i class="fas fa-times text-xs"></i>
        </button>
      </div>
      <div class="prefix-display text-[10px] font-mono text-gray-500 pl-1 hidden"></div>
    `;
    container.appendChild(div);
};

document.querySelectorAll('.start-btn').forEach(btn => {
    btn.onclick = async function () {
        const id = this.getAttribute('data-id');
        const isRunning = this.getAttribute('data-running') === 'true';

        if (isRunning) {
            await fetch('/api/stream/stop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ videoId: id })
            });
        } else {
            const container = document.getElementById(`destinations-container-${id}`);
            const rows = container.querySelectorAll('.destination-row');
            const destinations = [];

            rows.forEach(row => {
                const select = row.querySelector('.platform-select');
                const input = row.querySelector('.destination-input');

                if (input && input.value.trim()) {
                    let val = input.value.trim();
                    const type = select ? select.value : 'custom';

                    if (type !== 'custom' && RTMP_PRESETS[type]) {
                        if (!val.startsWith('rtmp')) {
                            val = RTMP_PRESETS[type].prefix + val;
                        }
                    }
                    destinations.push(val);
                }
            });

            const res = document.getElementById(`res-${id}`).value;
            const fps = document.getElementById(`fps-${id}`).value;
            const bit = document.getElementById(`bit-${id}`).value;
            const loop = document.getElementById(`loop-${id}`).checked;

            if (destinations.length === 0) return Swal.fire({ icon: 'warning', title: 'Missing Destination', text: 'Please add at least one RTMP URL', background: '#1f2937', color: '#fff' });

            this.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Starting...';
            this.disabled = true;

            try {
                const resp = await fetch('/api/stream/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ videoId: id, settings: { resolution: res, bitrate: bit, fps: fps }, loop: loop, customRtmp: destinations })
                });
                if (!resp.ok) throw new Error('Failed to start');
            } catch (e) {
                Swal.fire({ icon: 'error', title: 'Stream Error', text: e.message, background: '#1f2937', color: '#fff' });
                this.innerHTML = '<i class="fas fa-play text-xs"></i> Start Stream';
                this.disabled = false;
            }
        }
    };
});

document.querySelectorAll('.delete-btn').forEach(btn => {
    btn.onclick = async function () {
        const result = await Swal.fire({
            title: 'Delete Video?',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#ef4444',
            cancelButtonColor: '#374151',
            confirmButtonText: 'Delete',
            background: '#1f2937', color: '#fff'
        });
        if (result.isConfirmed) {
            await fetch('/api/video/' + this.getAttribute('data-id'), { method: 'DELETE' });
            window.location.reload();
        }
    }
});

const timers = {};
function startTimer(id, startTimeStr) {
    if (timers[id]) clearInterval(timers[id]);

    const el = document.getElementById(`timer-${id}`);
    if (!el) return;
    el.classList.remove('hidden');

    const update = () => {
        if (!startTimeStr) {
            el.innerText = "00:00:00";
            return;
        }
        const start = new Date(startTimeStr).getTime();
        const now = new Date().getTime();
        const diff = Math.max(0, Math.floor((now - start) / 1000));

        const h = Math.floor(diff / 3600).toString().padStart(2, '0');
        const m = Math.floor((diff % 3600) / 60).toString().padStart(2, '0');
        const s = (diff % 60).toString().padStart(2, '0');
        el.innerText = `${h}:${m}:${s}`;
    };

    update(); 
    timers[id] = setInterval(update, 1000);
}

function stopTimer(id) {
    if (timers[id]) { clearInterval(timers[id]); delete timers[id]; }
    const el = document.getElementById(`timer-${id}`);
    if (el) { el.classList.add('hidden'); el.innerText = '00:00:00'; }
}

socket.on('streamStatuses', (list) => {
    const countEl = document.getElementById('active-count');
    if (countEl) countEl.innerText = list.filter(x => x.running).length;
    list.forEach(x => updateCard(x.videoId, x.running, x.startTime));
});
socket.on('streamStatus', (item) => updateCard(item.videoId, item.running, item.startTime));

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.start-btn').forEach(btn => {
        const id = btn.getAttribute('data-id');
        const isRunning = btn.getAttribute('data-running') === 'true';
        const startTime = btn.getAttribute('data-start-time');

        if (isRunning && startTime) {
            updateCard(id, true, startTime);
        }
    });
});

function updateCard(id, isRunning, startTime = null) {
    const btn = document.querySelector(`.start-btn[data-id="${id}"]`);
    const badge = document.getElementById(`badge-${id}`);
    const dot = document.getElementById(`dot-${id}`);
    const text = document.getElementById(`status-${id}`);
    const card = document.getElementById(`card-${id}`);
    const videoEl = card ? card.querySelector('video') : null;

    if (!btn) return;

    btn.setAttribute('data-running', isRunning);
    if (startTime) btn.setAttribute('data-start-time', startTime);
    btn.disabled = false;

    if (isRunning) {
        btn.innerHTML = '<i class="fas fa-stop text-xs"></i> Stop Stream';
        btn.className = 'w-full bg-red-600 hover:bg-red-500 text-white font-bold py-2.5 rounded-lg transition-all start-btn shadow-lg flex items-center justify-center gap-2';
        badge.className = 'bg-red-500/90 backdrop-blur-sm text-[10px] font-bold px-2 py-1 rounded-md text-white border border-red-400 flex items-center gap-1.5 shadow-lg animate-pulse';
        dot.className = 'w-1.5 h-1.5 rounded-full bg-white';
        text.innerText = 'LIVE';
        if (startTime) startTimer(id, startTime);

        if (videoEl) {
            videoEl.muted = true;
            videoEl.loop = true;
            videoEl.play().catch(e => console.log("Auto-play blocked:", e));
            videoEl.classList.remove('opacity-80');
            videoEl.classList.add('opacity-100');
        }

    } else {
        btn.innerHTML = '<i class="fas fa-play text-xs"></i> Start Stream';
        btn.className = 'w-full bg-gradient-to-r from-gray-700 to-gray-600 hover:from-gray-600 hover:to-gray-500 text-white font-bold py-2.5 rounded-lg transition-all start-btn shadow-lg text-sm flex items-center justify-center gap-2';
        badge.className = 'bg-black/80 text-[10px] font-bold px-2 py-1 rounded-md text-gray-400 border border-white/10 flex items-center gap-1.5 backdrop-blur-sm';
        dot.className = 'w-1.5 h-1.5 rounded-full bg-gray-500';
        text.innerText = 'OFFLINE';
        stopTimer(id);

        if (videoEl) {
            videoEl.pause();
            videoEl.currentTime = 0;
            videoEl.classList.add('opacity-80');
            videoEl.classList.remove('opacity-100');
        }
    }
}

window.saveConfig = async (id) => {
    const container = document.getElementById(`destinations-container-${id}`);
    const rows = container.querySelectorAll('.destination-row');
    const destinations = [];

    rows.forEach(row => {
        const select = row.querySelector('.platform-select');
        const input = row.querySelector('.destination-input');

        if (input && input.value.trim()) {
            let val = input.value.trim();
            const type = select ? select.value : 'custom';

            if (type !== 'custom' && RTMP_PRESETS[type]) {
                if (!val.startsWith('rtmp')) {
                    val = RTMP_PRESETS[type].prefix + val;
                }
            }
            destinations.push(val);
        }
    });

    const res = document.getElementById(`res-${id}`).value;
    const fps = document.getElementById(`fps-${id}`).value;
    const bit = document.getElementById(`bit-${id}`).value;
    const loop = document.getElementById(`loop-${id}`).checked;

    const btn = document.querySelector(`button[onclick="saveConfig('${id}')"]`);
    const originalContent = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> SAVING...';
    btn.disabled = true;

    try {
        const resp = await fetch('/api/stream/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoId: id, settings: { resolution: res, bitrate: bit, fps: fps }, loop: loop, customRtmp: destinations })
        });

        if (!resp.ok) throw new Error('Failed to save');
        const data = await resp.json();

        Swal.fire({
            icon: 'success',
            title: 'Saved!',
            text: 'Configuration saved successfully.',
            toast: true,
            position: 'top-end',
            showConfirmButton: false,
            timer: 3000,
            background: '#1f2937', color: '#fff'
        });

    } catch (e) {
        Swal.fire({ icon: 'error', title: 'Error', text: e.message, background: '#1f2937', color: '#fff' });
    } finally {
        btn.innerHTML = originalContent;
        btn.disabled = false;
    }
};