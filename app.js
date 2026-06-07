// State
let pdfDoc = null;
let pageNum = 1;
let pageRendering = false;
let pageNumPending = null;
let scale = 1.0;
let fabricCanvas = null;
let currentTool = 'select'; // select, draw, text, image

// Store edits per page
let pageStates = {}; // { pageNum: { canvasJson: string, history: array, historyIndex: number } }

// History for undo/redo
let history = [];
let historyIndex = -1;
let isHistoryAction = false;

// Panning variables
let isPanning = false;
let lastPosX = 0;
let lastPosY = 0;

// Touch gesture variables
let lastTouchDistance = 0;
let lastTouchCenter = null;

// DOM Elements
const dropZone = document.getElementById('drop-zone');
const pdfUpload = document.getElementById('pdf-upload');
const canvasContainer = document.getElementById('canvas-container');
const canvasWrapper = document.getElementById('canvas-wrapper');
const pdfCanvas = document.getElementById('pdf-canvas');
const ctx = pdfCanvas.getContext('2d');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');

// Initialize
function init() {
    setupDragAndDrop();
    setupToolbar();
    setupKeyboardShortcuts();
    window.addEventListener('resize', () => {
        if (pdfDoc && fabricCanvas) {
            fitCanvasToView();
        }
    });
}

function showLoading(text) {
    loadingText.textContent = text;
    loadingOverlay.style.display = 'flex';
}

function hideLoading() {
    loadingOverlay.style.display = 'none';
}

// -------------------------
// Drag and Drop & PDF Load
// -------------------------
function setupDragAndDrop() {
    dropZone.addEventListener('click', () => pdfUpload.click());
    
    pdfUpload.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            loadPdf(e.target.files[0]);
        }
    });

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) {
            if (e.dataTransfer.files[0].type === 'application/pdf') {
                loadPdf(e.dataTransfer.files[0]);
            } else {
                alert('Please drop a valid PDF file.');
            }
        }
    });
}

let currentPdfBytes = null;

async function loadPdf(file) {
    showLoading('Loading PDF...');
    dropZone.style.display = 'none';
    canvasContainer.style.display = 'flex';

    try {
        const fileReader = new FileReader();
        fileReader.onload = async function() {
            // Store a deep copy for export so pdf.js doesn't detach the buffer
            currentPdfBytes = new Uint8Array(this.result.slice(0));

            const typedarray = new Uint8Array(this.result.slice(0));
            const loadingTask = pdfjsLib.getDocument(typedarray);
            pdfDoc = await loadingTask.promise;
            
            document.getElementById('total-pages').textContent = pdfDoc.numPages;
            
            // Initialize Fabric canvas once
            if (!fabricCanvas) {
                fabricCanvas = new fabric.Canvas('fabric-canvas', {
                    isDrawingMode: false,
                    fireRightClick: true,
                    stopContextMenu: true
                });
                setupFabricCanvas();
                setupZoomAndPan();
            }

            renderPage(pageNum);
        };
        fileReader.readAsArrayBuffer(file);
    } catch (error) {
        console.error('Error loading PDF:', error);
        alert('Error loading PDF.');
        hideLoading();
    }
}

function renderPage(num) {
    pageRendering = true;
    
    pdfDoc.getPage(num).then(function(page) {
        // Use a standard scale for rendering the PDF to canvas
        const viewport = page.getViewport({scale: 1.5}); // base scale
        
        pdfCanvas.height = viewport.height;
        pdfCanvas.width = viewport.width;
        
        canvasWrapper.style.width = `${viewport.width}px`;
        canvasWrapper.style.height = `${viewport.height}px`;

        // Update fabric canvas size
        fabricCanvas.setDimensions({
            width: viewport.width,
            height: viewport.height
        });

        const renderContext = {
            canvasContext: ctx,
            viewport: viewport
        };
        
        const renderTask = page.render(renderContext);

        renderTask.promise.then(function() {
            pageRendering = false;
            hideLoading();
            
            if (pageNumPending !== null) {
                renderPage(pageNumPending);
                pageNumPending = null;
            }

            // Clear fabric canvas and history for new page
            fabricCanvas.clear();
            
            // Set pdfCanvas as background image for native fabric zooming
            const bgImg = new fabric.Image(pdfCanvas);
            fabricCanvas.setBackgroundImage(bgImg, fabricCanvas.renderAll.bind(fabricCanvas));

            if (pageStates[num]) {
                // Restore state for this page
                history = [...pageStates[num].history];
                historyIndex = pageStates[num].historyIndex;
                isHistoryAction = true;
                fabricCanvas.loadFromJSON(pageStates[num].canvasJson, function() {
                    fabricCanvas.setBackgroundImage(bgImg, fabricCanvas.renderAll.bind(fabricCanvas));
                    isHistoryAction = false;
                    fabricCanvas.renderAll();
                });
            } else {
                // Initial state for new page
                history = [];
                historyIndex = -1;
                saveHistory(); 
            }

            document.getElementById('current-page').textContent = num;
            updatePageControls();
            
            canvasWrapper.style.transform = 'none';
            canvasWrapper.style.left = '0px';
            canvasWrapper.style.top = '0px';
            fitCanvasToView();
        });
    });
}

function fitCanvasToView() {
    if (!fabricCanvas || !pdfDoc) return;

    const container = document.getElementById('canvas-container');
    const canvasW = fabricCanvas.getWidth();
    const canvasH = fabricCanvas.getHeight();
    const padding = 16;
    const availW = container.clientWidth - padding;
    const availH = container.clientHeight - padding;

    const scaleX = availW / canvasW;
    const scaleY = availH / canvasH;
    const fitZoom = Math.min(scaleX, scaleY, 1);

    const offsetX = (availW - canvasW * fitZoom) / 2 + padding / 2;
    const offsetY = (availH - canvasH * fitZoom) / 2 + padding / 2;

    fabricCanvas.setViewportTransform([fitZoom, 0, 0, fitZoom, offsetX, offsetY]);
    fabricCanvas.requestRenderAll();
}

function queueRenderPage(num) {
    if (pageRendering) {
        pageNumPending = num;
    } else {
        renderPage(num);
    }
}

function updatePageControls() {
    document.getElementById('btn-prev-page').disabled = pageNum <= 1;
    document.getElementById('btn-next-page').disabled = pageNum >= pdfDoc.numPages;
}

// -------------------------
// Fabric & Tools
// -------------------------
function setupFabricCanvas() {
    fabricCanvas.on('object:added', () => { if(!isHistoryAction) saveHistory(); });
    fabricCanvas.on('object:modified', () => { if(!isHistoryAction) saveHistory(); });
    fabricCanvas.on('object:removed', () => { if(!isHistoryAction) saveHistory(); });

    fabricCanvas.freeDrawingBrush.color = document.getElementById('color-picker').value;
    fabricCanvas.freeDrawingBrush.width = parseInt(document.getElementById('brush-size').value, 10);

    // Click handler for text addition
    fabricCanvas.on('mouse:down', function(options) {
        if (currentTool === 'text' && !options.target) {
            const pointer = fabricCanvas.getPointer(options.e);
            const text = new fabric.IText('Double click to edit', {
                left: pointer.x,
                top: pointer.y,
                fill: document.getElementById('color-picker').value,
                fontSize: 20
            });
            fabricCanvas.add(text);
            fabricCanvas.setActiveObject(text);
            text.enterEditing();
            text.selectAll();
            setTool('select'); // Auto-switch back to select
        }
    });
}

function saveCurrentPageState() {
    if (!fabricCanvas) return;
    
    // Temporarily remove background to save ONLY the overlay objects
    const bg = fabricCanvas.backgroundImage;
    fabricCanvas.backgroundImage = null;
    
    // Reset viewport temporarily
    const vpt = fabricCanvas.viewportTransform.slice();
    fabricCanvas.setViewportTransform([1,0,0,1,0,0]);

    pageStates[pageNum] = {
        canvasJson: JSON.stringify(fabricCanvas.toDatalessJSON()),
        history: [...history],
        historyIndex: historyIndex,
        width: fabricCanvas.getWidth(),
        height: fabricCanvas.getHeight()
    };

    // Restore viewport and background
    fabricCanvas.setViewportTransform(vpt);
    fabricCanvas.backgroundImage = bg;
}

function setupToolbar() {
    document.getElementById('btn-prev-page').addEventListener('click', () => {
        if (pageNum <= 1) return;
        saveCurrentPageState();
        pageNum--;
        showLoading('Rendering...');
        queueRenderPage(pageNum);
    });

    document.getElementById('btn-next-page').addEventListener('click', () => {
        if (pageNum >= pdfDoc.numPages) return;
        saveCurrentPageState();
        pageNum++;
        showLoading('Rendering...');
        queueRenderPage(pageNum);
    });

    document.getElementById('btn-select').addEventListener('click', () => setTool('select'));
    document.getElementById('btn-draw').addEventListener('click', () => setTool('draw'));
    document.getElementById('btn-text').addEventListener('click', () => setTool('text'));
    
    document.getElementById('btn-image').addEventListener('click', () => {
        document.getElementById('image-upload').click();
    });

    document.getElementById('image-upload').addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function(f) {
            const data = f.target.result;
            fabric.Image.fromURL(data, function(img) {
                img.scaleToWidth(200);
                fabricCanvas.add(img);
                fabricCanvas.centerObject(img);
                fabricCanvas.setActiveObject(img);
                setTool('select');
            });
        };
        reader.readAsDataURL(file);
        this.value = null; // reset
    });

    document.getElementById('btn-delete').addEventListener('click', deleteSelected);

    document.getElementById('color-picker').addEventListener('input', (e) => {
        const color = e.target.value;
        if (fabricCanvas) {
            fabricCanvas.freeDrawingBrush.color = color;
            const activeObj = fabricCanvas.getActiveObject();
            if (activeObj && activeObj.set) {
                activeObj.set('fill', color);
                fabricCanvas.renderAll();
            }
        }
    });

    document.getElementById('brush-size').addEventListener('input', (e) => {
        if (fabricCanvas) {
            fabricCanvas.freeDrawingBrush.width = parseInt(e.target.value, 10);
        }
    });

    document.getElementById('btn-undo').addEventListener('click', undo);
    document.getElementById('btn-redo').addEventListener('click', redo);

    document.getElementById('btn-download').addEventListener('click', downloadPdf);
}

function setTool(tool) {
    currentTool = tool;
    document.querySelectorAll('.tool-group button').forEach(b => b.classList.remove('active'));
    document.getElementById(`btn-${tool}`).classList.add('active');

    if (fabricCanvas) {
        fabricCanvas.isDrawingMode = (tool === 'draw');
        if (tool === 'select') {
            fabricCanvas.selection = true;
            fabricCanvas.forEachObject(o => o.selectable = true);
        } else {
            // Disable selection for text tool so we can click to add
            fabricCanvas.selection = false;
            if(tool === 'text') {
                fabricCanvas.forEachObject(o => o.selectable = false);
            }
        }
    }
}

function deleteSelected() {
    if (!fabricCanvas) return;
    const activeObjects = fabricCanvas.getActiveObjects();
    if (activeObjects.length) {
        fabricCanvas.discardActiveObject();
        activeObjects.forEach(function(object) {
            fabricCanvas.remove(object);
        });
    }
}

// -------------------------
// Zoom and Pan (Fabric Native)
// -------------------------
function setupZoomAndPan() {
    const container = document.getElementById('canvas-container');

    fabricCanvas.on('mouse:wheel', function(opt) {
        if (!pdfDoc) return;
        var delta = opt.e.deltaY;
        var zoom = fabricCanvas.getZoom();
        
        // Zoom intensity
        zoom *= 0.999 ** delta;
        
        // Limit zoom
        if (zoom > 5) zoom = 5;
        if (zoom < 0.2) zoom = 0.2;
        
        // Zoom to pointer
        fabricCanvas.zoomToPoint({ x: opt.e.offsetX, y: opt.e.offsetY }, zoom);
        
        opt.e.preventDefault();
        opt.e.stopPropagation();
    });

    fabricCanvas.on('mouse:down', function(opt) {
        var evt = opt.e;
        if (evt.button === 2) { // Right click
            this.isDragging = true;
            this.selection = false;
            this.lastPosX = evt.clientX;
            this.lastPosY = evt.clientY;
            container.style.cursor = 'grab';
        }
    });

    fabricCanvas.on('mouse:move', function(opt) {
        if (this.isDragging) {
            var e = opt.e;
            var vpt = this.viewportTransform;
            vpt[4] += e.clientX - this.lastPosX;
            vpt[5] += e.clientY - this.lastPosY;
            this.requestRenderAll();
            this.lastPosX = e.clientX;
            this.lastPosY = e.clientY;
        }
    });

    fabricCanvas.on('mouse:up', function(opt) {
        var evt = opt.e;
        if (evt.button === 2) {
            // on mouse up we want to recalculate new interaction
            // for all objects, so we call setViewportTransform
            this.setViewportTransform(this.viewportTransform);
            this.isDragging = false;
            
            if (currentTool === 'select') {
                this.selection = true;
            }
            container.style.cursor = 'default';
        }
    });

    // Prevent context menu on right click in container
    container.addEventListener('contextmenu', e => e.preventDefault());

    setupTouchGestures(container);
}

function getTouchDistance(t1, t2) {
    return Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
}

function getTouchCenter(t1, t2) {
    return {
        x: (t1.clientX + t2.clientX) / 2,
        y: (t1.clientY + t2.clientY) / 2
    };
}

function setupTouchGestures(container) {
    container.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
            e.preventDefault();
            lastTouchDistance = getTouchDistance(e.touches[0], e.touches[1]);
            lastTouchCenter = getTouchCenter(e.touches[0], e.touches[1]);
        }
    }, { passive: false });

    container.addEventListener('touchmove', (e) => {
        if (e.touches.length !== 2 || !pdfDoc) return;
        e.preventDefault();

        const dist = getTouchDistance(e.touches[0], e.touches[1]);
        const center = getTouchCenter(e.touches[0], e.touches[1]);
        const rect = container.getBoundingClientRect();
        const pointer = {
            x: center.x - rect.left,
            y: center.y - rect.top
        };

        if (lastTouchDistance > 0) {
            let zoom = fabricCanvas.getZoom() * (dist / lastTouchDistance);
            if (zoom > 5) zoom = 5;
            if (zoom < 0.2) zoom = 0.2;
            fabricCanvas.zoomToPoint(pointer, zoom);
        }

        if (lastTouchCenter) {
            const vpt = fabricCanvas.viewportTransform;
            vpt[4] += center.x - lastTouchCenter.x;
            vpt[5] += center.y - lastTouchCenter.y;
            fabricCanvas.setViewportTransform(vpt);
        }

        lastTouchDistance = dist;
        lastTouchCenter = center;
        fabricCanvas.requestRenderAll();
    }, { passive: false });

    container.addEventListener('touchend', () => {
        lastTouchDistance = 0;
        lastTouchCenter = null;
    });
}


// -------------------------
// Undo / Redo
// -------------------------
function saveHistory() {
    if (!fabricCanvas) return;
    
    // Don't serialize background image
    const bg = fabricCanvas.backgroundImage;
    fabricCanvas.backgroundImage = null;
    
    const state = JSON.stringify(fabricCanvas.toDatalessJSON());
    
    fabricCanvas.backgroundImage = bg;

    // Remove future states if we are saving a new state after an undo
    if (historyIndex < history.length - 1) {
        history = history.slice(0, historyIndex + 1);
    }
    history.push(state);
    historyIndex++;
}

function undo() {
    if (historyIndex > 0) {
        isHistoryAction = true;
        historyIndex--;
        const bg = fabricCanvas.backgroundImage;
        fabricCanvas.loadFromJSON(history[historyIndex], function() {
            fabricCanvas.setBackgroundImage(bg, fabricCanvas.renderAll.bind(fabricCanvas));
            isHistoryAction = false;
        });
    }
}

function redo() {
    if (historyIndex < history.length - 1) {
        isHistoryAction = true;
        historyIndex++;
        const bg = fabricCanvas.backgroundImage;
        fabricCanvas.loadFromJSON(history[historyIndex], function() {
            fabricCanvas.setBackgroundImage(bg, fabricCanvas.renderAll.bind(fabricCanvas));
            isHistoryAction = false;
        });
    }
}

function setupKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
        // Delete
        if (e.key === 'Delete' || e.key === 'Backspace') {
            // Check if editing text to not delete object
            const activeObj = fabricCanvas?.getActiveObject();
            if (activeObj && activeObj.isEditing) return;
            deleteSelected();
        }
        
        // Undo / Redo
        if (e.ctrlKey || e.metaKey) {
            if (e.key === 'z') {
                e.preventDefault();
                undo();
            } else if (e.key === 'y') {
                e.preventDefault();
                redo();
            }
        }
    });
}

// -------------------------
// PDF Export
// -------------------------
async function downloadPdf() {
    if (!pdfDoc || !currentPdfBytes) return;
    
    let fileName = window.prompt("Enter file name:", "edited_document.pdf");
    if (!fileName) return; // User cancelled
    
    if (!fileName.toLowerCase().endsWith('.pdf')) {
        fileName += '.pdf';
    }
    
    showLoading('Generating PDF...');
    
    try {
        saveCurrentPageState(); // Ensure current page edits are saved
        
        const { PDFDocument } = PDFLib;
        const pdfDocToExport = await PDFDocument.load(currentPdfBytes);
        const pages = pdfDocToExport.getPages();

        // Create a temporary static canvas for exporting without affecting the UI
        const exportCanvas = document.createElement('canvas');
        const exportFabric = new fabric.StaticCanvas(exportCanvas);

        for (let i = 0; i < pages.length; i++) {
            const pageNumIndex = i + 1;
            const state = pageStates[pageNumIndex];
            
            if (state) {
                exportFabric.setWidth(state.width);
                exportFabric.setHeight(state.height);
                
                // Load state into static canvas
                await new Promise(resolve => {
                    exportFabric.loadFromJSON(state.canvasJson, resolve);
                });

                if (exportFabric.getObjects().length > 0) {
                    exportFabric.renderAll();
                    
                    const fabricDataUrl = exportFabric.toDataURL({
                        format: 'png',
                        multiplier: 1
                    });
                    
                    const pngImage = await pdfDocToExport.embedPng(fabricDataUrl);
                    const currentPage = pages[i];
                    const { width, height } = currentPage.getSize();
                    
                    currentPage.drawImage(pngImage, {
                        x: 0,
                        y: 0,
                        width: width,
                        height: height,
                    });
                }
            }
        }

        const pdfBytes = await pdfDocToExport.save();
        
        // Download
        const blob = new Blob([pdfBytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
    } catch (error) {
        console.error('Error exporting PDF:', error);
        alert('Failed to generate PDF. Error: ' + (error.message || error));
    } finally {
        hideLoading();
    }
}

// Start
init();