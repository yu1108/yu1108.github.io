class CropManager {
  constructor(canvas, ctx) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.backgroundZoom = 1;
    this.backgroundPanX = 0;
    this.backgroundPanY = 0;
    this.isPanning = false;
    this.lastPanX = 0;
    this.lastPanY = 0;
    this.lastTouchDistance = 0;
    this.originalImage = null;  // 保存原始图片
    this.currentRotation = 0;  // 当前旋转角度

    // Bind event handlers
    this.handleBackgroundZoom = this.handleBackgroundZoom.bind(this);
    this.handleBackgroundPanStart = this.handleBackgroundPanStart.bind(this);
    this.handleBackgroundPan = this.handleBackgroundPan.bind(this);
    this.handleBackgroundPanEnd = this.handleBackgroundPanEnd.bind(this);
    this.handleTouchStart = this.handleTouchStart.bind(this);
    this.handleTouchMove = this.handleTouchMove.bind(this);
  }

  resetStates() {
    this.backgroundZoom = 1;
    this.backgroundPanX = 0;
    this.backgroundPanY = 0;
    this.isPanning = false;
    this.lastPanX = 0;
    this.lastPanY = 0;
    this.lastTouchDistance = 0;
    this.currentRotation = 0;  // 重置旋转角度
  }

  isCropMode() {
    return this.canvas.parentNode.classList.contains('crop-mode');
  }

  exitCropMode() {
    this.canvas.parentNode.classList.remove('crop-mode');
    setCanvasTitle("");

    this.canvas.removeEventListener('wheel', this.handleBackgroundZoom);
    this.canvas.removeEventListener('mousedown', this.handleBackgroundPanStart);
    this.canvas.removeEventListener('mousemove', this.handleBackgroundPan);
    this.canvas.removeEventListener('mouseup', this.handleBackgroundPanEnd);
    this.canvas.removeEventListener('mouseleave', this.handleBackgroundPanEnd);
    this.canvas.removeEventListener('touchstart', this.handleTouchStart);
    this.canvas.removeEventListener('touchmove', this.handleTouchMove);
    this.canvas.removeEventListener('touchend', this.handleBackgroundPanEnd);
    this.canvas.removeEventListener('touchcancel', this.handleBackgroundPanEnd);
  }

  initializeCrop() {
    const imageFile = document.getElementById('imageFile');
    if (imageFile.files.length == 0) {
      fillCanvas('white');
      return;
    }

    this.exitCropMode();
    this.resetStates();

    // 保存原始图片并重置旋转角度
    this.originalImage = new Image();
    this.originalImage.onload = () => {
      this.canvas.style.backgroundImage = `url(${URL.createObjectURL(imageFile.files[0])})`;
      this.currentRotation = 0;
      document.getElementById('rotate-angle').value = 0;
    };
    this.originalImage.src = URL.createObjectURL(imageFile.files[0]);

    this.canvas.style.backgroundSize = '100%';
    this.canvas.style.backgroundPosition = '';
    this.canvas.style.backgroundRepeat = 'no-repeat';

    // add event listeners for zoom and pan
    this.canvas.addEventListener('wheel', this.handleBackgroundZoom);
    this.canvas.addEventListener('mousedown', this.handleBackgroundPanStart);
    this.canvas.addEventListener('mousemove', this.handleBackgroundPan);
    this.canvas.addEventListener('mouseup', this.handleBackgroundPanEnd);
    this.canvas.addEventListener('mouseleave', this.handleBackgroundPanEnd);

    // Touch events for mobile devices
    this.canvas.addEventListener('touchstart', this.handleTouchStart);
    this.canvas.addEventListener('touchmove', this.handleTouchMove);
    this.canvas.addEventListener('touchend', this.handleBackgroundPanEnd);
    this.canvas.addEventListener('touchcancel', this.handleBackgroundPanEnd);

    // Make the canvas transparent
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    setCanvasTitle("裁剪模式: 可用鼠标滚轮或双指触摸缩放图片");
    this.canvas.parentNode.classList.add('crop-mode');
  }

  finishCrop(callback) {
    if (!this.originalImage) return;

    // 使用 originalImage（包含旋转后的图片），而不是从原始文件重新创建
    const image = this.originalImage;

    const fieldsetRect = this.canvas.getBoundingClientRect();
    const scale = (image.width / fieldsetRect.width) / this.backgroundZoom;

    const sx = -this.backgroundPanX * scale;
    const sy = -this.backgroundPanY * scale;
    const sWidth = fieldsetRect.width * scale;
    const sHeight = fieldsetRect.height * scale;

    fillCanvas('white');
    this.ctx.drawImage(image, sx, sy, sWidth, sHeight, 0, 0, this.canvas.width, this.canvas.height);

    this.exitCropMode();
    if (callback) callback();
  }

  handleTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      this.handleBackgroundPanStart(e.touches[0]);
    } else if (e.touches.length === 2) {
      this.isPanning = false; // Stop panning when zooming
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
        this.backgroundZoom = Math.max(0.1, Math.min(5, this.backgroundZoom)); // Limit zoom range
        this.updateBackgroundTransform();
      }
      this.lastTouchDistance = newDist;
    }
  }

  handleBackgroundZoom(e) {
    e.preventDefault();
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    this.backgroundZoom *= zoomFactor;
    this.backgroundZoom = Math.max(0.1, Math.min(5, this.backgroundZoom)); // Limit zoom range
    this.updateBackgroundTransform();
  }

  handleBackgroundPanStart(e) {
    this.isPanning = true;
    this.lastPanX = e.clientX;
    this.lastPanY = e.clientY;
    this.canvas.style.cursor = 'grabbing';
  }

  handleBackgroundPan(e) {
    if (this.isPanning) {
      const deltaX = e.clientX - this.lastPanX;
      const deltaY = e.clientY - this.lastPanY;
      this.backgroundPanX += deltaX;
      this.backgroundPanY += deltaY;
      this.lastPanX = e.clientX;
      this.lastPanY = e.clientY;
      this.updateBackgroundTransform();
    }
  }

  handleBackgroundPanEnd() {
    this.isPanning = false;
    this.lastTouchDistance = 0; // Reset touch distance
    this.canvas.style.cursor = 'grab';
  }

  updateBackgroundTransform() {
    this.canvas.style.backgroundSize = `${100 * this.backgroundZoom}%`;
    this.canvas.style.backgroundPosition = `${this.backgroundPanX}px ${this.backgroundPanY}px`;
  }

  getTouchDistance(touches) {
    const touch1 = touches[0];
    const touch2 = touches[1];
    return Math.sqrt(
      Math.pow(touch2.clientX - touch1.clientX, 2) +
      Math.pow(touch2.clientY - touch1.clientY, 2)
    );
  }

  initCropTools() {
    document.getElementById('crop-zoom-in').addEventListener('click', (e) => {
      e.preventDefault();
      this.handleBackgroundZoom({ preventDefault: () => { }, deltaY: -1 });
    });

    document.getElementById('crop-zoom-out').addEventListener('click', (e) => {
      e.preventDefault();
      this.handleBackgroundZoom({ preventDefault: () => { }, deltaY: 1 });
    });

    document.getElementById('crop-move-left').addEventListener('click', (e) => {
      e.preventDefault();
      this.backgroundPanX -= 10;
      this.updateBackgroundTransform();
    });

    document.getElementById('crop-move-right').addEventListener('click', (e) => {
      e.preventDefault();
      this.backgroundPanX += 10;
      this.updateBackgroundTransform();
    });

    document.getElementById('crop-move-up').addEventListener('click', (e) => {
      e.preventDefault();
      this.backgroundPanY -= 10;
      this.updateBackgroundTransform();
    });

    document.getElementById('crop-move-down').addEventListener('click', (e) => {
      e.preventDefault();
      this.backgroundPanY += 10;
      this.updateBackgroundTransform();
    });

    // 旋转按钮事件
    document.getElementById('crop-rotate-left').addEventListener('click', (e) => {
      e.preventDefault();
      // 左旋90度按钮由HTML onclick直接调用 rotateImage(-90)
    });

    document.getElementById('crop-rotate-right').addEventListener('click', (e) => {
      e.preventDefault();
      // 右旋90度按钮由HTML onclick直接调用 rotateImage(90)
    });
  }

  // 旋转图片（指定角度）
  rotateImage(angle) {
    if (!this.originalImage) {
      alert('请先导入图片！');
      return;
    }

    this.currentRotation = (this.currentRotation + angle) % 360;
    if (this.currentRotation < 0) this.currentRotation += 360;

    document.getElementById('rotate-angle').value = this.currentRotation;
    this.drawRotatedImage();
  }

  // 旋转图片（自定义角度）
  rotateImageCustom() {
    if (!this.originalImage) {
      alert('请先导入图片！');
      return;
    }

    const angleInput = document.getElementById('rotate-angle');
    const angle = parseInt(angleInput.value) || 0;

    if (angle < 0 || angle > 360) {
      alert('请输入0-360之间的角度！');
      return;
    }

    this.currentRotation = angle;
    this.drawRotatedImage();
  }

  // 绘制旋转后的图片
  drawRotatedImage() {
    if (!this.originalImage) return;

    // 创建临时画布进行旋转
    const tempCanvas = document.createElement('canvas');
    const tempCtx = tempCanvas.getContext('2d');

    // 计算旋转后的尺寸
    const radians = this.currentRotation * Math.PI / 180;
    const sin = Math.abs(Math.sin(radians));
    const cos = Math.abs(Math.cos(radians));
    const width = this.originalImage.width;
    const height = this.originalImage.height;

    const newWidth = Math.ceil(width * cos + height * sin);
    const newHeight = Math.ceil(width * sin + height * cos);

    tempCanvas.width = newWidth;
    tempCanvas.height = newHeight;

    // 旋转图片
    tempCtx.translate(newWidth / 2, newHeight / 2);
    tempCtx.rotate(radians);
    tempCtx.drawImage(this.originalImage, -width / 2, -height / 2);

    // 更新背景图片（用于显示）
    const rotatedUrl = tempCanvas.toDataURL('image/png');
    this.canvas.style.backgroundImage = `url(${rotatedUrl})`;
    this.canvas.style.backgroundSize = `${Math.round(newWidth / this.originalImage.width * 100)}%`;
    this.canvas.style.backgroundPosition = 'center';

    // 更新 originalImage（用于后续处理）
    const rotatedImage = new Image();
    rotatedImage.onload = () => {
      this.originalImage = rotatedImage;
      // 重置缩放和平移，因为旋转后图片尺寸已改变
      this.backgroundZoom = 1;
      this.backgroundPanX = 0;
      this.backgroundPanY = 0;
      this.updateBackgroundTransform();
    };
    rotatedImage.src = rotatedUrl;

    addLog(`图片已旋转 ${this.currentRotation}°`);
  }
}