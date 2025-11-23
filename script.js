// 初始化圖標
lucide.createIcons();

// --- 狀態管理 (State) ---
const state = {
    img: null,
    mainCanvas: document.getElementById('mainCanvas'), 
    ctx: null,
    offscreenCanvas: document.createElement('canvas'), 
    offCtx: null,
    width: 0, height: 0,
    filterId: 0,
    splitPos: 0.5,
    params: { exposure:0, contrast:0, highlights:0, shadows:0, temp:0, tint:0, sat:0, vib:0, soft:50, grain:0, lutAmount: 100 },
    builtInLuts: [],  // 內建濾鏡 (從 GitHub 資料夾載入)
    userLuts: [],     // 用戶上傳的 .cube
    // Zoom/Pan State
    scale: 1,
    pointX: 0, pointY: 0,
    // Crop State
    isCropping: false,
    cropAspect: null, // null = free, number = width/height
    // History
    history: [],
    historyIndex: -1
};

state.ctx = state.mainCanvas.getContext('2d');
state.offCtx = state.offscreenCanvas.getContext('2d', { willReadFrequently: true });

// --- 內建濾鏡設定 ---
const BUILT_IN_LUTS = [
    { name: "Abai Film", filename: "Abai Film_grid.png" },
    { name: "Abai Fuji 2", filename: "Abai Fuji 2_grid.png" },
    { name: "Abai Fuji", filename: "Abai Fuji_grid.png" },
    { name: "Abai", filename: "Abai_grid.png" },
    { name: "Abaii", filename: "Abaii_grid.png" }
];

// 預設濾鏡 (原圖)
const BASE_FILTERS = [
    { id: 0, name: "原圖", desc: "無效果", conf: {} },
];

// 啟動時載入濾鏡
window.addEventListener('load', loadBuiltInFilters);

async function loadBuiltInFilters() {
    const promises = BUILT_IN_LUTS.map((info, index) => {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = "Anonymous"; // 避免 Canvas 汙染問題
            img.onload = () => {
                // 解析 Grid PNG
                const lutData = parseHaldToLut(img, 64);
                if (lutData) {
                    resolve({
                        id: 'builtin_' + index,
                        name: info.name,
                        desc: '內建濾鏡',
                        lutData: lutData,
                        lutSize: 64
                    });
                } else {
                    resolve(null);
                }
            };
            img.onerror = () => {
                console.warn(`Failed to load filter: ${info.filename}`);
                resolve(null);
            };
            // 設定路徑：假設 luts 資料夾在同一層級
            img.src = `./luts/${info.filename}`;
        });
    });

    const results = await Promise.all(promises);
    state.builtInLuts = results.filter(f => f !== null);
    renderFilterList();
}

/**
 * 將 HALD Grid 圖片轉換為 3D LUT 陣列
 * 標準 64x64x64 LUT 對應 512x512 的 Grid 圖片 (8x8 blocks)
 */
function parseHaldToLut(img, size) {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imgData.data;
    const lutData = new Uint8ClampedArray(size * size * size * 3);

    const sqrtSize = Math.round(Math.sqrt(size * size * size)); // 512 for size 64
    const blocksPerRow = Math.round(Math.sqrt(size)); // 8 for size 64

    if (canvas.width !== sqrtSize || canvas.height !== sqrtSize) {
        console.warn(`LUT Image size mismatch. Expected ${sqrtSize}x${sqrtSize}, got ${canvas.width}x${canvas.height}`);
    }

    // 填充 LUT 陣列
    for (let b = 0; b < size; b++) {
        for (let g = 0; g < size; g++) {
            for (let r = 0; r < size; r++) {
                // 計算在 Hald 圖片中的 x, y 座標
                const blockX = (b % blocksPerRow) * size;
                const blockY = Math.floor(b / blocksPerRow) * size;
                
                const pixelX = blockX + r;
                const pixelY = blockY + g;
                
                const i = (pixelY * canvas.width + pixelX) * 4;
                
                // 目標索引
                const targetIdx = (b * size * size + g * size + r) * 3;
                
                lutData[targetIdx] = data[i];     // R
                lutData[targetIdx + 1] = data[i+1]; // G
                lutData[targetIdx + 2] = data[i+2]; // B
            }
        }
    }
    return lutData;
}

// --- 視圖控制 ---
const viewport = document.getElementById('viewport');
const transformLayer = document.getElementById('transformLayer');
const canvasContainer = document.getElementById('canvasContainer');
const zoomControlPanel = document.getElementById('zoomControls');
const bottomToolbar = document.getElementById('bottomToolbar');

function setZoom(delta, absolute = false) {
    if (!state.img) return;
    const prevScale = state.scale;
    if (absolute) {
        state.scale = delta;
    } else {
        state.scale += delta;
    }
    // Limit zoom
    state.scale = Math.min(Math.max(0.1, state.scale), 5);
    
    updateTransform();
    document.getElementById('zoomLevel').innerText = Math.round(state.scale * 100) + '%';
}

function fitToScreen() {
    if (!state.img) return;
    const vw = viewport.clientWidth - 40; // padding
    const vh = viewport.clientHeight - 40;
    const ratioW = vw / state.width;
    const ratioH = vh / state.height;
    state.scale = Math.min(ratioW, ratioH, 1);
    state.pointX = 0;
    state.pointY = 0;
    updateTransform();
    document.getElementById('zoomLevel').innerText = Math.round(state.scale * 100) + '%';
}

function updateTransform() {
    transformLayer.style.transform = `translate(${state.pointX}px, ${state.pointY}px) scale(${state.scale})`;
}

// Wheel Zoom
viewport.addEventListener('wheel', (e) => {
    if (!state.img) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.018 : 0.018;
    setZoom(delta);
}, { passive: false });

// --- 拖放 (Drag & Drop) ---
viewport.addEventListener('dragover', (e) => {
    e.preventDefault();
    document.getElementById('emptyState').classList.add('bg-gray-100/90', 'border-gray-500');
});
viewport.addEventListener('dragleave', (e) => {
    e.preventDefault();
    document.getElementById('emptyState').classList.remove('bg-gray-100/90', 'border-gray-500');
});
viewport.addEventListener('drop', (e) => {
    e.preventDefault();
    document.getElementById('emptyState').classList.remove('bg-gray-100/90', 'border-gray-500');
    
    const file = e.dataTransfer.files[0];
    if (file) {
        if (file.name.endsWith('.cube')) {
            loadLutFile(file);
        } else if (file.type.startsWith('image/')) {
            loadImageFile(file);
        }
    }
});

// --- 裁切邏輯 ---
const cropLayer = document.getElementById('cropLayer');
const cropBox = document.getElementById('cropBox');
let isDragCrop = false;
let cropStartMouse = {x:0, y:0};
let cropStartBox = {x:0, y:0, w:0, h:0};
let cropAction = null; 

function startCrop() {
    if(!state.img) return;
    state.isCropping = true;
    document.getElementById('normalTools').classList.add('hidden');
    document.getElementById('cropTools').classList.remove('hidden');
    cropLayer.classList.add('active');
    document.getElementById('compare-slider-handle').style.display = 'none';
    
    // Init with Free ratio
    setCropRatio(null);
    // Maximize crop box
    cropBox.style.left = '0px'; cropBox.style.top = '0px';
    cropBox.style.width = state.width + 'px'; cropBox.style.height = state.height + 'px';
}

function setCropRatio(targetRatio) {
    let newRatio = targetRatio;
    
    if (newRatio !== null) {
        const isImgPortrait = state.height > state.width;
        
        if (state.cropAspect !== null && 
            (Math.abs(state.cropAspect - newRatio) < 0.01 || Math.abs(state.cropAspect - (1/newRatio)) < 0.01)) {
            newRatio = 1 / state.cropAspect;
        } else {
            if (isImgPortrait && newRatio > 1) {
                newRatio = 1 / newRatio;
            } else if (!isImgPortrait && newRatio < 1) {
                newRatio = 1 / newRatio;
            }
        }
    }

    state.cropAspect = newRatio;

    // Update UI
    const btns = document.querySelectorAll('.ratio-btn');
    btns.forEach(b => b.classList.remove('active'));
    
    let matchText = '自由';
    if (targetRatio === 1) matchText = '1:1';
    else if (targetRatio !== null && Math.abs(targetRatio - 1.5) < 0.01) matchText = '3:2';
    else if (targetRatio !== null && Math.abs(targetRatio - 1.3333) < 0.01) matchText = '4:3';
    else if (targetRatio !== null && Math.abs(targetRatio - 1.7777) < 0.01) matchText = '16:9';
    
    for(let b of btns) {
        if(b.innerText === matchText) b.classList.add('active');
    }

    if (state.cropAspect !== null) {
        const W = state.width;
        const H = state.height;
        let w = W;
        let h = w / state.cropAspect;

        if (h > H) {
            h = H;
            w = h * state.cropAspect;
        }
        
        const left = (W - w) / 2;
        const top = (H - h) / 2;

        cropBox.style.left = left + 'px';
        cropBox.style.top = top + 'px';
        cropBox.style.width = w + 'px';
        cropBox.style.height = h + 'px';
    }
}

function cancelCrop() {
    state.isCropping = false;
    document.getElementById('normalTools').classList.remove('hidden');
    document.getElementById('cropTools').classList.add('hidden');
    cropLayer.classList.remove('active');
    document.getElementById('compare-slider-handle').style.display = 'flex';
}

function applyCrop() {
    const w = state.width;
    const h = state.height;
    let cx = cropBox.offsetLeft;
    let cy = cropBox.offsetTop;
    let cw = cropBox.offsetWidth;
    let ch = cropBox.offsetHeight;

    cx = Math.max(0, cx); cy = Math.max(0, cy);
    cw = Math.min(w - cx, cw); ch = Math.min(h - cy, ch);

    if (cw < 10 || ch < 10) return showToast('裁切範圍太小');

    const newC = document.createElement('canvas');
    newC.width = cw; newC.height = ch;
    const nCtx = newC.getContext('2d');
    nCtx.drawImage(state.img, cx, cy, cw, ch, 0, 0, cw, ch);

    const newImg = new Image();
    newImg.onload = () => {
        state.img = newImg;
        state.width = cw; state.height = ch;
        state.mainCanvas.width = cw; state.mainCanvas.height = ch;
        state.offscreenCanvas.width = cw; state.offscreenCanvas.height = ch;
        
        cancelCrop(); 
        fitToScreen(); 
        
        pushHistory('image');
        
        requestRender();
        showToast('已裁切');
    };
    newImg.src = newC.toDataURL();
}

cropLayer.addEventListener('mousedown', (e) => {
    if(!state.isCropping) return;
    e.stopPropagation();
    isDragCrop = true;
    cropStartMouse = {x: e.clientX, y: e.clientY};
    cropStartBox = {
        x: cropBox.offsetLeft, y: cropBox.offsetTop,
        w: cropBox.offsetWidth, h: cropBox.offsetHeight
    };
    
    if (e.target.classList.contains('crop-handle')) {
        cropAction = e.target.getAttribute('data-dir');
    } else if (e.target === cropBox) {
        cropAction = 'move';
    } else {
        isDragCrop = false; 
    }
});

window.addEventListener('mousemove', (e) => {
    if (!isDragCrop || !state.isCropping) return;
    e.preventDefault();
    
    const dx = (e.clientX - cropStartMouse.x) / state.scale;
    const dy = (e.clientY - cropStartMouse.y) / state.scale;

    let nx = cropStartBox.x;
    let ny = cropStartBox.y;
    let nw = cropStartBox.w;
    let nh = cropStartBox.h;

    if (cropAction === 'move') {
        nx += dx; ny += dy;
        if (nx < 0) nx = 0;
        if (ny < 0) ny = 0;
        if (nx + nw > state.width) nx = state.width - nw;
        if (ny + nh > state.height) ny = state.height - nh;
    } else {
        // Resize Logic with Strict Aspect Ratio Protection
        if (cropAction === 'se') {
            nw += dx; nh += dy;
        } else if (cropAction === 'sw') {
            nx += dx; nw -= dx; nh += dy;
        } else if (cropAction === 'ne') {
            ny += dy; nh -= dy; nw += dx;
        } else if (cropAction === 'nw') {
            nx += dx; nw -= dx; ny += dy; nh -= dy;
        }

        if (state.cropAspect) {
             // 簡化邏輯
             if(nw<20)nw=20; nh=nw/state.cropAspect;
        }
    }

    cropBox.style.left = nx + 'px';
    cropBox.style.top = ny + 'px';
    cropBox.style.width = nw + 'px';
    cropBox.style.height = nh + 'px';
});

window.addEventListener('mouseup', () => {
    isDragCrop = false;
});


// --- 核心演算法 ---
function renderFilterList() {
    const list = document.getElementById('filterList');
    list.innerHTML = '';
    const all = [...BASE_FILTERS, ...state.builtInLuts, ...state.uploadedLuts];
    
    all.forEach(f => {
        const btn = document.createElement('div');
        const active = f.id === state.filterId ? 'active-filter' : 'hover:bg-gray-100 border-transparent';
        btn.className = `p-3 rounded-lg border cursor-pointer transition flex items-center gap-3 mb-2 ${active}`;
        btn.onclick = () => {
            state.filterId = f.id;
            renderFilterList();
            pushHistory();
            requestRender();
        };
        
        const isLut = f.lutSize > 0;
        btn.innerHTML = `
            <div class="w-10 h-10 rounded bg-gray-200 flex items-center justify-center text-gray-500 flex-shrink-0 overflow-hidden">
                ${isLut ? '<i data-lucide="grid" class="w-5 h-5"></i>' : '<i data-lucide="image" class="w-5 h-5"></i>'}
            </div>
            <div>
                <div class="text-xs font-semibold text-text">${f.name}</div>
                <div class="text-[10px] text-subtext">${f.desc || '預設'}</div>
            </div>
        `;
        list.appendChild(btn);
    });
    lucide.createIcons();
}
renderFilterList();

// 比較滑桿邏輯
const handle = document.getElementById('compare-slider-handle');
let draggingHandle = false;

handle.addEventListener('mousedown', (e) => {
    draggingHandle = true; e.stopPropagation();
});
window.addEventListener('mousemove', (e) => {
    if(draggingHandle && state.img && !state.isCropping) {
        const rect = state.mainCanvas.getBoundingClientRect();
        let x = e.clientX - rect.left;
        state.splitPos = Math.max(0, Math.min(1, x / rect.width));
        updateHandle();
        drawComposite();
    }
});
window.addEventListener('mouseup', () => draggingHandle = false);

function updateHandle() {
    handle.style.left = (state.splitPos * 100) + '%';
}


// --- 圖像處理管線 ---
let renderReq = null;
function requestRender() {
    if (!state.img) return;
    if (renderReq) cancelAnimationFrame(renderReq);
    document.getElementById('loader').classList.remove('hidden');
    renderReq = requestAnimationFrame(renderProcess);
}

function renderProcess() {
    const w = state.width;
    const h = state.height;
    const ctx = state.offCtx;
    const p = state.params;
    
    const all = [...BASE_FILTERS, ...state.builtInLuts, ...state.uploadedLuts];
    const currentFilter = all.find(f => f.id === state.filterId) || BASE_FILTERS[0];
    const fConf = currentFilter.conf || {};
    const isLutActive = currentFilter.lutData && p.lutAmount > 0;
    const lutData = currentFilter.lutData;
    const lutSize = currentFilter.lutSize;
    const lutAmount = p.lutAmount / 100;

    ctx.drawImage(state.img, 0, 0, w, h);
    let imgData = ctx.getImageData(0, 0, w, h);
    let d = imgData.data;
    const originalData = new Uint8ClampedArray(d);

    // Pre-calc factors
    const exp = Math.pow(2, (p.exposure + (fConf.exp||0)) / 100);
    const conVal = p.contrast + (fConf.con||0);
    const conFactor = (259 * (conVal + 255)) / (255 * (259 - conVal));
    const hVal = p.highlights / 100 * 255 * 0.5;
    const sVal = -p.shadows / 100 * 255 * 0.5; 
    
    const satMult = 1 + ((p.sat + (fConf.sat||0)) / 100);
    const vibVal = (p.vib + (fConf.vib||0)) / 100;
    
    const inputTemp = (p.temp + (fConf.temp||0)) * 0.15;
    const inputTint = (p.tint + (fConf.tint||0)) * 0.08;
    let rAdj=0, gAdj=0, bAdj=0;
    if(inputTemp > 0) { rAdj = inputTemp*1.2; gAdj = inputTemp*0.4; bAdj = -inputTemp*0.8; }
    else { bAdj = Math.abs(inputTemp)*1.2; rAdj = -Math.abs(inputTemp)*0.5; }
    gAdj += inputTint * 2;

    const adjustedData = new Uint8ClampedArray(d.length);

    for (let i = 0; i < d.length; i += 4) {
        let r = originalData[i], g = originalData[i+1], b = originalData[i+2];

        // 1. Exposure
        r *= exp; g *= exp; b *= exp;
        
        // 2. Contrast
        r = conFactor*(r-128)+128; g = conFactor*(g-128)+128; b = conFactor*(b-128)+128;
        
        // 3. Highlights / Shadows
        const L = 0.299*r + 0.587*g + 0.114*b;
        if (p.shadows !== 0) {
            const shadowInfluence = Math.max(0, (128 - L) / 128); 
            const d = sVal * shadowInfluence;
            r += d; g += d; b += d;
        }
        if (p.highlights !== 0) {
            const highlightInfluence = Math.max(0, (L - 128) / 128); 
            const d = hVal * highlightInfluence;
            r += d; g += d; b += d;
        }

        // Clamp before color ops
        r = Math.max(0,Math.min(255,r)); g = Math.max(0,Math.min(255,g)); b = Math.max(0,Math.min(255,b)); 
        
        // 4. White Balance
        r += rAdj; g += gAdj; b += bAdj;

        // 5. Saturation & Vibrance
        const avg = (r + g + b) / 3;
        
        if (satMult !== 1) {
            r = avg + (r - avg) * satMult;
            g = avg + (g - avg) * satMult;
            b = avg + (b - avg) * satMult;
        }

        if (vibVal !== 0) {
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            const currentSat = max === 0 ? 0 : (max - min) / max;
            
            if (vibVal > 0) {
                const boost = vibVal * (1 - Math.pow(currentSat, 2)); 
                const factor = 1 + boost;
                r = avg + (r - avg) * factor;
                g = avg + (g - avg) * factor;
                b = avg + (b - avg) * factor;
            } else {
                const factor = 1 + vibVal;
                r = avg + (r - avg) * factor;
                g = avg + (g - avg) * factor;
                b = avg + (b - avg) * factor;
            }
        }
        
        adjustedData[i] = Math.max(0,Math.min(255,r)); 
        adjustedData[i+1] = Math.max(0,Math.min(255,g)); 
        adjustedData[i+2] = Math.max(0,Math.min(255,b));
        adjustedData[i+3] = originalData[i+3];
    }

    // LUT
    if (isLutActive) {
        const N = lutSize; const N_1 = N - 1;
        for (let i = 0; i < d.length; i += 4) {
            const r_in = adjustedData[i]; 
            const g_in = adjustedData[i+1]; 
            const b_in = adjustedData[i+2];
            
            // 簡單線性插值優化
            const ri = Math.round((r_in / 255) * N_1);
            const gi = Math.round((g_in / 255) * N_1);
            const bi = Math.round((b_in / 255) * N_1);
            
            const idx = (bi * N * N + gi * N + ri) * 3;
            
            const r_lut = lutData[idx]; 
            const g_lut = lutData[idx+1]; 
            const b_lut = lutData[idx+2];
            
            d[i] = Math.max(0,Math.min(255, r_in + (r_lut - r_in) * lutAmount));
            d[i+1] = Math.max(0,Math.min(255, g_in + (g_lut - g_in) * lutAmount));
            d[i+2] = Math.max(0,Math.min(255, b_in + (b_lut - b_in) * lutAmount));
            d[i+3] = 255;
        }
    } else {
        d.set(adjustedData);
    }

    ctx.putImageData(imgData, 0, 0);

    // Effects
    if(p.soft > 0) {
        const maskC = document.createElement('canvas'); maskC.width = w; maskC.height = h;
        const mCtx = maskC.getContext('2d');
        mCtx.drawImage(state.offscreenCanvas,0,0);
        const mD = mCtx.getImageData(0,0,w,h); const md=mD.data;
        for(let k=0; k<md.length; k+=4) {
            const l = 0.299*md[k]+0.587*md[k+1]+0.114*md[k+2];
            md[k+3] = l < 140 ? 0 : Math.min(255,(l-140)*3);
        }
        mCtx.putImageData(mD,0,0);
        const blurC = document.createElement('canvas'); blurC.width = w/2; blurC.height = h/2;
        const bCtx = blurC.getContext('2d');
        bCtx.filter = `blur(${Math.max(2, w/100)}px)`;
        bCtx.drawImage(maskC,0,0,w/2,h/2);
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = (p.soft/100)*1.2;
        ctx.drawImage(blurC,0,0,w,h);
        ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    }

    if(p.grain > 0) {
        const d2 = ctx.getImageData(0,0,w,h); const dd = d2.data;
        const f = p.grain * 0.4;
        for(let i=0; i<dd.length; i+=4) {
            const n = (Math.random()-0.5)*f;
            dd[i]+=n; dd[i+1]+=n; dd[i+2]+=n;
        }
        ctx.putImageData(d2,0,0);
    }

    drawComposite();
    document.getElementById('loader').classList.add('hidden');
}

function drawComposite() {
    if(!state.img) return;
    const w = state.width, h = state.height;
    const splitPos = state.isCropping ? 1 : state.splitPos;
    const splitX = splitPos * w;
    
    state.ctx.clearRect(0,0,w,h);
    state.ctx.drawImage(state.offscreenCanvas, 0, 0);
    
    if (!state.isCropping) {
        state.ctx.save();
        state.ctx.beginPath();
        state.ctx.rect(0, 0, splitX, h);
        state.ctx.clip();
        state.ctx.drawImage(state.img, 0, 0, w, h);
        state.ctx.restore();
    }
}

// History
function pushHistory(type = 'param') {
    if (state.historyIndex < state.history.length - 1) {
        state.history = state.history.slice(0, state.historyIndex + 1);
    }
    
    const snapshot = { 
        type: type, 
        params: JSON.parse(JSON.stringify(state.params)), 
        filterId: state.filterId 
    };
    
    if (type === 'image') {
        snapshot.imgData = state.img.src;
    }

    state.history.push(snapshot);
    state.historyIndex++;
    updateHistoryBtns();
}

function undo() {
    if (state.historyIndex > 0) {
        state.historyIndex--;
        applyHistory();
    }
}

function redo() {
    if (state.historyIndex < state.history.length - 1) {
        state.historyIndex++;
        applyHistory();
    }
}

function applyHistory() {
    const snap = state.history[state.historyIndex];
    
    if (snap.type === 'image' && snap.imgData) {
        const tempImg = new Image();
        tempImg.onload = () => {
            state.img = tempImg;
            state.width = tempImg.width; 
            state.height = tempImg.height;
            state.mainCanvas.width = state.width; state.mainCanvas.height = state.height;
            state.offscreenCanvas.width = state.width; state.offscreenCanvas.height = state.height;
            
            _applyParams(snap);
        };
        tempImg.src = snap.imgData;
    } else {
        let imgSnap = null;
        for(let i = state.historyIndex; i >= 0; i--) {
            if (state.history[i].type === 'image') {
                imgSnap = state.history[i];
                break;
            }
        }
        
        if (imgSnap && imgSnap.imgData && state.img.src !== imgSnap.imgData) {
                const tempImg = new Image();
            tempImg.onload = () => {
                state.img = tempImg;
                state.width = tempImg.width; 
                state.height = tempImg.height;
                state.mainCanvas.width = state.width; state.mainCanvas.height = state.height;
                state.offscreenCanvas.width = state.width; state.offscreenCanvas.height = state.height;
                _applyParams(snap);
                fitToScreen(); 
            };
            tempImg.src = imgSnap.imgData;
            return;
        }

        _applyParams(snap);
    }
}

function _applyParams(snap) {
    state.params = JSON.parse(JSON.stringify(snap.params));
    state.filterId = snap.filterId;
    updateUIFromParams();
    renderFilterList();
    requestRender();
    updateHistoryBtns();
}

function updateHistoryBtns() {
    document.getElementById('undoBtn').disabled = state.historyIndex <= 0;
    document.getElementById('redoBtn').disabled = state.historyIndex >= state.history.length - 1;
    document.getElementById('undoBtn').style.opacity = state.historyIndex <= 0 ? 0.3 : 1;
    document.getElementById('redoBtn').style.opacity = state.historyIndex >= state.history.length - 1 ? 0.3 : 1;
}

function updateUIFromParams() {
    Object.keys(state.params).forEach(k => {
        const el = document.getElementById(k);
        if(el) {
            el.value = state.params[k];
            document.getElementById(`val-${k}`).innerText = state.params[k];
        }
    });
}

function showToast(msg) {
    const t = document.createElement('div');
    t.className = 'toast show'; t.innerText = msg;
    document.getElementById('toast-container').appendChild(t);
    setTimeout(() => { t.classList.remove('show'); setTimeout(()=>t.remove(),300)}, 2000);
}

document.getElementById('fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0]; if(f) loadImageFile(f); e.target.value = null;
});

function loadImageFile(file) {
    const reader = new FileReader();
    reader.onload = (evt) => {
        const img = new Image();
        img.onload = () => {
            state.img = img;
            const MAX = 4096;
            let w = img.width, h = img.height;
            if(w>MAX||h>MAX) { const r = Math.min(MAX/w,MAX/h); w*=r; h*=r; }
            state.width = Math.floor(w); state.height = Math.floor(h);
            state.mainCanvas.width = state.width; state.mainCanvas.height = state.height;
            state.offscreenCanvas.width = state.width; state.offscreenCanvas.height = state.height;
            
            document.getElementById('emptyState').classList.add('opacity-0', 'pointer-events-none');
            canvasContainer.style.display = 'block';
            
            zoomControlPanel.classList.add('visible');
            bottomToolbar.classList.add('visible');

            state.history = []; state.historyIndex = -1;
            
            fitToScreen();
            
            pushHistory('image');
            
            requestRender();
            showToast('圖片已載入');
        };
        img.src = evt.target.result;
    };
    reader.readAsDataURL(file);
}

document.getElementById('lutFileInput').addEventListener('change', (e) => {
    const f = e.target.files[0]; if(f) loadLutFile(f); e.target.value = null;
});

function loadLutFile(file) {
    const r = new FileReader();
    r.onload = (evt) => {
        const txt = evt.target.result;
        const lines = txt.split('\n'); let size=0, title=file.name.replace('.cube',''); const data=[];
        for(let l of lines) {
            l=l.trim(); if(!l||l.startsWith('#')) continue;
            if(l.startsWith('LUT_3D_SIZE')) size=parseInt(l.split(/\s+/)[1]);
            else { const parts=l.split(/\s+/).map(Number); if(parts.length===3) data.push(...parts); }
        }
        if(size>0 && data.length===size**3*3) {
            const lutData = data.map(v => Math.min(255,Math.max(0,v*255)));
            state.uploadedLuts.push({ id:Date.now(), name:title, lutData, lutSize:size, desc:'自定義 LUT' });
            renderFilterList();
            showToast('LUT 已匯入');
        } else showToast('無效的 LUT 檔案');
    };
    r.readAsText(file);
}

document.getElementById('exportBtn').addEventListener('click', () => {
    if(!state.img) return showToast('沒有圖片可匯出');
    const link = document.createElement('a');
    link.download = `ABAI_Pro_${Date.now()}.jpg`;
    link.href = state.offscreenCanvas.toDataURL('image/jpeg', 0.95);
    link.click();
    showToast('正在匯出...');
});

document.getElementById('resetBtn').addEventListener('click', () => {
    state.params = { exposure:0, contrast:0, highlights:0, shadows:0, temp:0, tint:0, sat:0, vib:0, soft:50, grain:0, lutAmount: 100 };
    state.filterId = 0;
    updateUIFromParams();
    renderFilterList();
    pushHistory();
    requestRender();
    showToast('已重置所有設定');
});

const sIds = ['exposure','contrast','highlights','shadows','temp','tint','sat','vib','soft','grain','lutAmount'];
sIds.forEach(id => {
    const el = document.getElementById(id);
    if(!el) return;
    el.addEventListener('input', (e) => {
        let val = parseFloat(e.target.value);
        state.params[id] = val;
        document.getElementById(`val-${id}`).innerText = val;
        requestRender();
    });
    el.addEventListener('change', () => {
        pushHistory('param');
    });
    el.addEventListener('dblclick', () => {
        const def = (id==='lutAmount'?100:id==='soft'?50:0);
        state.params[id] = def;
        el.value = def;
        document.getElementById(`val-${id}`).innerText = def;
        pushHistory('param');
        requestRender();
    });
});