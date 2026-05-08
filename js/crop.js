/**
 * 裁剪管理器类
 * 负责图片裁剪模式下的缩放、平移和完成/取消操作
 */
class CropManager {
    /**
     * 构造函数
     * @param {HTMLCanvasElement} canvas - 画布元素
     * @param {CanvasRenderingContext2D} ctx - 画布上下文
     * @param {PaintManager} paintManager - 画板管理器实例（可选）
     */
    constructor(canvas, ctx, paintManager = null) {
        this.canvas = canvas;
        this.ctx = ctx;
        this.paintManager = paintManager; // 用于在取消时恢复
        this.backgroundZoom = 1;          // 背景缩放倍数
        this.backgroundPanX = 0;           // 背景水平偏移
        this.backgroundPanY = 0;           // 背景垂直偏移
        this.isPanning = false;             // 是否正在拖拽
        this.lastPanX = 0;                 // 上次拖拽X坐标
        this.lastPanY = 0;                 // 上次拖拽Y坐标
        this.lastTouchDistance = 0;        // 触摸距离（双指缩放）
        
        // 绑定事件处理函数
        this.handleBackgroundZoom = this.handleBackgroundZoom.bind(this);
        this.handleBackgroundPanStart = this.handleBackgroundPanStart.bind(this);
        this.handleBackgroundPan = this.handleBackgroundPan.bind(this);
        this.handleBackgroundPanEnd = this.handleBackgroundPanEnd.bind(this);
        this.handleTouchStart = this.handleTouchStart.bind(this);
        this.handleTouchMove = this.handleTouchMove.bind(this);
    }

    /**
     * 重置所有状态
     */
    resetStates() {
        this.backgroundZoom = 1;
        this.backgroundPanX = 0;
        this.backgroundPanY = 0;
        this.isPanning = false;
        this.lastPanX = 0;
        this.lastPanY = 0;
        this.lastTouchDistance = 0;
    }

    /**
     * 检查当前是否处于裁剪模式
     * @returns {boolean}
     */
    isCropMode() {
        return this.canvas.parentNode.classList.contains('crop-mode');
    }

    /**
     * 退出裁剪模式
     */
    exitCropMode() {
        this.canvas.parentNode.classList.remove('crop-mode');
        setCanvasTitle("");
        
        // 移除事件监听
        this.canvas.removeEventListener('wheel', this.handleBackgroundZoom);
        this.canvas.removeEventListener('mousedown', this.handleBackgroundPanStart);
        this.canvas.removeEventListener('mousemove', this.handleBackgroundPan);
        this.canvas.removeEventListener('mouseup', this.handleBackgroundPanEnd);
        this.canvas.removeEventListener('mouseleave', this.handleBackgroundPanEnd);
        this.canvas.removeEventListener('touchstart', this.handleTouchStart);
        this.canvas.removeEventListener('touchmove', this.handleTouchMove);
        this.canvas.removeEventListener('touchend', this.handleBackgroundPanEnd);
        this.canvas.removeEventListener('touchcancel', this.handleBackgroundPanEnd);
        
        // 清除背景图片样式
        this.canvas.style.backgroundImage = '';
        this.canvas.style.backgroundSize = '';
        this.canvas.style.backgroundPosition = '';
        this.canvas.style.backgroundRepeat = '';
        
        // 恢复光标
        this.canvas.style.cursor = 'default';
    }

    /**
     * 初始化裁剪模式
     */
    initializeCrop() {
        const imageFile = document.getElementById('imageFile');
        if (!imageFile.files.length) {
            fillCanvas('white');
            return;
        }
        
        // 如果已经在裁剪模式，先退出
        if (this.isCropMode()) {
            this.exitCropMode();
        }
        
        this.resetStates();
        
        // 设置背景图片
        const file = imageFile.files[0];
        const url = URL.createObjectURL(file);
        this.canvas.style.backgroundImage = `url(${url})`;
        this.canvas.style.backgroundSize = '100%';
        this.canvas.style.backgroundPosition = '';
        this.canvas.style.backgroundRepeat = 'no-repeat';
        
        // 添加事件监听，注意 wheel、touchstart、touchmove 需要 passive: false 以允许 preventDefault
        this.canvas.addEventListener('wheel', this.handleBackgroundZoom, { passive: false });
        this.canvas.addEventListener('mousedown', this.handleBackgroundPanStart);
        this.canvas.addEventListener('mousemove', this.handleBackgroundPan);
        this.canvas.addEventListener('mouseup', this.handleBackgroundPanEnd);
        this.canvas.addEventListener('mouseleave', this.handleBackgroundPanEnd);
        this.canvas.addEventListener('touchstart', this.handleTouchStart, { passive: false });
        this.canvas.addEventListener('touchmove', this.handleTouchMove, { passive: false });
        this.canvas.addEventListener('touchend', this.handleBackgroundPanEnd);
        this.canvas.addEventListener('touchcancel', this.handleBackgroundPanEnd);
        
        // 清空画布内容（使背景图片可见）
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        setCanvasTitle("裁剪模式: 可用鼠标滚轮或双指触摸缩放图片");
        this.canvas.parentNode.classList.add('crop-mode');
        
        // 保存原始背景图URL以便后续清理（可选）
        this.currentBgUrl = url;
    }

    /**
     * 完成裁剪，将选定区域绘制到画布上
     * @param {Function} callback - 完成后的回调函数
     */
    finishCrop(callback) {
        const imageFile = document.getElementById('imageFile');
        if (!imageFile.files.length) return;
        
        const image = new Image();
        image.onload = () => {
            // 释放临时URL
            URL.revokeObjectURL(image.src);
            
            // 获取画布在页面上的实际尺寸（CSS尺寸）
            const fieldsetRect = this.canvas.getBoundingClientRect();
            // 计算背景图片原始尺寸与显示尺寸的比例
            // 注意：背景图片默认background-size:100% 宽度等于画布CSS宽度，高度自动
            // 但我们需要根据实际缩放比例计算源区域
            const scale = (image.width / fieldsetRect.width) / this.backgroundZoom;
            
            // 计算裁剪源区域（sx, sy, sWidth, sHeight）
            const sx = -this.backgroundPanX * scale;
            const sy = -this.backgroundPanY * scale;
            const sWidth = fieldsetRect.width * scale;
            const sHeight = fieldsetRect.height * scale;
            
            // 清空画布并绘制选定区域
            fillCanvas('white');
            this.ctx.drawImage(image, sx, sy, sWidth, sHeight, 0, 0, this.canvas.width, this.canvas.height);
            
            // 退出裁剪模式
            this.exitCropMode();
            
            // 执行回调
            if (callback) {
                callback();
            }
        };
        image.src = URL.createObjectURL(imageFile.files[0]);
    }

    /**
     * 取消裁剪，恢复画布内容（如果有paintManager则恢复，否则清空）
     */
    cancelCrop() {
        // 退出裁剪模式
        this.exitCropMode();
        
        // 如果有画板管理器，尝试恢复之前的画布状态
        if (this.paintManager && typeof this.paintManager.restoreFromHistory === 'function') {
            // 简单重绘所有内容（历史记录中保存了裁剪前的状态）
            this.paintManager.redrawAll();
        } else {
            // 否则清空画布为白色
            fillCanvas('white');
        }
        
        // 清除文件选择，避免残留
        const imageFile = document.getElementById('imageFile');
        if (imageFile) {
            imageFile.value = '';
        }
    }

    // ==================== 触摸事件处理 ====================
    handleTouchStart(e) {
        e.preventDefault();
        if (e.touches.length === 1) {
            this.handleBackgroundPanStart(e.touches[0]);
        } else if (e.touches.length === 2) {
            this.isPanning = false; // 双指缩放时停止拖拽
            this.lastTouchDistance = this.getTouchDistance(e.touches);
        }
    }

    handleTouchMove(e) {
        e.preventDefault();
        if (this.isPanning && e.touches.length === 1) {
            this.handleBackgroundPan(e.touches[0]);
        } else if (e.touches.length === 2) {
            const newDist = this.getTouchDistance(e.touches);
            if (this.lastTouchDistance > 0) {
                const zoomFactor = newDist / this.lastTouchDistance;
                this.backgroundZoom *= zoomFactor;
                // 限制缩放范围 0.1 ~ 5
                this.backgroundZoom = Math.max(0.1, Math.min(5, this.backgroundZoom));
                this.updateBackgroundTransform();
            }
            this.lastTouchDistance = newDist;
        }
    }

    // ==================== 鼠标/滚轮事件处理 ====================
    handleBackgroundZoom(e) {
        e.preventDefault();
        const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
        this.backgroundZoom *= zoomFactor;
        this.backgroundZoom = Math.max(0.1, Math.min(5, this.backgroundZoom));
        this.updateBackgroundTransform();
    }

    handleBackgroundPanStart(e) {
        this.isPanning = true;
        this.lastPanX = e.clientX;
        this.lastPanY = e.clientY;
        this.canvas.style.cursor = 'grabbing';
    }

    handleBackgroundPan(e) {
        if (!this.isPanning) return;
        const deltaX = e.clientX - this.lastPanX;
        const deltaY = e.clientY - this.lastPanY;
        this.backgroundPanX += deltaX;
        this.backgroundPanY += deltaY;
        this.lastPanX = e.clientX;
        this.lastPanY = e.clientY;
        this.updateBackgroundTransform();
    }

    handleBackgroundPanEnd() {
        this.isPanning = false;
        this.lastTouchDistance = 0;
        this.canvas.style.cursor = 'grab';
    }

    /**
     * 更新背景图片的变换（缩放和位置）
     */
    updateBackgroundTransform() {
        this.canvas.style.backgroundSize = `${100 * this.backgroundZoom}%`;
        this.canvas.style.backgroundPosition = `${this.backgroundPanX}px ${this.backgroundPanY}px`;
    }

    /**
     * 计算两个触摸点之间的距离
     * @param {TouchList} touches - 触摸点列表
     * @returns {number}
     */
    getTouchDistance(touches) {
        const dx = touches[1].clientX - touches[0].clientX;
        const dy = touches[1].clientY - touches[0].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    // ==================== 初始化裁剪工具按钮 ====================
    initCropTools() {
        // 放大按钮
        const zoomInBtn = document.getElementById('crop-zoom-in');
        if (zoomInBtn) {
            zoomInBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.handleBackgroundZoom({ preventDefault: () => {}, deltaY: -1 });
            });
        }
        
        // 缩小按钮
        const zoomOutBtn = document.getElementById('crop-zoom-out');
        if (zoomOutBtn) {
            zoomOutBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.handleBackgroundZoom({ preventDefault: () => {}, deltaY: 1 });
            });
        }
        
        // 左移
        const moveLeftBtn = document.getElementById('crop-move-left');
        if (moveLeftBtn) {
            moveLeftBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.backgroundPanX -= 10;
                this.updateBackgroundTransform();
            });
        }
        
        // 右移
        const moveRightBtn = document.getElementById('crop-move-right');
        if (moveRightBtn) {
            moveRightBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.backgroundPanX += 10;
                this.updateBackgroundTransform();
            });
        }
        
        // 上移
        const moveUpBtn = document.getElementById('crop-move-up');
        if (moveUpBtn) {
            moveUpBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.backgroundPanY -= 10;
                this.updateBackgroundTransform();
            });
        }
        
        // 下移
        const moveDownBtn = document.getElementById('crop-move-down');
        if (moveDownBtn) {
            moveDownBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.backgroundPanY += 10;
                this.updateBackgroundTransform();
            });
        }
        
        // 完成按钮
        const doneBtn = document.getElementById('crop-done-btn');
        if (doneBtn) {
            doneBtn.addEventListener('click', (e) => {
                e.preventDefault();
                // 完成裁剪并应用抖动
                this.finishCrop(() => {
                    // 调用抖动处理函数
                    if (typeof convertDithering === 'function') {
                        convertDithering();
                    } else if (typeof applyDither === 'function') {
                        applyDither();
                    }
                });
            });
        }
        
        // 取消按钮
        const cancelBtn = document.getElementById('crop-cancel-btn');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.cancelCrop();
            });
        }
    }
}